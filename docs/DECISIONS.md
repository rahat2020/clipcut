# Decisions

Why the project looks the way it does. When a decision changes, edit its entry and
note the date — don't just delete it.

Constraints behind almost everything below:
- **$0/month and no credit card** — rules out Oracle Cloud, Railway, Fly.io, Koyeb.
- **Laptop:** i5-1135G7 (4 cores, 15 W), 16 GB RAM, no discrete GPU.
- **C: SSD has ~15–20 GB free.** D: and E: HDDs have 400+ GB free.
- **Internet ~500 KB/s**, occasionally stalls.

---

## Product

**D1. Niche: Bangla-first.** OpusClip, Vizard, Klap etc. are funded and English-first;
competing on generic English clipping is a loss. Bangladeshi creators are unserved:
competitors render Bangla badly, don't do Banglish, and cost ~৳3,500/month. Target
price ৳200–500/month is possible because our marginal cost is near zero.

**D2. Differentiator: clip selection accuracy.** Competitors built chunk-based
pipelines in 2023 when context windows were small. Gemini's 1M-token context lets us
send the whole transcript at once, so the model sees stories that span the video,
hooks said far from the clip, and avoids picking five clips with the same point.
Boundary snapping (code, not AI) fixes most "bad clip" complaints. An eval set lets us
measure prompt changes instead of guessing.

**D3. MVP scope.** Upload (≤100 MB) or YouTube URL → transcript → AI clips → burned
captions → 9:16 center crop → download. Deferred: face tracking, transcript editor,
1:1/16:9 by default, filler removal, brand kit, publishing.

## Architecture

**D4. Two projects, one git repo, no monorepo tooling.** `web/` and `worker/` each have
their own `package.json`. Rahat isn't used to workspaces; the only real sharing is
Mongoose models and API types, which a small copy script handles (Step 2).

**D5. API lives in Next.js route handlers, not Express.** Vercel's free tier hosts it
for $0. Every API call is short (create a record, sign an upload, enqueue a job).
Trade-offs: no SSE (Vercel cuts long connections) → polling every 2 s; no yt-dlp on
Vercel → YouTube pre-validation uses the keyless oEmbed endpoint, duration is checked
by the worker.

**D6. Worker on Hugging Face Spaces.** Free CPU Space: 2 vCPU, 16 GB RAM, Docker, no
card. It builds our Dockerfile on its servers, so no local Docker is needed. Caveats:
sleeps when idle, restarts occasionally, shared CPU. BullMQ retries + idempotent steps
cover restarts. Move to a ~€15/month VPS once there's revenue — same image.

**D7. The worker makes only outbound connections** (Redis, Mongo, Cloudinary, Groq,
Gemini). It needs no public URL, so it can run anywhere.

## AI & media

**D8. Transcription: Groq `whisper-large-v3` API**, not local Whisper. Local
`large-v3` on this CPU runs ~0.3× realtime (a 10-minute video takes 30+ minutes);
smaller models are poor at Bangla. Groq gives the best Whisper model, word
timestamps, fast, free tier. Audio leaves our servers → must be in the privacy
policy. Behind a `TranscriptionProvider` interface so local Whisper can return.

**D9. Clip AI: Gemini 2.5 Flash, Groq LLM fallback.** Both free without a card.
Gemini's 1M context removes transcript chunking entirely. Behind an `LLMProvider`
interface. Never create multiple accounts to stretch free tiers — linked-account bans
would kill production.

**D10. No face tracking in MVP.** Reframing is table stakes, not our differentiator.
Center crop + a user-adjustable horizontal offset covers most talking-head videos and
removes Python/MediaPipe/OpenCV entirely.

**D11. FFmpeg via our own `execFile` wrapper.** fluent-ffmpeg is unmaintained, hides
arguments, and can't express `sendcmd`. `execFile` with an argument array has no shell,
so no command injection.

**D12. Bangla captions use the `ass` filter with `shaping=complex`** (verified
2026-09-28). The `subtitles` filter falls back to simple shaping and breaks conjuncts
and vowel-sign placement silently.

## Infrastructure

**D13. Cloud MongoDB and Redis in development too — no Docker, no WSL2.** Docker
Desktop + WSL2 would put ~7–8 GB on the nearly-full C: SSD. Using Atlas M0 and Redis
Cloud free in dev also means dev matches production exactly. Cost: internet is
required and each DB call has ~100–200 ms latency.

**D14. Redis eviction policy must be `noeviction`.** Otherwise Redis silently drops
BullMQ jobs when full.

**D15. MongoDB is the source of truth for job status.** Redis Cloud free has no
persistence. On startup the worker finds videos stuck in `processing` and re-enqueues.

**D16. Auth: Clerk.** Saves ~4 days of security-sensitive work (verification,
reset, token rotation, brute-force protection); free to 10,000 users. We keep our own
`users` collection keyed by `clerkId` holding plan/quota, so leaving Clerk later only
touches identity.

## Tooling

**D17. npm, dayjs, no Turborepo** — Rahat's preference; fewer tools to learn.

**D18. Latest stable majors (2026-09-28):** Next 16, React 19, Mongoose 9, BullMQ 6,
zod 4, Tailwind 4. **TypeScript pinned to 5** — TS 7 is the new Go compiler and
Next.js/ESLint tooling isn't fully compatible yet.

**D19. Worker runs TypeScript through `tsx` in dev and production**, with
`tsc --noEmit` for type checking. No build step, no `.js`-extension import rules.

## Data & admin (2026-09-28)

**D20. Schema design in `docs/SCHEMA.md`.** Integer milliseconds for media times;
`userId` on every document; targeted `$set` updates only (safe while web and worker run
different versions); `schemaVersion` + expand–contract + a migration runner for changes;
big blobs in Cloudinary because Atlas free is 0.5 GB and 100 ops/sec.

**D21. Workspaces/teams later.** All ownership checks go through one `ownedBy()` helper
so switching to `workspaceId` later changes one function plus a backfill migration.

**D22. Shared models via root `shared/` + copy script**, not an npm `file:` link — a
linked package can load a second Mongoose instance and queries hang silently.

**D23. Free-plan retention: source video and clips both 7 days**, on one clock per video
starting when processing ends. After that the video is archived (text kept, media gone).
Editable per plan in the admin panel and **applies to old and new videos**: expiry is
computed from current settings, never stored. Safety nets: impact preview + typed
confirmation, and a grace period (default 24 h, can be 0) so shortening never deletes
files instantly. Lengthening can't restore files already deleted.

**D24. `analysis_runs` + clip feedback in the MVP** — provenance (model, prompt version)
and accept/reject signals are how clip accuracy gets measured.

**D25. Admin panel inside `web/` at `/admin`.** Tunable behaviour (AI models, caps,
limits, retention, kill switches) lives in a `settings` collection, cached 60 s; secrets
stay in env and are never shown. First admin comes from `ADMIN_EMAILS`. Every admin action
is audited. No raw database editor — purpose-built actions only. Spec: `docs/ADMIN.md`.
The YouTube kill switch moves from an env var to `settings.system.youtubeEnabled`.

**D26. Global Mongoose safety: `strictQuery: "throw"` + `runValidators: true`.** With
`strictQuery: true` a typo in a filter is silently dropped, so `deleteMany({ typo: x })`
deletes everything; `"throw"` makes it an error. `runValidators` makes integer-ms, enum
and range validators apply to `updateOne` too — we only use targeted updates.

**D27. LLM fallback is Groq `openai/gpt-oss-120b`** (131k context). The planned
llama-3.3-70b is no longer served by Groq (checked 2026-09-28). Admin-editable.

**D28. Clerk → our `users` collection by lazy sync, not a webhook.** On a signed-in
request we read our user by `clerkId`; if missing or last synced > 15 min ago we fetch the
Clerk profile once and upsert (email, name, avatar, `lastSeenAt`, ADMIN_EMAILS promotion).
A webhook would need a public URL in dev and a signing secret, and still needs this path
for users created before it existed. Cost: at most one Clerk API call and one write per
user per 15 min. Revisit if we need to react to Clerk deletions instantly.

**D29. `/admin` answers 404 to non-admins; `proxy.ts` only checks "signed in".** The role
lives in our database, which the proxy doesn't read (it would cost a DB call on every
request). The real check is `requireAdmin()` / `requireAdminPage()` in every admin page,
layout, route handler and server action. 404 instead of 403 doesn't advertise the panel.

**D30. Clerk Core 3 (`@clerk/nextjs` 7).** `<SignedIn>/<SignedOut>/<Protect>` are gone —
use `<Show when="signed-in">`. `<ClerkProvider>` goes inside `<body>`. Sign-in/up URLs are
passed in code (`ROUTES`, `proxy.ts` options), not `NEXT_PUBLIC_CLERK_*` env vars.

**D31. UI design "Cutroom" + shadcn/ui on Base UI.** Dark-first editing-suite look with one
lime accent (`#c8f169`), Bricolage Grotesque / Geist / Geist Mono, Hind Siliguri as the
Bangla fallback. Chose one strong accent over a violet–pink gradient: gradients read as
generic AI-tool styling and compete with the video. shadcn's current default base is Base
UI (compose with `render`, not `asChild`); its `cn` helper now comes from the `cn` package
(shadcn-ui/cn). Dark only for now. Spec and mockup link: `docs/DESIGN.md`.

**D32. UI copy is English everywhere** (Rahat, 2026-09-28), including mock/sample content.
Bangla shows up only as the spoken-language option and in users' own content, which is
rendered with `lang` so the Bangla font and line-height apply.

**D33. Monthly quota = one calendar month from `quota.periodStart`** (Jan 31 → Feb 28,
UTC). A finished period counts as 0 minutes immediately (`minutesUsedThisPeriod`); the
stored counter is rolled over when usage is next charged (worker, transcription). Minutes
are charged at transcription (`usage_events`), not at upload — upload only checks that
enough minutes are left, rounded up per video (`billableMinutes`).

**D34. Source uploads: signed, chunked, private, verified.** The browser uploads straight
to Cloudinary (Vercel functions can't take 100 MB bodies) in 6 MB chunks with per-chunk
retries. The signature pins `public_id = <folder>/sources/<userId>/<videoId>` and
`type: authenticated`, so a user can't write elsewhere or make the file public; playback
and thumbnails use signed URLs. On finalize the server ignores the browser's numbers and
re-checks size, length and audio with the Admin API (`media_metadata: true`); a rejected
file is deleted. The video id is allocated when the ticket is issued, so finalizing twice
returns the same video. Uploads that are never finalized are orphans — the Step 17 cleanup
job deletes source files with no video after 24 h.

**D35. web/ never enqueues; the worker's dispatcher moves MongoDB → BullMQ.** web/ only
writes `status: "queued"`. Every 5 s the worker gives each queued video a run id (guarded
update) and adds job `<videoId>-<runId>` (adding it twice is a no-op). Why: one enqueue
path instead of two; no "saved to Mongo but the Redis write failed" gap; Redis Cloud free
has no persistence, so a wiped queue is rebuilt on the next pass; no BullMQ in the Vercel
bundle and fewer Redis connections (free tier: 30). Cost: up to ~5 s before a job starts,
and one indexed Mongo query every 5 s (0.2 ops/s of the 100 ops/s budget).
Stuck runs: heartbeat every 30 s; silent for 2 min → back to `queued` under a new run id
(finished stages kept), at most 3 times, then `failed` (PROCESSING_STALLED, user can retry).
Stages not built yet stop the run with STAGE_NOT_READY (dev only; gone after Step 12).

**D36. Ingest: YouTube sources are not stored; audio is.** web/ checks a YouTube link with
oEmbed only (fast, no key); the worker asks yt-dlp for the length, live state and
availability **before** downloading, then downloads ≤720p (H.264, ≤30 fps preferred) into
the job's scratch folder. The YouTube file is never uploaded to Cloudinary (a 720p hour
is several times Cloudinary free's 100 MB limit); the video page uses YouTube's
privacy-enhanced embed. Later stages that need the video call `ensureSource()`, which
re-downloads if the job's scratch folder doesn't have it. The extracted audio (mono 16 kHz
Opus, bitrate chosen so the file stays under Groq's 25 MB: 48 kbps up to ~66 min, never
below 16 kbps — no chunking up to 3 h) IS stored privately in Cloudinary
(`<folder>/audio/<userId>/<videoId>`), so transcription never needs the source again.
yt-dlp runs with `--js-runtimes node` (current YouTube needs a JS runtime; Node is always
there) and `--ignore-config --no-cache-dir`; the URL is rebuilt from the 11-char id.
Risk: YouTube may bot-block datacenter IPs (Hugging Face) — the `youtubeEnabled` kill
switch (D25) and the "upload the file instead" message cover it.

**D37. Transcription: Groq `whisper-large-v3`, language always given, no prompt, no turbo.**
Measured on 2 min of a real Bangla podcast (2026-09-28): v3 → readable Bangla (spelling
slips like "আনন্দো"), 192 words, 6.4 s. v3-turbo → mostly nonsense words and 55 s of speech
missing. A Bangla `prompt` added দাঁড়ি (।) but the output lost over half the words — never
trade content for punctuation. Sentence ends for clip snapping (Step 10) therefore come
from segment boundaries and pauses between word timestamps, not punctuation.
Stored: segments in MongoDB; words (`[startMs,endMs,word]`) and the untouched response in
Cloudinary as private raw JSON. Hallucinations dropped: OpenAI's silence rule (no_speech
> 0.6 AND logprob < -1 — either alone misfires: real speech had no_speech 0.64) and 3+
identical segments in a row. Groq free tier = a 7,200 audio-second bucket refilling over
an hour (≈ two 1-hour videos per hour): on 429 the job waits in place (heartbeat on,
"waiting its turn" shown) for up to 30 min instead of failing. Own daily caps in Redis
(`settings.ai.dailyCaps`). Minutes are charged once per video when transcription
succeeds: ledger row (unique `video:<id>:transcribe`) first, then the counter, rolling
the monthly period on its anniversary day.

**D38. The spoken language the user picks is checked, and corrected when clearly wrong.**
Found in testing (2026-09-29): a Bangla-titled football highlight with English commentary,
submitted as Bangla, came out as nonsense in Bengali script — forced Whisper never fails,
it transliterates. Before the full transcription the worker sends 1–2 thirty-second samples
from the middle of the audio (≈30 % and 65 %; intros are often music or English jingles)
without a language. Switch only if every sample that clearly has speech (≥5 words,
no_speech < 0.8) is the OTHER supported language; disagreement, music, or an unsupported
language (Hindi/Assamese can be how Whisper hears regional Bangla) keep the user's choice.
Stored as `videos.languageCheck`; the page says "We heard English…". Cost: ≤60 audio-seconds
and 2 requests per video. Best effort — if the check fails the video still transcribes.

**D39. Clip selection v1: the AI picks transcript LINES, code turns them into times.**
(Step 9, 2026-09-29.) The whole transcript goes to `settings.ai.clipSelection` (default
`gemini-2.5-flash`) in one call, as numbered lines `L12 [03:21-03:27] text`, and the model
answers JSON (`responseJsonSchema` / Groq strict `json_schema`): `{start_line, end_line,
reason, type, score 0–100}`. LLMs are unreliable at timestamp arithmetic; line numbers can
only point at real speech. Lines are Whisper segments split with the word timestamps at
sentence ends and pauses (≤15 s), each ending on its last word — one real segment claimed
21 s → 51 s while its words ended at 28.8 s. Code then: drops bad line numbers, joins the
next/previous line when too short (never across a >4 s gap), drops end lines when too
long (one huge line is cut at the maximum), sorts by score, drops a clip overlapping a
better one by >30 %, keeps the best N (`options.targetClipCount` ≤ plan
`maxClipsPerVideo`; the model is asked for 30 % more). Step 10 refines cuts inside lines.
Prompts are versioned (`clip-select@1`; settings pick one; wording of a released version
never changes). Every run is an `analysis_runs` row plus the prompt + raw answer in
Cloudinary (`<folder>/analysis/<userId>/<videoId>/<runId>.json`). Retry/fallback
(`services/ai/llm.ts`): busy (503/429) → retried after 4 s / 12 s or the provider's
delay if ≤30 s; unusable JSON → one retry; per-day quota, timeout or request too large →
straight to the fallback (Groq `openai/gpt-oss-120b`). Free-tier facts seen 2026-09-29:
Gemini 3.5+ Flash models often answer 503 "high demand"; 2.5-flash-lite/2.5-pro are closed
to new keys; Groq gpt-oss-120b allows 8,000 tokens/min, so the fallback only covers short
videos. Zero usable moments → `NO_MOMENTS_FOUND` (not retried).

**D40. Admin actions are server actions over plain services; AI keys optionally in web.**
(Admin catch-up, 2026-09-29.) Each admin mutation is a `"use server"` function that runs
`runAdminAction()` — admin role from our DB every time, 30 actions/min per admin (Redis),
AppError/zod → a safe message — and calls a service in `web/src/lib/admin/`, which has no
`server-only`/env/Clerk imports so `admin:smoke` tests every rule for real. Filters live in
the URL (GET forms, no client JS). "Pick clips again" doesn't run AI in web: it sets
`videos.pipeline.analyzeWith` and re-queues from analyze; the worker makes a `regenerate`
run with exactly that model (no fallback — a comparison must never silently use another
model) and old runs + clips stay for comparison. The AI models page needs live model lists
and a Test button, so web gets OPTIONAL `GEMINI_API_KEY`/`GROQ_API_KEY` (the worker still
makes every real call; the panel never shows keys); the alternative — asking the worker
through Redis — fails whenever the free Space sleeps. "Delete user data" blocks the
account first, deletes Cloudinary files by user folder prefix (catches unfinished uploads
too), then videos/transcripts/runs/clips/renders, anonymises the user row (kept so the
Clerk id stays blocked if the Clerk delete fails), deletes the Clerk user; keeps
usage_events (billing ledger) and the audit log. Lock-out rules: no one changes their own
role/status; ADMIN_EMAILS owners can't be demoted, suspended or deleted from the panel.

**D41. Boundary snapping uses the audio's loudness, not just Whisper's timestamps.**
(Step 10, 2026-09-29.) Measured first on real transcripts: ~90 % of Whisper words end
exactly where the next one starts (Whisper stretches a word over the pause after it) and
Bangla output has almost no punctuation (1 in 132 words) — so timestamp gaps and "।" can't
find sentence ends. The stored Opus audio is decoded to 8 kHz PCM on stdout (no file;
5.7 min in 0.6 s) and reduced to dB per 20 ms; quiet = noise floor (5th percentile) +
35 % of the way to speech level (90th); <12 dB contrast (music under everything) → no
quiet. Each quiet stretch ≥250 ms goes to the nearest word boundary. A boundary is
**clean** with a sentence mark, a ≥600 ms pause, or a Whisper segment end + a ≥250 ms
pause; **soft** with only one of the weaker signs. Start and end move to the cheapest
clean boundary within 6 s (dropping words costs 1.5× adding them — ending mid-thought is
the usual complaint), else soft, else stay; the words must fit max − 1.1 s so lead/tail
never break the maximum; too long → pulled back (`max_cut` if nothing clean fits). Cuts
sit at most 0.4 s before the first word and 0.7 s after the last, in the quietest 20 ms
there — a long crowd-noise gap put a cut 1.5 s early before this cap. Loudness is
measured while the model thinks and is best effort (no audio → timestamps only; no words
→ segments). Rules are code constants versioned as `snap@1` (like prompts): they change
with the eval set, not live from the admin panel. Stored per clip: `snap.{version, basis,
startRule, endRule}`; the analysis JSON keeps every shift, the line-level fit and the
rules. First real check: 8 football + 2 Bangla clips — 18 of 20 starts/ends clean, two mid-phrase
cuts fixed (a start that dropped "for", an end mid-sentence).

**D42. Bangla transcript text comes from Gemini, piece by piece; timing comes from us.**
(2026-09-30, before Step 12 — captions show this text.) On Rahat's real videos Whisper's
Bangla was mostly nonsense ("ভাগলাদেশ এই গুরুপে এখন পরজন্তো") and skipped 22 s of a drama;
Gemini wrote clean, correctly spelled Bangla, kept the dialect ("কেডা", "বাইর হন") and
names. Gemini's own timestamps aren't reliable enough to cut or caption with, so: the
audio is cut into 3–15 s pieces in the middle of pauses (loudness, D41; music with no
pause → the quietest 200 ms), one ffmpeg pass writes one small Opus file per piece, and
~10 min of pieces go to Gemini in one request as labelled audio parts ("Piece 1:", …).
Gemini answers JSON `{piece, text}` for every piece (a missing piece = unusable answer →
retried). A piece's start/end are exact because we cut it; word times inside it are
spread over its non-quiet frames by grapheme count (`transcripts.wordTiming:
"estimated"`) — enough for phrase captions and snapping, which also listen to the audio.
Prompt `transcribe-pieces@1`: verbatim, dialect kept, punctuation (। ? !), EVERY word in
Bengali script incl. English loanwords (স্ট্রাইকার) — one script reads cleanly in captions;
only acronyms/brands stay Latin (SAFF). Thinking is turned off (`thinkingLevel:
minimal` / `thinkingBudget: 0`): measured on 2.6 min, gemini-3-flash-preview thought 31k
tokens for 105 s by default vs 0 tokens and 6.7 s at minimal, same text. Models
(settings `ai.transcription.gemini`): `gemini-3-flash-preview` then `gemini-2.5-flash`
— each has its own free daily quota (2.5-flash: **20 requests/day** on 2026-09-30); a
model that failed a batch isn't tried first for the next. Every Gemini model failing →
Whisper transcribes the video instead, so it still finishes. English stays on Whisper
(good there, real word timestamps). Whisper still does the language check (D38).
Cost: 10 min of audio ≈ 19k input tokens, 1 request.
*Shift guard (same day):* `gemini-3.5-flash-lite` answered every piece but wrote the
words of ~0:44 into the 1:36 piece — captions would show at the wrong time and the "all
pieces answered" check passed. Comparing text length with speech per piece couldn't tell
right from shifted (r 0.36 right vs 0.62 shifted), and Whisper's words were too sparse to
compare against. So each batch carries silent CONTROL pieces (1.5 s, after piece 3, 9,
15, …): a control that comes back with 2+ words = shifted answer = unusable → retried, then
the next model. Checked: 3.5-flash-lite caught (2 controls got words), 3.1-flash-lite and
3-flash-preview pass. Chain now 3-flash-preview → 3.1-flash-lite → 2.5-flash.
*Batching (same day, after Rahat's 8.5-min video took 10 min 27 s in "Transcribing" at
10 %):* one 10-min request; 3-flash-preview answered 503 after 63–108 s, three times
(retried in place), then 3.1-flash-lite hit MAX_TOKENS twice (~130 s each — it sometimes
repeats itself until the limit). Now: 5-min batches, two at a time; each model gets ONE
call per round, two rounds (`attemptsPerModel: 1`); the output limit scales with the audio
(2k tokens/min, real answers use ~400); the bar moves while a batch is in flight. Same
audio: 104 s.

**D43. Every AI task has a fallback CHAIN, mostly more Gemini models.** (2026-09-30.)
Rahat: when Gemini's quota runs out, fall back to other models.
*Verified on Rahat's key that day:* Google's own 429 said `gemini-2.5-flash` = 20
requests/day (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), so quotas are per
model; `gemini-3.1-flash-lite`, `3.5-flash-lite`, `3-flash-preview`, `3.5-flash` and
`gemma-4-26b-a4b-it` answer; `2.5-flash-lite` is closed to new keys; `gemma-4-31b-it`
gave a 500. *Not verified (third-party guides found by web search, 2026-09-30):* newer
Flash models ≈ 20/day and Flash-Lite ≈ 500/day; Mistral's free "Experiment" tier (no card,
phone check, large monthly quota) and OpenRouter `:free` models (Rahat's own account
needed); Cerebras now wants a card; GitHub Models closed. Google no longer publishes
per-model free limits — the real ones for this project are at https://ai.dev/rate-limit
(the link in Google's 429). Groq is already in (8k tokens/min → short videos only). Settings: `clipSelection`/`copyWriting` `fallbacks[]` (≤5, default
3-flash-preview → 3.1-flash-lite → Groq gpt-oss-120b) replace the single `fallback`; old
stored settings are read as before (a changed `fallback` becomes a one-item chain, the old
default gets the new chain) until the next save writes `fallbacks`. `generateJson` already
moved on at a per-day 429 (noRetry). Flash-Lite clip picks are unmeasured — compare with
the eval set (Step 11); they beat failing the video.

**D44. The product is called ClipCut.** (2026-09-30, Rahat's pick.) Wordmark "Clip" +
accent "Cut"; mark = a 9:16 clip with a play button, its lower part cut off on a slant
(`components/brand/logo.tsx`, same drawing in `app/icon.svg`, `favicon.ico` 16/32/48,
`apple-icon.png` 180). The name lives in `web/src/lib/brand.ts` (page titles use a
`%s · ClipCut` template), so a rename is one line plus the wordmark. Risk noted to Rahat: close
to ByteDance's **CapCut** (also video editing) — check trademark and domains before launch.
Folder, package and repo names stay as they are. The Clerk application name (shown on
sign-in emails) is set in the Clerk dashboard.

**D45. Rendering: the pipeline renders the best 3 clips; the rest render on request.**
(2026-09-30, Rahat approved.) Encoding 1080×1920 is the most CPU the product spends, and most
users post only their top picks — so the `render` stage renders `system.render.autoRenderTop`
(3) clips while the source is still on disk, and a "Render clip" button queues the others.
- *Queue:* web/ writes a `renders` doc `status: "queued"`; the worker's render dispatcher
  enqueues it (`clip-render`, job id = render id + `queuedAt`, the D35 pattern), one render at
  a time. A claim (`queued`/`failed` → `rendering`, stamped `timings.startedAt`) guards every
  write; `timings.heartbeatAt` every 30 s; silent > 3 min → queued again, 3 attempts → failed.
  The pipeline creates its renders already claimed, so the queue never renders them twice.
- *Source for later renders:* uploads re-download the private file (≤ 100 MB); YouTube
  downloads only the clip's part (`--download-sections` + `--force-keyframes-at-cuts`,
  ±1.5 s). Checked: a 7 s section comes back 7 s.
- *YouTube 1080p* (`system.render.youtubeMaxHeight`, was 720): a 9:16 crop of 720p is 405 px
  wide, visibly soft at 1080×1920. Costs ~2.5× the download.
- *Encode:* `-ss` before `-i` (frame-accurate, clock starts at 0) → crop by expression on the
  decoded frame (rotation-safe) → lanczos scale → `fps=30` above 30 → `ass` with
  `shaping=complex` → x264 `veryfast` CRF 21, AAC 128k, faststart. ffmpeg runs in the job
  folder so the filter gets relative paths (absolute Windows paths break on `:`). A 12 s clip
  encodes in ≈ 5.6 s on the dev laptop.
- *Captions:* Hind Siliguri Bold (OFL, Bengali + Latin), `preset:bold` (96 px at 1920, white,
  black outline, 24 % from the bottom — above the Reels/Shorts buttons), phrases of ≤ 4 words /
  18 graphemes closed at sentence ends and ≥ 450 ms pauses; trailing `, । .` dropped. Phrases,
  not word-by-word highlight: Bangla word times are estimates (D42).
- *Spec hash* includes `RENDER_ENGINE_VERSION`: change the pixels → bump it → old MP4s aren't reused.
- One clip failing doesn't fail the video; only all-failed fails the stage.
- `copy` (Step 15) is a placeholder that returns `skipped`, so videos now reach `ready`.
- Files: `<folder>/renders/<userId>/<videoId>/<renderId>` (authenticated), deleted with the
  video (user delete, admin delete-all-data). Download goes through `/api/renders/:id/download`
  (sets `clips.signals.downloaded`, then redirects to a signed `fl_attachment` URL).
*Fixes after Rahat's first real test (2026-10-02):* (1) the render stage said "Skipped" on a
fresh video — analyze wrote `currentAnalysisRunId` to MongoDB but not to the job's in-memory
video, so render saw no clips (the smoke test pre-set it, so it passed). Analyze now sets it on
`ctx.video`, and render also reads it from the database. (2) A clip rendered through the queue
from a YouTube section had **no sound**; the section downloaded again later had audio, so the
cause wasn't reproduced (most likely YouTube handing over a video-only format once). Now: a
section without sound is downloaded once more, then fails with DOWNLOAD_FAILED; the encoder maps
audio as required when the source has it; every MP4 is probed before upload (sound + size), else
FFMPEG_FAILED. A silent clip can no longer become "ready". (3) Captions lower: `marginV` 0.24 →
0.16 (Rahat). `RENDER_ENGINE_VERSION` → `render@2`; renders whose spec hash differs from the
clip's current spec show as **outdated** with "Render again" (also covers Step 13's trim/framing).

**D46. Clip review edits the clip; a new MP4 is a separate, explicit render.** (Step 13,
2026-10-02.) Approve / reject (one-tap reasons → `feedback.reason`, Accuracy's top reasons),
trim in ±0.5 s steps (3 s – 3 min, inside the video), framing (Left / Center / Right + a
slider, -1…1) and caption style (Bold / Clean) all PATCH the clip (`/api/clips/:id`). Saving
doesn't re-encode by itself — "Save & render" does both — because encoding is the costly part
and a user often tweaks several things first. The render spec hash makes the old MP4
"outdated" (D45) instead of overwriting it.
- *Trims keep the AI's cut* in `edit.aiStartMs/aiEndMs` (set on the first trim, cleared when
  the user goes back to it): powers "Reset to AI cut" and is an accuracy signal — how far
  people move our edges.
- *Framing preview* is an overlay on the source player (`frameBox` mirrors the encoder's crop
  expression; checked: offset −1 keeps the same columns in the MP4). Works over the YouTube
  embed too (YouTube assumed 16:9). Shown while the framing row is hovered/focused or changed.
- Shared editor state (the preview frame) lives in the existing player context — Zustand
  isn't installed yet and one value didn't justify adding it.
- Verdicts still work after the files expire; trims / framing / renders don't (MEDIA_EXPIRED).
- Not in this step: word-accurate trim handles on a waveform, transcript text that follows a
  trim (the MP4's captions do follow it), face tracking (D10).

**D47. "Find new clips" re-runs only clip selection; approved clips are kept.** (Step 14,
2026-10-02.) The user picks another focus or describes what to find; web writes
`clipRequest: pending` and puts the video back in the queue from "Finding moments" — the same
path as the admin re-run (D40), so it gets the dispatcher, stuck-run recovery, retries and the
fallback chain for free. A separate queue would let the old clips stay usable during the
~1 min run, but meant a second copy of the claim/heartbeat/sweep machinery (D45) for little gain.
- *Which clips show:* the current run's clips + clips with `keptAt` (approved when a newer set
  replaced theirs). Rule lives in `shared/clip-sets.ts` and every user-facing clip query uses it.
  Old rows stay for Admin → Accuracy. Kept clips are read at the END of the run, so an approval
  made while the model thinks still counts.
- *No repeats:* approved clips and every clip ever rejected are "taken"; with the same focus
  (user wants others) every clip on screen is too. Taken stretches go to the model as line
  ranges (a rule added only when non-empty, so released prompt text is unchanged) and code drops
  any proposal overlapping one by > 30 % — never trust the model alone.
- *Failure is not the user's problem:* no moments → `no_moments`, clips unchanged; AI failure
  after retries → video back to Ready, stage states restored from `previousStages`, request not
  counted. A video that had no clips (first run found none) fails as before.
- *Cost:* no minutes (transcript reused); one AI request each; plan limit
  `clipRequestsPerVideo` = 3 (free), checked atomically with the state change. Retention isn't
  extended (`$min` on `retention.finishedAt`).
- *Rendering the new set:* YouTube sources aren't on disk in a later run, so the new top clips
  go to the render queue, which downloads only each clip's section; an upload is fetched once
  and rendered inline (the queue would fetch the whole file per clip — Cloudinary bandwidth).

**D48. Post text in one request per video; Banglish is per video, word for word.** (Step 15,
2026-10-02.)
- *One request for all clips:* the free tier counts requests (gemini-2.5-flash: 20/day), and
  seeing every clip lets the model avoid repeating titles. Output is cleaned in code (one line,
  length caps, hashtags normalised) — never trusted raw. The hook is always labelled AI-written.
- *Never fails a video:* post text is nice to have. AI down → stage "skipped" and the clip
  offers "Write post text". "Write again" / the Banglish switch re-queue the COPY stage only
  (rendering untouched), capped by `copyRequestsPerVideo` (10).
- *Banglish = a video setting* (`options.captionScript`) covering captions AND post text: one
  clear choice ("this video is in Banglish") instead of per-clip mixes. English videos are Latin.
- *Word for word, not a re-transcription:* Banglish captions keep the Bangla words' times, so
  the model must return one Latin word per Bangla word (counts that don't match are spread by
  share, never shifting time). Only words inside clips are spelled, stored on the transcript by
  word time (`latnWords`) — times, not positions, so another word list can't pick up wrong
  spellings. The copy stage spells all clips at once; a render asks only for words a trim added.
  Measured: Gemini wrote "Fahan ei khelate valo korte parche ekta goal diyeche." for
  "ফাহান এই খেলাতে ভালো করতে পারছে একটা গোল দিয়েছে।".
- The switch changes the render spec, so existing MP4s show "Render again" (no automatic
  re-render — that would spend render time the user may not want).

**D49. Covers: clean frames from the worker, text drawn in the browser.** (Step 15.5,
2026-10-02.) AI-generated images were ruled out (tiny free quota, invented faces = misleading).
Burning text with ffmpeg on the worker would need a round trip for every edit. Instead each
render saves 6 clean frames (~300 KB, ~3 s extra) and the browser draws the cover on a
canvas — the browser shapes Bangla correctly, edits are instant, and nothing about a cover is
stored. The words start from the AI's `cover_text`, written in the same post-text request
(`copy@2`), so covers cost no extra AI call. Image colours (yellow/white/red) live in
`lib/cover-draw.ts`: they are colours of the posted image, not UI theme colours.
YouTube Shorts mostly takes a frame from the video, so covers matter most for Reels/TikTok.
*v2 (Step 15.6, 2026-10-03):* covers looked weak on a real clip (long title as text, small
face). `copy@3` asks for three ideas with one key word each (two-colour text is the common
local thumbnail look) — still one request. "Suggest words" rewrites only the cover fields
(`coverRedoAt`), so a title the user edited isn't lost. Zoom + drag replaces face detection
(needs ML); "Punch" is a canvas filter, free. Background removal in the browser was rejected
for now: ~40 MB model per user on slow connections.

**D50. AI quota used up everywhere → the video waits, it doesn't fail.** (Step 17, 2026-10-03.)
Before: every model out of quota ended the video as `failed` and the user had to press Retry;
the message even promised "resumes tomorrow". Now `generateJson` ends with
`AI_DAILY_CAP_REACHED` + `details.resumeAt` when every real failure was a per-day quota
(Gemini `PerDay` 429 → `details.quotaDay`; Groq "per day" 429; our own daily caps), ignoring a model
that only couldn't fit the transcript (`details.tooLarge`). The processor then calls
`run.waitForQuota`: `queued` under a NEW run id (the old job id is spent), the stopped stage
`pending`, `pipeline.waitUntil` set, `pipeline.quotaWaits` +1. The dispatcher skips videos whose
`waitUntil` is in the future; claiming clears it; `markReady` and every retry reset the counter.
At most `PIPELINE_TIMING.maxQuotaWaits` = 3 waits per processing, then it fails (retryable) so
nothing waits forever. Reset time (`services/ai/reset-time.ts`): Gemini = midnight Pacific
(≈ 13:00 Bangladesh in summer, 14:00 in winter) + 2 min, our caps = midnight UTC (06:00 BD);
the earlier of the limits we saw. A mixed failure (a model busy with 503 among the quota ones)
stays `AI_UNAVAILABLE` — BullMQ retries it as before. Post text / covers / Banglish never failed a
video and still don't; "Find new clips" still keeps the old clips and says so.
Mistral (free "Experiment" plan: ~1 request/s, 1B tokens/month per model, phone check, data used
for training) was researched as the next free provider but NOT added: the key Rahat tried was
rejected (401), see PROGRESS Step 17. OpenRouter dropped by Rahat (50 free requests/day).

**D51. The cleanup job.** (Step 17, 2026-10-03.) Until now nothing deleted an expired video's files
and a user-delete whose Cloudinary call failed was never retried. The worker now runs
`cleanup/cleanup.ts` every 30 min (`CLEANUP_TIMING`): **abandoned** drafts (> 48 h) are soft-deleted;
**deleted** videos with files left get them removed; **expired** videos (shared `isExpired`, the
owner's CURRENT plan, only finished videos — a "Find new clips" run is left alone) get their files
removed and stay as an archive; **purge** removes the documents of videos deleted more than
`purgeSoftDeletedAfterDays` ago (the `usage_events` ledger stays); once a day an **orphan scan**
lists Cloudinary and removes files no live video owns. `retention.assetsDeletedAt` is set only after
Cloudinary confirmed, so every failure is retried by the next run; HTTP 420/429 stops the run.
Safeguards, because this job deletes: the orphan scan never runs on a database with no videos (a
wrong connection must not make everything an orphan — checked with `exists`, not a count), never
touches a video whose newest file is under 24 h old, deletes at most 20 videos per scan, and files by
`<folder>/<kind>/<userId>/<videoId>` can't collide (ids are 24 hex). One run at a time (Redis lock),
kill switch `settings.system.cleanupEnabled`, and `npm run cleanup:run` is a dry run by default
(`-- --apply` deletes, `-- --orphans` adds the scan). **Deploy note:** `CLOUDINARY_FOLDER` must differ
between dev and production, because the orphan scan treats every file under its folder as its own.

**D52. A video that was already charged is never refused for lack of minutes; a missing unique index stops the worker.**
(Step 17, 2026-10-06.) D33 already made the charge idempotent (ledger key `video:<id>:transcribe`, unique
index), so a retried job, user Retry or admin re-run can't charge twice. The check was the other way round:
`retryVideo` (web) and the `ingest` stage (worker, on a re-run) re-ran the "minutes left?" rule against the
user's total, which already contained this video's minutes — a user at 195/200 whose 10-minute video was charged
and then failed in analyze was told `QUOTA_EXCEEDED` and couldn't finish a video they had paid for. Now
`videoWasCharged(videoId)` (shared/usage.ts) is consulted and the minutes-left part is skipped
(`assertUploadAllowed({alreadyCharged})`, `assertLengthAllowed(…, alreadyCharged)`); the plan's maximum
LENGTH still applies. The test of the double-charge rule also showed that it depends on the unique index
existing: production never builds indexes by itself (`autoIndex` off, `npm run db:indexes` by hand), so a
forgotten step would have let retries charge twice without any error. The worker now calls
`assertUniqueIndexes()` at boot in production (every unique index of every schema must exist) and refuses
to start with "run npm run db:indexes". **Step 18 checklist: run `npm run db:indexes` and `npm run migrate`
against the production database before the first worker start.**

**D53. Backups, per-user rate limits, error pages.** (Step 17, 2026-10-06.)
*Backups.* Atlas M0 has no backups. `lib/backup.ts` writes the whole database to ONE gzip file of JSON
lines in Extended JSON (ObjectIds, Dates and numbers keep their types; plain JSON would not), with a header
and a closing line carrying the document counts — a file cut short or with missing documents is refused
before anything is written. `npm run db:backup` (to `D:\backups`, newest 14 kept; `-- --cloud` also uploads),
`npm run db:restore -- <file> --into <db>` (never into the live database unless `--replace-live`; refuses a
database that already has documents unless `--drop`; `--cloud latest` pulls the newest from Cloudinary).
In production the worker makes one backup a day by itself: checks every 3 h, backs up when the last good
one is older than 20 h, uploads to private raw `<folder>/backups/<db>/` in Cloudinary and keeps the newest 7;
the result (or the error, logged loudly) is in Redis `backup:last` for the admin dashboard (Step 16);
kill switch `settings.system.backupEnabled`. Cloudinary facts found by testing: its normal delivery link
refuses a .gz ("401 Untrusted File Access") — downloads use the API-signed `private_download_url`; the free
plan refuses raw files over ~10 MB, so a bigger backup is reported as a clear error (move backups elsewhere
or upgrade then). Verified on the real database: 87 documents backed up, restored into a new database,
every document compared — identical. Deleted users' data stays in backups until they rotate out (7 days).
*Rate limits.* `lib/rate-limit-core.ts` holds one table of per-user, per-kind limits (polling 300/min,
edits 90/min, uploads 30/h, retries 10 per 10 min, renders 40 per 10 min, AI requests 20 per 10 min,
downloads 120 per 10 min) and every API route takes its bucket with `limitUser`; the refusal is
`RATE_LIMITED` with "try again in N seconds". Redis down → allowed (availability beats strictness).
*Error pages.* `error.tsx` (inside the app shell, and a plain one for the rest), `global-error.tsx`
(root layout failed) and a branded `not-found.tsx`; they show a short message, "Try again", "Go to Home"
and Next's `digest` as a reference — never the error. Four processing error messages now say what to
do next (`DOWNLOAD_FAILED`, `TRANSCRIPTION_FAILED`, `FFMPEG_FAILED`, `MEDIA_EXPIRED`).

**D54. Admin settings pages: preview before anything that deletes, guards on the server.** (Step 16, 2026-10-06.)
Limits, retention and system are edited as whole groups with the version they were loaded at (stale → refused), like
the AI page. Rules that live in `lib/admin/settings-service.ts`, not in the browser: a plan with users on it can't be
removed and new plan names are plain lower-case words; a retention change is *previewed on the real videos* first
(`retention-impact.ts`, pure) and, when it deletes sooner, saving needs the new value typed — the server recomputes the
preview and refuses a wrong or missing confirmation, so a stale browser tab can't skip it. The impact compares each
video's deletion date before and after, treating an already-overdue video as "due now" on both sides (otherwise a video
that was overdue and stays due would read as "kept longer"); the grace period is shown as the earliest deletion time.
Per-video expiry is an override date ("keep N more days from today") — only while the files exist. The System page
shows facts and never runs anything (migrations stay `npm run migrate`; no raw editor, ADMIN.md §3). The dashboard's
Cloudinary number comes from its usage API (cached 10 min), MongoDB's from `dbStats` (data + indexes against 512 MB).

**D55. Captions that look made, without word-by-word timing: key words in colour, a hook, auto zoom.** (2026-10-07,
render@3, copy@4.) Rahat asked for the "wow" features seen in Choppity. Word-by-word highlighting was measured first:
on 4 min of English with Whisper's real word times as the truth, our D42 estimate (graphemes spread over speech
frames, per 3–15 s piece) puts word starts a median 240 ms / p90 730 ms off, and the right word would be lit only
**36 %** of the time; snapping to loudness dips and a DP alignment didn't help (35–36 %). So nothing is lit word by
word. Instead, all phrase-level (±0.3 s is invisible there):
*Key words* — copy@4 asks, in the SAME request as the post text (no extra AI call), for 3–6 key words copied from what
is said; the copy stage keeps only words really said in the clip (`cleanEmphasis`; Bangla endings allowed:
"ফাহান" matches "ফাহানের"). Words under 3 characters without a digit are dropped ("না" came back once, 2026-10-08). Stored as `clip.copy.emphasis`, part of the render spec. Matched on the ORIGINAL words
before a Banglish switch and carried by word times, so Banglish captions colour the same words. Without key words
(clips written before copy@4) numbers are emphasised. Colour only — a size change inside the line cut the pop animation.
*Hook* — the first ≤ 2 phrases starting in the first 2 s: 1.3× size with a bounce (style flag `hook`).
*Styles* — Bold and Clean gain a yellow key-word colour; new Pop (big, 3 words, green), Fire (yellow, red key words),
Minimal (small, no colour, no animation).
*Auto zoom* — a 1.12→1 punch-in over the first 0.5 s, and a 1.08 push (0.25 s ramps) on lines with a key word: not in
the first 2.5 s, ≥ 4 s apart, at most one per 5 s of clip. ffmpeg: per-frame `scale` (eval=frame) of the cropped
source, then a fixed `crop` centred at 42 % of the height (where a face usually is) — one scale like before:
+7–9 % encode time on a 20 s clip, more on very short clips (8 s: 2.4 → 3.2 s). Checked by PSNR in render:smoke
(zoomed at the start and on the key line, identical in between). On per clip unless switched off (`edit.autoZoom`).
`RENDER_ENGINE_VERSION` render@3 (older render specs have no emphasis/zoom and re-render as they were).
