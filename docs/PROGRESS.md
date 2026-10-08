# Progress

Update this file at the end of every step. Newest status at the top of each section.

## Current step

**Next: Step 18 — Deploy** (Vercel + Hugging Face Spaces; rotate every key first). Steps 16 (admin completion) and 17 (hardening) are done. Steps 12–15.6 are done (render D45, clip review D46, Find new clips D47, post text + Banglish D48, covers D49 + v2).
Step 8 (small eval set) + Step 11 (prompt iteration) wait until Rahat has the eval videos. UI polish items collect in docs/DESIGN.md ("UI polish backlog").

## Roadmap

| # | Step | Status |
|---|---|---|
| 0 | Environment setup (FFmpeg, yt-dlp, accounts, Bangla font test) | ✅ Done 2026-09-28 |
| 1 | Project skeleton: `web/` + `worker/`, env validation, service check, docs | ✅ Done 2026-09-28 |
| 2 | MongoDB models + settings + audit log + shared-code sync + migrations runner | ✅ Done 2026-09-28 |
| 3 | Clerk auth in `web/` + admin bootstrap (`ADMIN_EMAILS`, `/admin` shell) | ✅ Done 2026-09-28 |
| 3.5 | UI design ("Cutroom") + shadcn/ui foundation: theme, fonts, app shell, landing, dashboard layout, admin | ✅ Done 2026-09-28 |
| 4 | Cloudinary signed upload (100 MB) + video page, My videos, delete | ✅ Done 2026-09-28 |
| 5 | BullMQ queue + worker skeleton + progress polling + stuck-job recovery | ✅ Done 2026-09-28 |
| 6 | Ingest: YouTube/URL validation, download, ffprobe, audio extract | ✅ Done 2026-09-28 |
| 7 | Transcription via Groq Whisper (word timestamps, `bn` + `en`) | ✅ Done 2026-09-28 |
| 8 | Eval set: a few Bangla + English videos with hand-labelled best moments (Rahat: fewer than 10 to start) — needed before Step 11 | ⏸ Postponed |
| 9 | Clip selection v1 — Gemini, whole transcript in one call | ✅ Done 2026-09-29 ⭐ |
| 10 | Boundary snapping (sentence ends, silences, 15–90 s) | ✅ Done 2026-09-29 ⭐ |
| 11 | Prompt iteration against the eval set (Accuracy page built 2026-09-30; eval scores still to come) | ⬜ ⭐ |
| 12 | Render: cut + ASS captions (`shaping=complex`) + center crop | ✅ Done 2026-09-30 |
| 13 | Clip UI: preview, reason, reject, trim, crop offset | ✅ Done 2026-10-02 |
| 14 | Intent selector + regenerate ("Find new clips") | ✅ Done 2026-10-02 |
| 15 | Titles / hooks / hashtags + Banglish transliteration | ✅ Done 2026-10-02 |
| 15.5 | Clip covers (thumbnails): clean frames + AI cover text + browser editor | ✅ Done 2026-10-02 |
| 15.6 | Cover v2: 3 AI cover ideas + key word in a 2nd colour, zoom/move, Punch, Baloo Da 2 | ✅ Done 2026-10-03 |
| 9½ | Admin catch-up: Videos & jobs, AI models, Users (pulled forward) | ✅ Done 2026-09-29 |
| 16 | Admin panel completion: storage card, limits & plans, retention, system, audit viewer | ✅ Done 2026-10-06 |
| 17 | Hardening: quotas, cleanup job, backups, error states | ✅ Done 2026-10-06 (Mistral provider left open: needs a working key) |
| 18 | Deploy: Vercel + Hugging Face Spaces (rotate all keys first) | ⬜ |

⭐ = the product's core; spend the most time here.

## Step log

### "Wow" captions + auto zoom ✅ (2026-10-07, D55) — after Rahat's Choppity comparison

- Measured first: word-by-word highlighting isn't possible with our Bangla word times (right word lit 36 % of the time;
  `worker/.scratch/research/measure-timing.ts`). Built the phrase-level version instead: AI key words in a second
  colour (copy@4, same request), a bigger bouncing hook for the first 2 s, three new styles (Pop, Fire, Minimal) and
  auto zoom (punch-in + pushes on key lines), on by default with a switch in the clip's Captions tab.
- Code: `shared` caption-styles (highlightColour, hook, CAPTION_LOOK), post-copy (`emphasisToken`, `isEmphasisWord`,
  `cleanEmphasis`), render spec (`emphasis`, `autoZoom`, render@3), clip/render models; worker
  `services/render/captions.ts` (`emphasisKeys`, colour tags, hook), new `services/render/zoom.ts`, encode, produce,
  render stage + processor (key words decided before Banglish), copy prompt copy@4 + copy stage; web clip edit
  (`autoZoom`), clip view, style notes + zoom switch in `clip-review.tsx`.
- **Verified:** render:smoke 20/20 (+5: key words incl. Bangla endings and Banglish, colour/hook ASS, zoom plan +
  expression values, spec/hash, real encode with zoom checked by PSNR), copy:smoke 12/12 (+1; real Gemini gave
  "ফাহান গোল হাঙ্গার" / "সাফে ফোকাস মন খারাপ" for the two test clips), review:smoke 16/16, typecheck + lint clean.
  Frames looked at: Bangla conjuncts correct, colours where expected.
- **Rahat:** Admin → AI models → Copy writing → prompt `copy@4` (his saved settings say copy@3, so the new default
  doesn't apply), restart the worker. Old clips get key words when their post text is written again; until then
  numbers are coloured. NOT yet seen on a real talking-head video — the zoom centre (42 % height) is a guess to check.
- **Rahat's test (2026-10-08, video 6ac73bb5…, copy@4 on):** all 6 clips got key words; clip 1's render shows "মেসির" /
  "মাসিয়ায়" in yellow, the bigger hook and the opening punch-in (frames checked). One clip's key words held "না",
  which would colour every "না" → `cleanEmphasis` / `isEmphasisWord` now drop words under 3 characters without a digit
  (also guards key words already stored). copy:smoke 12/12, render:smoke 20/20.


### Step 16 — Admin panel completion ✅ (2026-10-06, D54)

- **Limits & plans** (`/admin/limits`): every plan's limits as a form, add a plan (copy of the default), remove one only
  when no user is on it; the default plan stays. **Retention** (`/admin/retention`): days per plan, grace hours, purge
  days; "Review & save" first shows the impact on the real videos (how many are deleted sooner / kept longer, earliest
  date, users affected, records purged) and a change that deletes sooner needs the new value typed — checked on the
  server too; list of files going in the next 24 h (overdue ones marked "Due now"). **System** (`/admin/system`):
  maintenance, uploads, YouTube, sign-ups, processing, worker concurrency, cleanup, backup, render settings; below,
  read-only database size, collections (documents, size, indexes), migrations and the last backup. **Audit log**
  (`/admin/audit`): filter by admin, action or group ("video."), record type and id; "Show change" = before/after.
  **Overview**: Storage & backups cards (MongoDB used / 512 MB, Cloudinary credits / 25, last backup with failed / old
  warnings) and "N waiting for AI quota". **Video page**: "Files" panel — keep this video's files N more days, or back
  to the plan's rule. Sidebar: all nine sections are live.
- Code: `web/src/lib/admin/` settings-service (limits, system, retention preview + save, expiring list, per-video
  expiry), retention-impact (pure), system-info + system-types, audit-service; server actions in
  `app/admin/settings/actions.ts`; forms in `components/admin/` (limits, retention, system, expiry, health-cards,
  form-parts). Shared: `LastBackup` type, `stampRetentionChange` exported, `migrations/status.ts` (the worker's
  `migrationStatus` moved there so the System page shows the same thing).
- **Verified:** `admin:smoke` 26/26 (was 14; +12: limits save / plan removal guard, retention preview numbers with and
  without grace, server-side confirmation, purge confirmation, expiring list, per-video expiry, system save, database
  facts, backup health, real Cloudinary usage API, audit filters), `db:smoke` 29/29 after the migration move,
  typecheck + lint clean in both apps, screenshots of the forms at 1280 px (`/dev/admin?view=limits|retention|system|health|impact|expiry`).
  NOT checked in a browser while signed in (Clerk): the pages' data wiring is covered by the service tests, their
  layout by the dev previews.
- Left out on purpose: the "Run cleanup now" button — web/ never talks to the worker (D35); the cleanup runs every
  30 minutes anyway and the Retention page lists what is due. Per-run cleanup history isn't stored (only logs).

### Step 17 — Hardening (in progress, started 2026-10-03)

**17a — AI quota used up → wait, don't fail ✅** (D50)
- When every AI model is out of daily quota the video stays `queued` with "Today's free AI capacity
  is used up… carries on by itself around <time>" and the dispatcher resumes it at the reset
  (Gemini: midnight Pacific; our caps: midnight UTC). Max 3 waits, then failed + Try again.
- Shared: `pipeline.waitUntil`, `pipeline.quotaWaits`, `PIPELINE_TIMING.maxQuotaWaits`.
  Worker: `services/ai/reset-time.ts`, `pickFinalError` (llm.ts), `run.waitForQuota`, processor
  outcome `waiting`, dispatcher filter. Web: `VideoProgressView.waitUntil` + banner in
  `video-progress.tsx`; retries/admin re-runs reset the counter. Dev preview: `/dev/workspace?status=waiting`.
- **Verified:** `pipeline:smoke` 18/18 (2 new: wait → dispatcher skips it until the time → runs and
  finishes with the counter reset → fails after the last allowed wait; reset times incl. summer/
  winter time and the daylight-saving night; which errors count as "out of quota"); typecheck.
- **Mistral not added yet:** the key Rahat pasted (45 chars, `mstrl_…`) answers 401 "Invalid API Key"
  on api.mistral.ai (as far as I know real keys are 32 characters, no prefix). It was pasted in
  chat, so it must be rotated anyway. It sits in worker/ and web/ `.env.local` as MISTRAL_API_KEY
  (nothing reads it). Add the provider once a working key exists. OpenRouter: dropped.
**17b — Cleanup job ✅** (D51)
- `worker/src/cleanup/cleanup.ts` (the sweeps, storage injectable), `schedule.ts` (kill switch + Redis
  lock), `services/storage/cleanup-storage.ts` (Cloudinary delete-by-prefix + file listing); wired in
  `index.ts` (every 30 min; orphan scan daily). `settings.system.cleanupEnabled` (default on).
  `CLEANUP_TIMING` in shared. `npm run cleanup:run` (dry run; `-- --apply`, `-- --orphans`).
- **Verified:** `cleanup:smoke` 8/8 (fake Cloudinary, throwaway DB): expiry incl. re-processing /
  admin-extended videos and idempotence; retention shortening respects the grace period; failed delete
  retried; abandoned drafts; purge keeps the usage ledger; orphans with every guard; rate limit; dry run,
  kill switch, empty-database guard. One real bug found by the test: the empty-database guard used a
  count that can lag — now `exists`. Real dry run on Rahat's data: 4 videos have files in Cloudinary,
  all have documents, nothing to delete today; the 3 failed videos from 28–29 Sep expire on 5–6 Oct and
  will be cleaned automatically.
**17c — Minutes on retry ✅** (D52)
- The double-charge rule (D33) held: 3 charge attempts for one video → charged once, counter +10 once.
  The real flaw was the opposite: Retry / re-run ingest re-checked "minutes left" for a video whose minutes
  were already charged, so a user near the limit couldn't finish a video they had paid for. Fixed with
  `videoWasCharged` (shared/usage.ts) in `retryVideo` and the worker's `ingest`; the length rule still applies.
- Also found: the double-charge rule rests on the unique index `usage_events.idempotencyKey`, which production
  never builds by itself. New `worker/src/lib/indexes.ts`: at boot (production) every unique index must exist or
  the worker refuses to start ("run npm run db:indexes"). Real database checked: all present.
- **Verified:** `upload:smoke` 30/30 (+2: rules with alreadyCharged; Retry of a charged vs uncharged video),
  `pipeline:smoke` 19/19 (+1: charged once however many retries; charged video not refused, length still
  enforced), `db:smoke` 29/29 (+1: missing unique index reported → worker refuses → fixed), typecheck + lint.
- **Step 18 checklist additions:** run `npm run db:indexes` + `npm run migrate` on the production database
  before the first worker start; separate `CLOUDINARY_FOLDER` for production (D51).
**17d — Backups ✅ · 17e — Rate limits ✅ · 17f — Error states ✅** (D53)
- Backups: `worker/src/lib/backup.ts`, `backup/storage.ts` + `backup/schedule.ts` (daily, Cloudinary, newest 7),
  `npm run db:backup` / `db:restore`. **Verified:** `backup:smoke` 5/5 (exact types incl. ObjectId/Date/Bangla/null,
  empty collection, restore safety, damaged files refused before writing, real Cloudinary upload → list →
  byte-identical download → restore → delete, oversize refused); on Rahat's real database: 87 documents backed
  up, restored into a temporary database, **all 87 compared identical**, temporary database dropped. Found by
  testing: Cloudinary refuses normal delivery of .gz (401) → API-signed download link. NOT uploaded to
  Cloudinary yet: Rahat's real data goes there only when the worker runs (needs his OK of the design).
- Rate limits: `web/src/lib/rate-limit-core.ts` (table + counter, testable) and `limitUser` in every API route
  (13 routes). `review:smoke` 16/16 (+1: window, refusal with wait time, fresh window, another user).
- Error states: `app/error.tsx`, `(app)/error.tsx`, `global-error.tsx`, `not-found.tsx` + `ErrorCard`; dev preview
  `/dev/crash`; screenshots checked. Error-message audit: four messages now say what to do next.
- **Open (not blocking):** Mistral as an extra AI provider — the key given answered 401.
- **Deploy checklist so far (Step 18):** `npm run db:indexes` + `npm run migrate` on the production DB before the
  first worker start (D52); production `CLOUDINARY_FOLDER` ≠ dev (D51); check `backup:last` after day one;
  Cloudinary's 10 MB raw limit vs backup size (D53); rotate every key.

### Step 15.6 — Cover v2 ✅ (2026-10-03)

- Rahat tested covers on a real clip: "working, but we need better covers". His clip's text
  was copy@1 (no cover text) so the editor started from the long title, and the face was small.
- **Words:** prompt `copy@3` (new default) asks for 3 `cover_options` per clip — 2–5 words, each
  with the ONE key word (`highlight`) drawn in a second colour; still the same single request.
  Stored as `copy.coverOptions[{text, highlight}]` (first = `coverText`). A highlight that isn't
  made of the text's words is dropped (`cleanCoverHighlight`). **"Suggest words"** in the editor
  = `POST copy-requests {clipId, part: "cover"}` → `clips.coverRedoAt` → the copy stage rewrites
  ONLY `copy.coverText`/`coverOptions` for that clip (an edited title stays); counts as a rewrite.
- **Editor:** idea chips, tap a word for the second colour, Zoom 1–1.8× + drag to move, "Punch"
  (canvas contrast/saturation + vignette, on by default), looks Yellow / White / Red box /
  Yellow box, font **Baloo Da 2 800** (next/font, `preload: false`, Hind as fallback).
- **Verified:** `copy:smoke` 11/11 (real Gemini ideas e.g. "ফাহানের [গোল]!", "দারুণ খেলছে
  [ফাহান]!", "[সাফে] ফোকাস!"; cover-only rewrite keeps an edited title), `review:smoke` 15/15
  (cover request marks/counts, needs a clip), typecheck + lint both apps, screenshots of
  `/dev/cover` (Bangla, Banglish, Yellow box + zoom). Dev params: `?style=&pos=&zoom=&panX=&panY=`.
- Not done (agreed optional): 10 frames + dropping dark/blank ones — new renders only, later.

### Step 15.5 — Clip covers ✅ (2026-10-02)

- Rahat asked whether clips can have thumbnails. Design → D49: every render also saves 6 clean
  9:16 frames (same crop, no captions; ffmpeg `fps=2,thumbnail` per stretch, ~300 KB, ~3 s);
  the post-text request writes 2–5 "cover text" words (prompt `copy@2` = copy@1 + one line;
  new default); the clip card's **Cover** button opens a browser editor (pick frame, words,
  Yellow / White / Red box, Top / Middle / Bottom) that downloads a 1080×1920 JPG. Nothing
  is stored for a cover; Bangla is shaped by the browser.
- Shared: `renders.coverFrames`, `copy.coverText`, `POST_COPY.coverTextMaxChars`, `copy@2`.
- Worker: `extractCoverFrames`, `uploadPrivateImage`, frames made after the MP4 upload (a
  failure only logs). Web: `lib/cover-draw.ts`, `clip-cover.tsx`, signed frame URLs; deleting
  a video / user now also deletes image assets under renders/. Dev: `/dev/cover`, `/dev/frame`.
- **Verified:** `render:smoke` 15/15 (6 frames 1080×1920 in 2.7 s; pipeline renders carry 6
  covers), `copy:smoke` 10/10 (real Gemini cover texts "ফাহানের গোল!", "সাফে ভালো করব!");
  typecheck + lint; screenshots of the
  editor with Bangla and Banglish text.
- Older renders have no frames → no Cover button until rendered again.

### Step 15 — Post text + Banglish ✅ (2026-10-02)

- Design → D48. The "copy" stage writes every shown clip's **title, hook (labelled AI-written),
  description and hashtags in ONE request** (`copy@1`), in the video's letters: Bangla script,
  Banglish, or English. Never fails the video — AI down → stage "skipped", the clip offers
  "Write post text".
- **Banglish** = a per-video switch (Captions tab: বাংলা | Banglish) for Bangla videos: captions
  AND post text in English letters. Captions are transliterated word for word (`banglish@1`)
  so every word keeps its time; only words inside clips, stored on the transcript
  (`latnWords`, keyed by word time). The copy stage spells all clips in one request; a render
  asks only for words a trim added. The switch changes the render spec → "Render again".
- Shared: `videos.options.captionScript`, `counts.copyRequests`, `clips.copyRedoAt`,
  `copy.writtenAt/editedAt`, `transcripts.latnWords`, plan limit `copyRequestsPerVideo` (10),
  `COPY_REQUEST_LIMIT`, `post-copy.ts` (limits, hashtag rules), `captionScriptFor`/`specVideo`.
- Worker: `services/copy/prompt.ts`, `services/copy/banglish.ts`, `stages/copy.ts`
  (`makeCopy({ call })` for tests); render stage + render queue use Banglish words.
- Web: `ClipPostText` in the clip card (copy buttons, Copy all, edit, write again), title in the
  clip list, Banglish switch, `POST /api/videos/:id/copy-requests` (`{ clipId? }`) and
  `/caption-script` (`copy-request.ts`: copy stage only, rendering untouched), PATCH clip
  `copy`. Admin override "Post text rewrites per video". Stage list no longer says "Coming in a
  later update" for copy.
- **Verified:** new `copy:smoke` 10/10 (2 real Gemini: Bangla titles "ফাহানের গোল ও খেলার প্রতি তার
  ক্ষুধা 🔥", Banglish "Fahan ei khelate valo korte parche ekta goal diyeche."; fake AI: one request
  for all shown clips, Banglish switch = 2 requests, write again asks one clip, AI down →
  skipped + ready, trims ask only new words), `review:smoke` 15/15, `render:smoke` 14/14 (copy
  stubbed there now; one transient Cloudinary STORAGE_FAILED on the first run), `pipeline:smoke`
  16/16, `db:smoke` 28/28; typecheck + lint both apps; screenshots (post text, Captions tab at 1280×600).
- Rahat's first test: Banglish switch → 500 "counts.copyRequests is not in schema" (strictQuery
  throw). Cause: `registerModel` reused the model compiled before the schema change, and next dev's
  hot reload kept it (smoke tests run in a fresh process, so they passed). Fix: in development a
  re-run with a different schema object recompiles the model (`deleteModel`); production unchanged.
- Not done: a Banglish choice on the New video form (switch after processing for now); hook
  burned onto the video; Banglish in the Transcript tab.

### Step 14 — Find new clips ✅ (2026-10-02)

- Design → D47. A finished video gets **Find new clips** in its header: pick another focus (the
  8 form focuses) or "Something specific…" (the user describes what to find, any language).
  The video goes back to the queue from "Finding moments"; the transcript is reused (no
  minutes). Approved clips stay ("Kept"); everything else of the old set leaves the page.
- Shared: `videos.clipRequest` (status pending/done/no_moments/failed, intent, query,
  previousStages), `counts.clipRequests`, `clips.keptAt`, plan limit `clipRequestsPerVideo`
  (3), error `CLIP_REQUEST_LIMIT`, `clip-sets.ts` (`visibleClipsFilter`, `isVisibleClip`,
  `CLIP_REQUEST`).
- Worker: analyze makes a `regenerate` / `search` run; taken stretches (approved + every
  rejected clip, plus all shown clips when the focus didn't change) go to the prompt as an
  optional rule (only when there are any — released prompts unchanged) AND are enforced in
  `resolveMoments` (`taken`). Kept clips marked at the end (approvals made while it ran
  count). No moments → current clips unchanged (`no_moments`). AI failure after retries →
  video back to Ready, stages restored, request not counted (`failClipRequest`). Retention
  clock: `$min`, so a new set never extends expiry. Render stage: a YouTube video without
  the source on disk (later runs) queues its new top clips on the render queue (sections only)
  instead of downloading the whole video; uploads are still fetched once and rendered inline.
  `makeAnalyze({ call })` lets the smoke test use a fake AI.
- Web: `POST /api/videos/:id/clip-requests` (`clip-request.ts`), `FindClipsPopover`, header
  "Focus: …", result note above the clip tabs (no match / failed, for a day), "Kept" badge,
  clips numbered in the order shown, kept clips editable/renderable, `INTENT_LABELS` moved to
  `video-labels.ts`. Admin: per-user override "New clip searches per video". ESLint ignores
  `.scratch/` (the headless Chrome profile was being linted).
- **Verified:** `clips:smoke` 24/24 (5 new: taken ranges + prompt rule; same focus; new focus
  incl. rejected from an older set; no match; AI failure → Ready), `render:smoke` 13/13 (YouTube
  later run → queued, nothing downloaded), `review:smoke` 13/13 (request rules, limit, one at a
  time, expired, kept clips), `pipeline:smoke` 16/16, `db:smoke` 28/28; web typecheck + lint,
  worker typecheck; screenshots of /dev/workspace at 1280×600 and 1366×650 (note + popover open).
- Rahat's first real test: the request worked (1 new clip, approved clip kept) but the new
  clip's render failed "We couldn't download the video." — one YouTube section download failed
  after 7 s; the same download worked minutes later. Fix: the render queue tries a generic
  section-download failure again after 3 s and 10 s (not "unavailable" / "YouTube is blocking"),
  and `renders.error.detail` keeps the yt-dlp stderr tail (never shown) for next time.
  `render:smoke` 14/14.

### Video page fits one screen ✅ (2026-10-02)

- Rahat: on a laptop the clip part was a tiny nested scroll under a big player; wants
  everything visible without scrolling. Plan agreed, then built (docs/DESIGN.md workspace).
- Web: `video-workspace.tsx` (layout shared by the page and the dev preview), compact header
  with `StepsPopover` once ready, player height = viewport − 22.5rem (left column ≤ 62 %),
  `ClipEditToolbar` (Trim | Framing | Captions tabs, fixed height), side panel master–detail
  (`clip-card.tsx`: nav ‹ › ↑↓, verdict, reason, 9:16 MP4, text), compact clip list;
  `clip-details.tsx` removed; `/dev/workspace` preview (dev only).
- **Verified:** screenshots of /dev/workspace at 1280×600, 1366×650, 1920×950 (ready) and
  1366×650 processing + collapsed sidebar — no page scroll, nothing cut off; web typecheck + lint.

### Step 13 — Clip review ✅ (2026-10-02)

- Shared: `clip-edit.ts` (`CLIP_EDIT` 3 s – 3 min, ±0.5 s; `REJECT_REASONS`; `isValidClipRange`), clip
  `edit.aiStartMs/aiEndMs` (additive).
- Web: `lib/videos/clip-edit.ts` (`clipUpdateSchema`, `updateClip`), `PATCH /api/clips/:id`; `ClipView` gets
  status, reject reason, framing, caption style, the AI's cut; `clip-review.tsx` — `ClipVerdict`
  (Approve / Reject → reason chips → Undo) and `ClipEditor` (trim with 3 s listen buttons + Reset to
  AI cut, framing presets + slider with a live 9:16 overlay on the player, Bold / Clean captions,
  Discard / Save / Save & render); clip list + timeline show approved / fade rejected; player
  context `frame` + `frameBox`. `renders.ts` / `clip-edit.ts` lost `server-only` so the new
  `npm run review:smoke` can run them.
- **Verified:** `review:smoke` 9/9 (verdicts, trim rules + AI cut memory, framing/style, ownership,
  render request dedupe + CONFLICT while processing, outdated after trim, download signal, expiry);
  Clean captions + left framing rendered and checked by eye (crop matches the overlay maths);
  web + worker typecheck, web lint. Not yet seen in the browser by Rahat.

### Render fixes + collapsible sidebar ✅ (2026-10-02)

- Rahat's test (YouTube "Star Play", 1:55): render stage "Skipped"; a clip rendered by button had
  no sound; captions should sit lower; wants a collapsible sidebar.
- Worker: analyze passes `currentAnalysisRunId` on to later stages (+ render reads the DB); sound
  guards (section re-download, required audio map, probe before upload); captions `marginV` 0.16,
  `render@2` (D45 addendum).
- Web: `RenderView.outdated` → "Render again" next to Download; sidebar collapses to an icon
  rail (tooltips, minutes ring), button + Ctrl/Cmd+B, choice kept in the `cc_sidebar` cookie and
  read by the layout (`lib/ui-prefs.ts`) so the first paint matches.
- **Verified:** `render:smoke` 12/12 (new: render after analyze in the same job, stored MP4 has AAC
  sound, a silent source fails when sound is required); worker + web typecheck, web lint. Sidebar
  not seen in a browser by Claude (pages need sign-in).

### Step 12 — Render ✅ (2026-09-30)

- Rahat approved: auto-render the top 3 clips, the rest on click; YouTube at 1080p (D45).
- Shared: `render.ts` (`RENDER_SIZES`, `renderSpecForClip`, `renderSpecHash` + `RENDER_ENGINE_VERSION`,
  `RENDER_TIMING`), `caption-styles.ts` (`preset:bold`, `preset:clean`), queue contract
  (`QUEUES.render`, `RenderJobData`, `renderJobId`), settings `system.render` {autoRenderTop 3,
  youtubeMaxHeight 1080, crf 21, preset veryfast}, `renders.timings.heartbeatAt` + index
  `{status, timings.queuedAt}` (additive), render/copy/1080p-ingest estimates.
- Worker: `services/render/captions.ts` (phrases → ASS), `services/render/encode.ts` (crop/scale/
  fps/ass/x264), `assets/fonts/HindSiliguri-Bold.ttf` (+ OFL.txt), `renders/store.ts` (claims,
  heartbeat, finish/fail), `renders/produce.ts`, `renders/dispatcher.ts` (queue + stuck sweep),
  `processors/render-processor.ts`, `queues/render-queue.ts`, stages `copy` (skips until Step 15)
  and `render`; `runTool` `cwd`; yt-dlp `youtubeFormat(maxHeight)` + `downloadYouTubeSection`;
  Cloudinary `renderPublicId` / `uploadPrivateVideo` (chunked).
- Web: `lib/videos/renders.ts` (views, `requestRender`, `downloadRender`), `POST /api/clips/:id/render`,
  `GET /api/videos/:id/renders`, `GET /api/renders/:id/download`; `ClipRender` in the selected-clip
  panel (9:16 preview, Download, Render clip, progress, Try again; polls every 3 s while needed);
  stage list: skipped copy = "Coming in a later update"; renders deleted with the video / user.
- **Verified:** `render:smoke` 11/11 (Bangla captions checked by eye, 60→30 fps, vertical source,
  7 s YouTube section, pipeline top-3 render + retry reuse, render queue, stuck sweep);
  `db:smoke` 28/28, `pipeline:smoke` 16/16, `media:smoke` 11/11 (YouTube now 1080p); worker +
  web typecheck, web lint. Not yet seen in the browser by Rahat.

### Minutes warnings, ClipCut name + logo ✅ (2026-09-30)

- Rahat asked what happens at 60/60 min (answer: upload refused up front; YouTube stops at
  ingest before any charge; resets on the first charge's anniversary) and for two fixes.
- Shared: `quotaResetsAt(user)` (same anniversary rule as `chargeMinutes`).
- Web: sidebar usage card shows "Resets Oct 29" and "No minutes left this month";
  `NewVideoCard` gets `minutes` — out of minutes → red note + Find clips disabled; fewer
  minutes left than the plan's max length → amber note; a picked file needing more minutes
  than are left is refused on pick with the server's wording. `/api/me` adds `usage.resetsAt`.
  `formatDay()` (UTC, "Oct 29").
- Name: **ClipCut** (D44). New mark + wordmark, `icon.svg` / `favicon.ico` / `apple-icon.png`,
  titles via a `%s · ClipCut` template (`lib/brand.ts`).
- **Verified:** web typecheck + lint, worker typecheck, shared:check.

### Faster transcription, time left, Accuracy page ✅ (2026-09-30)

- Rahat's test: an 8.5-min Bangla video sat at 10 % in "Transcribing" for 10 min; titles
  step showed "Failed"; clips were good. Asked for the Accuracy page and a time estimate.
- Worker: Gemini transcription in 5-min batches, 2 at a time, one call per model per round
  (`generateJson` `attemptsPerModel`), output limit scaled to the audio, smooth progress
  inside a batch. 627 s → 104 s on the same audio (D42).
- Shared: `estimates.ts` (`expectedStageMs`, `estimateRemainingMs`, client-safe) — measured
  stage times; copy/render get estimates when they're built.
- Web: progress shows "About N min left" / "Taking longer than usual" (`mediaDurationMs` in
  the progress view); a run stopped at a not-yet-built stage (STAGE_NOT_READY) shows
  "Clips ready" + "Coming in a later update" instead of Failed (`isComingSoon`).
  `/admin/accuracy` (Step 11's page, built early): per prompt × model runs, proposed → kept,
  avg score, clean start/end share, approve/reject/download (fill in with Step 13), where
  cuts landed (snap rules), transcription engines per language (Whisper on Bangla flagged),
  failed runs, rejection reasons, eval-set placeholder; 7 / 30 days / all.
  ESLint rule `local/no-shared-barrel-in-client` after the /admin/ai "async_hooks" crash.
- **Verified:** `transcribe:smoke` 15/15; replay of the slow video's audio 104 s; Accuracy
  aggregations run against the dev DB (5 runs, 31 clips, 18/18 snapped clips clean);
  estimate for that video 234 s vs ~231 s real. Web typecheck + lint, worker typecheck.

### More clip focuses + AI fallback chains ✅ (2026-09-30)

- Rahat: more "What should clips focus on?" choices (sports and similar); fall back to other
  AIs when Gemini's quota runs out. Design → D43 (+ D42 shift guard).
- Clip focus: Sports highlights, News & updates, Interviews & podcasts, Speeches &
  motivation added (`CLIP_INTENTS`, form order in `FORM_INTENTS`). Their prompt text is new;
  the existing four are unchanged, so `clip-select@1` stays comparable.
- Probed every Gemini model on the key (which answer, D43). 2.5-flash = 20 requests/day
  (Google's 429); Flash-Lite ≈ 500/day is from third-party guides — check ai.dev/rate-limit.
  `gemini-3.5-flash-lite` shifted text between transcript pieces → silent control pieces
  now catch that (`planSlots`, `checkControls`).
- Settings: `clipSelection`/`copyWriting` `fallbacks[]` (default 3-flash-preview →
  3.1-flash-lite → Groq); transcription Gemini chain 3-flash-preview → 3.1-flash-lite →
  2.5-flash → Whisper. Admin AI page edits the chains (add/remove/test).
- **Verified:** `transcribe:smoke` 15/15 (+ control pieces; real run sends controls),
  `db:smoke` 28/28, `admin:smoke` 14/14, `clips:smoke` 18/19 (+ sports prompt; the
  analyze-stage checks passed through the chain while 2.5-flash was out of quota — only the
  test that calls 2.5-flash directly failed). Web typecheck + lint, worker typecheck.

### Bangla transcription via Gemini ✅ (2026-09-30, before Step 12)

- Rahat: the Bangla transcript has to get better before captions. Probed piece-by-piece
  Gemini on the Jamuna Sports news (2.6 min) and the drama (4.9 min, music under speech):
  clean Bangla, dialect kept, pieces line up with the audio. Design → D42.
- Worker: `services/transcription/chunks.ts` (pure: pieces cut mid-pause, 3–15 s, no tiny
  last piece; word times spread over speech), `gemini-pieces.ts` (versioned prompt
  `transcribe-pieces@1`, one ffmpeg pass → one Opus file per piece, ~10 min batches as
  labelled audio parts, answer check, model chain), transcribe stage picks Gemini for the
  configured languages and falls back to Whisper. `generateJson` requests can carry audio
  parts and turn thinking off (Gemini). `quietRuns` moved to `loudness.ts`.
- Shared: `settings.ai.transcription.gemini {languages, models, batchMinutes}`,
  `transcripts.wordTiming` (additive).
- Web: admin AI page — "Gemini text for" languages, model + fallback, minutes per request;
  admin video page shows the word-time source. `LANGUAGE_NAMES` shared in `video-labels`.
- Existing videos keep their Whisper transcripts; submit a video again to get Gemini text.
- **Verified:** `transcribe:smoke` 14/14 — new: pieces cut mid-pause / music fallback /
  no tiny last piece, word-time spread, answer checks + prompt; real Gemini on the Bangla
  podcast fixture (Bengali script, 3–15 s pieces, punctuation, raw JSON), unknown Gemini
  model → Whisper fallback and the video finishes, English stays on Whisper. Probe on the
  news video: 2.6 min in 12 s, one request. `clips:smoke` 17/19 (real Gemini hit
  2.5-flash's 20/day quota; Groq pick varied again — both external). Web typecheck + lint,
  worker typecheck.

### Step 10 — Boundary snapping ✅ (2026-09-29)

- Probed first on the real transcripts: Whisper words touch the next one ~90 % of the time,
  Bangla has almost no punctuation → pauses must come from the audio. Design → D41.
- Worker: `services/media/loudness.ts` (ffmpeg decode to 8 kHz PCM on stdout → dB per
  20 ms, quiet threshold), `services/clips/snap.ts` (pure: word/segment units, boundary
  strength from sentence marks + segment ends + audio pauses, move start/end to the nearest
  clean boundary within 6 s, quiet cut with ≤0.4 s lead / ≤0.7 s tail, limits kept),
  `moments.ts` snaps after the line fit and before overlap/ranking (stats: clean
  starts/ends), `analyze` measures loudness in parallel with the AI call (best effort) and
  stores `snap.{version, basis, startRule, endRule}` + the full snap detail in the analysis
  JSON. `runTool` can stream raw stdout bytes; `ensureAudio` moved to
  `pipeline/audio-file.ts` (transcribe + analyze).
- Shared: `clips.snap.version`, `clips.snap.basis` (additive).
- Web: admin video page shows start/end rule + basis per clip.
- New videos get snapped clips automatically; existing clips keep their Step 9 cuts (admin
  "Pick clips again" re-runs with snapping).
- **Verified:** `clips:smoke` 19 checks — 6 new: boundary strength (sentence mark, segment
  end, a quiet stretch between touching words), start earlier / end later to clean
  boundaries and the 1.5× cost of dropping words, limits (max_cut, min kept), cut placement
  in the quiet + no-audio lead/tail, resolveMoments integration, real ffmpeg loudness on a
  generated tone–silence–tone file; analyze stage stores `snap@1`. Real Gemini/Groq checks
  are flaky on the free tier (503 busy; Groq's pick varied across 3 runs — see Known
  issues). Offline replay on the football + Bangla videos (10 clips): 18 of 20 starts/ends clean, leads/tails
  within 0.4/0.7 s. `transcribe:smoke` 11/11, `media:smoke` 11/11, `pipeline:smoke` 16/16; web typecheck + lint, worker typecheck.

### Video workspace layout ✅ (2026-09-29, after the admin catch-up)

- Rahat: show everything on one screen instead of a long page. Design in docs/DESIGN.md
  ("Video page = one-screen workspace").
- Web: video page rebuilt — header (title, status, N clips, meta) · left: player (column width
  capped by viewport height), clip timeline (bars by score, click to play), selected clip
  (reason + words) · right: progress (stages fold behind "Show steps" once finished or
  stopped) + Clips / Transcript tabs scrolling inside the panel. Player context now keeps
  the selected clip and can play from any transcript line. `MomentsPanel` replaced by
  `clip-list` / `clip-details` / `clip-timeline` / `transcript-list` / `video-side-panel`.
- Checked with headless Chrome screenshots at 1600×900, 1366×768 and a true 390 px phone
  viewport (temporary dev-only preview route, deleted afterwards). Web typecheck + lint.

### Admin catch-up ✅ (2026-09-29, after Step 9)

- Rahat: build the admin pieces Steps 5–9 skipped, plus user management now. Design → D40.
- Worker: `pipeline.analyzeWith` (admin "pick clips again") → analyze makes a fresh `regenerate`
  run with exactly that model/prompt, no fallback, then clears the field; reuse now means
  "the video's current run, if done for this transcript". `PipelineRun.unsetFields`. Prompt
  versions live in shared (`PROMPT_VERSIONS`) so the admin can only pick real ones.
  Whisper filler filter: "you" / "Thank you" / "Thanks for watching" with no_speech > 0.5
  dropped (the "5:44 you" in the football video).
- Web: `/admin/videos` (+ `/[id]`), `/admin/users` (+ `/[id]`), `/admin/ai`; overview cards link
  to them and an "AI today" card shows usage vs caps; nav marks the open section and has a
  phone bar. Services in `src/lib/admin/`, server actions per section, `runAdminAction`
  (role, 30/min rate limit, safe errors). Optional `GEMINI_API_KEY`/`GROQ_API_KEY` in web
  (copied from worker/.env.local, never printed) for model lists and Test.
- Shared: `ai.ts` (`PROMPT_VERSIONS`, `aiCapKey`), `videos.pipeline.analyzeWith`.
- **Verified:** `admin:smoke` 14/14 (videos list/retry/cancel/re-pick/delete, users
  list/plan/override/reset/suspend/role/delete-all-data incl. real Cloudinary file removal,
  AI settings save/version conflict/prompt guard, live Gemini + Groq Whisper lists, real
  Test and a 404 model), `clips:smoke` 13/13 (+ admin re-run with Groq), `transcribe:smoke`
  11/11 (+ filler rule), `pipeline:smoke` 16/16, `media:smoke` 11/11, `upload:smoke`
  28/28, web typecheck + lint.

### Step 9 — Clip selection v1 ✅ (2026-09-29)

- Rahat: skip the full eval set for now (fewer videos, later) and start Step 9.
- Probed first: which Gemini models answer on our free key (2.5-flash ✓, 3-flash-preview ✓,
  3.5-flash ✓ but slow/503-prone, 3.6–3.8 mostly 503, 2.5-flash-lite/2.5-pro closed to new
  keys), JSON-schema output on Gemini and Groq, Groq gpt-oss-120b limits (8k tokens/min).
  Design → D39.
- Worker: `services/ai/llm.ts` (`generateJson`: retry rules + fallback chain + per-call
  daily caps), `gemini.ts`, `groq-chat.ts`, `http.ts`; `services/clips/lines.ts` (segments →
  numbered lines via word timestamps), `prompt.ts` (versioned prompts, `clip-select@1`,
  JSON schema, tolerant parsing), `moments.ts` (pure: lines → clips, length fit, overlap,
  rank); stage `analyze` (reuse a finished run, clear crashed runs, `analysis_runs` row,
  prompt + answer to Cloudinary, `clips` rows, `currentAnalysisRunId`, `counts.clips`,
  smooth progress while the model thinks). Runs now stop at "Writing titles & hooks"
  (STAGE_NOT_READY) until Step 15.
- Shared: error `NO_MOMENTS_FOUND`.
- Web: video page has "Suggested clips" (rank, time range, length, type, score, reason, the
  words) with Play → the player above plays just that part (YouTube embed start/end, or the
  file player pausing at the end). Player moved into `components/app/source-player.tsx`
  (`PlayerProvider` + `usePlayer`). Delete also removes `<folder>/analysis/…` files.
- First real result (Rahat's 5-min Bangla drama, garbled Whisper text): 3 moments; #2 is the
  exact scene the video's own title and thumbnail advertise.
- Found while testing: Gemini transcribes Bangla far better than Whisper (see Known issues).
- media:smoke and transcribe:smoke now run only their own stages (they assumed the next
  stage didn't exist).
- **Verified:** `npm run clips:smoke` 12/12 — lines split/fallback/format, prompt (limits,
  intent, custom query quoted as data), answer parsing, length fit (join, gap, trim, cut),
  ranking/overlap/top N, retry + fallback rules with fake providers; real Gemini and real
  Groq pick the story in a made-up podcast and skip intro/sponsor/outro; the analyze stage
  on a throwaway DB (run row, raw file, ranked clips, crashed leftovers cleared, retry
  reuses the run with no second AI call). Web + worker typecheck, lint.

### Step 7 — Transcription ✅ (2026-09-28)

- Probed Groq with 2 min of a real Bangla podcast (section of YouTube 7VCFYPz44mQ, 600–720 s):
  v3 vs turbo, with/without a Bangla prompt, rate-limit headers. Findings → D37.
- Worker: `services/transcription/groq.ts` (multipart Opus upload, verbose_json, segment +
  word timestamps, temperature 0, errors → AI_UNAVAILABLE on 429 / TRANSCRIPTION_FAILED,
  rate-limit headers incl. `x-ratelimit-reset-audio-seconds`), `normalize.ts` (pure: ms,
  clamp, NFC keeping ZWJ, silence + loop hallucinations dropped, words inside kept
  segments), `services/ai/daily-caps.ts` (Redis `ai:<provider>:<metric>:<day>`),
  `pipeline/usage.ts` (`chargeMinutes`: ledger then counter, period rollover),
  `stages/transcribe.ts` (reuse existing ASR transcript, audio from scratch or Cloudinary,
  wait on 429 with a countdown, words + raw JSON to Cloudinary, transcript v1,
  `currentTranscriptId`, charge). AI_DAILY_CAP_REACHED isn't auto-retried.
- Shared: `currentQuotaPeriodStart`, activity kind `waiting_transcription` (renamed
  TRANSFER_KINDS → ACTIVITY_KINDS), `transcripts.stats.droppedSegments`.
- Web: `TranscriptPanel` on the video page (timed lines, `lang`, word/line count), waiting
  note in the progress card, delete also removes transcript JSON.
- Fix: worker startup cleared every folder in `.scratch/` (it wiped test fixtures while
  `tsx watch` restarted). Job folders now live in `.scratch/jobs/`, and only that is cleared.
- Fixtures for `transcribe:smoke` (gitignored, `worker/.scratch/fixtures/`):
  `bn-podcast-120s.ogg` = `yt-dlp -f ba --download-sections "*600-720" 7VCFYPz44mQ` →
  Opus 16 kHz mono 48k; `en-zoo-19s.ogg` = audio of jNQXAC9IVRw, same settings.
- Language check (D38) after Rahat's test: an English-commentary football video submitted as
  Bangla gave a nonsense Bengali-script transcript. Now 1–2 middle samples are auto-detected
  first; clearly-other-language → switched + shown on the page (`videos.languageCheck`).
- Pipeline now stops at "Finding moments" (STAGE_NOT_READY) until Step 9.
- **Verified:** `npm run transcribe:smoke` 10/10 (incl. language check: English audio picked as
  Bangla → switched to English; Bangla stays Bangla) — normalize (ms, clamp, silence + loop drops,
  NFC + ZWJ), Groq duration parsing, quota period rollover, Redis daily cap, charge once per
  video + monthly rollover; real Groq: 2-min Bangla podcast → Bangla-script transcript
  (>90 % Bengali letters, ≥100 words, words JSON in Cloudinary matches), retry reuses it
  (no second call, no second charge), English "Me at the zoo" → "elephants".
  `pipeline:smoke` 16/16; web typecheck + lint; worker typecheck; shared:check.

### Step 6 — Ingest ✅ (2026-09-28)

- Probed first: yt-dlp 2026.08 warns without a JS runtime; `--js-runtimes node` lists all
  formats (144p–4K). Format string picks 720p H.264 ≤30 fps + m4a, merged to MP4. Design D36.
- Worker: `lib/exec.ts` (`runTool`: binary + args, no shell, timeout, abort, line
  callbacks), `services/media/ffprobe.ts` (displayed size with rotation, fps, codecs,
  cover-art isn't video), `services/media/audio.ts` (Opus 16 kHz mono, bitrate for Groq's
  25 MB, `-progress`), `services/media/ytdlp.ts` (info, download with progress, stderr →
  VIDEO_UNAVAILABLE / DOWNLOAD_FAILED / FILE_TOO_LARGE, bot-check message),
  `services/storage/cloudinary.ts` (signed private download to `.part` then rename, private
  audio upload), `pipeline/source.ts` (`ensureSource`), `pipeline/limits.ts` (length +
  minutes-left rules on the real length).
- Stages: **ingest** (YouTube: kill switch/plan, live, private, age-gated, too long → reject
  before download; then fetch, ffprobe, gates, writes `media`) and **audio** (extract,
  upload, writes `audio`). Run now stops at "Transcribing" (STAGE_NOT_READY) until Step 7.
- Runner: `run.setFields()`; stage progress written when the stage moves ≥10 % (so a long
  download inside a 5 % stage still shows); scratch folder kept between BullMQ retries.
- Web: `POST /api/videos/youtube` (auth first; kill switch + plan; link parse; oEmbed →
  title/author/thumbnail, 401/403/404 → VIDEO_UNAVAILABLE; slot + ≥1 minute left;
  idempotent on `clientRequestId`). New video card: YouTube tab live with inline link
  check. Video page: YouTube embed (youtube-nocookie) and author. Stage list shows the
  running stage's %. Delete also removes the stored audio.
- Slow-download feedback (Rahat's request): the worker measures each download
  (`lib/transfer.ts`, 8 s window) and writes `pipeline.activity` {kind, bytes, speed, time
  left} at most every 5 s; cleared when the download ends. The video page shows "Downloading
  from YouTube / Fetching your upload · 12 MB of 80 MB · 450 KB/s · about 3 min left", plus a
  warning note under 512 KB/s (`SLOW_TRANSFER_BYTES_PER_SEC`). The browser upload card shows
  speed and the same kind of note. Stale activity (>30 s) is hidden.
- A queued video whose worker is down says so ("The processing server is offline right now…"):
  `GET /api/videos/:id` adds `workerOnline` from the Redis presence keys (cached 10 s) while
  queued. Matters in production too: a free Hugging Face Space sleeps when idle.
- **Verified:** `npm run media:smoke` 11/11 — real ffmpeg/ffprobe (incl. 90° phone video),
  Opus output, yt-dlp info + unknown id, full ingest+audio for an upload (Cloudinary) and a
  YouTube video (19 s), missing upload → UPLOAD_NOT_FOUND, no minutes → QUOTA_EXCEEDED before
  download. `upload:smoke` 28/28 (+6 YouTube: link forms, real oEmbed, submit, idempotency,
  concurrency, kill switch/plan, quota). `pipeline:smoke` 16/16 (+ activity shown/cleared, transfer meter). Typecheck + lint both
  apps; signed out, `POST /api/videos/youtube` → 401.

### Step 5 — Queue + worker + polling + recovery ✅ (2026-09-28)

- Design D35: web/ only writes `queued`; the worker's dispatcher (every 5 s) assigns a run
  id and adds BullMQ job `<videoId>-<runId>`. BullMQ 6.3 (worker only), queue
  `video-pipeline`, 3 attempts, 10 s exponential backoff; connection passed as options
  (BullMQ bundles its own ioredis).
- Worker: `pipeline/run.ts` (claim queued→processing or resume same run; every write
  guarded on runId + processing → RunLostError; heartbeat 30 s; progress writes ≤1/3 s and
  ≥2 %), `processors/pipeline-processor.ts` (skips done stages, retry policy, fail with a
  user-safe error, scratch folder per job), `pipeline/dispatcher.ts` (dispatch + stuck
  recovery), `pipeline/stages/` (registry; `ingest` = Step 5 version: source still in
  Cloudinary with audio), `lib/presence.ts` (Redis `worker:<id>:heartbeat`, 60 s TTL),
  `lib/loop.ts`, `lib/redis.ts`. Startup clears stale scratch folders; SIGINT/SIGTERM stop
  the loops, finish the current job, then close.
- Shared: `pipeline.ts` (QUEUES, job payload v1, `newRunId`, STAGE_WEIGHTS,
  `overallProgress`, PIPELINE_TIMING, WORKER_PRESENCE); errors `PROCESSING_STALLED`,
  `STAGE_NOT_READY`; `pipeline.recoveries` on videos; system settings
  `processingEnabled` (kill switch) and `workerConcurrency` (1).
- Web: `GET /api/videos/:id` (progress view, ~1 KB, no-store), `POST /api/videos/:id/retry`
  (failed + retryable only; same quota/concurrency rules; new run id; done stages kept).
  TanStack Query 5 added (`components/providers.tsx`); `VideoProgress` polls 2 s → 5 s after a
  minute, stops when finished, refreshes the page on status change, shows Try again.
  Admin overview: Worker & queue card (workers online, waiting/active/retrying/failed).
- Fix: New video card's progress panel disappeared mid-upload (Base UI Tabs drops the
  selection when every tab is disabled) — Tabs is now controlled.
- Until Steps 6–12 exist, a run does ingest and then stops at "Extracting audio" with
  STAGE_NOT_READY ("isn't available yet") — expected; Try again after the next step.
- **Verified:** `npm run pipeline:smoke` 14/14 (real Redis with its own prefix + throwaway DB:
  dispatch once, pause switch, ready path, not-ready stage, no-retry error, retry then fail,
  resume skips done stages, stale job skipped, zombie guard, cancel mid-run, stuck recovery
  and limit, real BullMQ worker with one retry). `upload:smoke` 22/22 (+3 retry checks).
  Ingest check read-only against the real queued upload (found, audio) and a missing id
  (null). Worker boots against a throwaway DB and publishes presence. Web typecheck + lint,
  worker typecheck. Signed out: GET progress and POST retry → 401.

### Step 4 — Upload ✅ (2026-09-28)

- Probed the real Cloudinary account first: dynamic folders, one signature valid for every
  chunk, `authenticated` files 404 without a signed URL, Admin API gives duration/audio only
  with `media_metadata: true`. Design recorded as D34; quota period rule as D33.
- `lib/uploads/cloudinary-core.ts` (ticket, inspect, delete, signed URLs), `lib/uploads/rules.ts`
  (size / length / minutes-left / concurrency), `lib/uploads/client-upload.ts` (browser: read
  duration, 6 MB chunks via XHR with progress, 3 attempts per chunk, cancel),
  `lib/videos/upload-service.ts` (requestUpload → finalizeUpload → deleteVideo),
  `lib/videos/schemas.ts` (zod bodies, client-safe imports only).
- API: `POST /api/uploads` (ticket), `POST /api/videos` (finalize; 201 new / 200 repeat),
  `DELETE /api/videos/:id` (soft delete, cancel if active, delete file). All authenticate
  before reading the body.
- UI: New video card works end to end (drag & drop, client checks, progress with time left,
  cancel, leave-page warning, errors inline); `/videos` (My videos) and `/videos/[id]`
  (source player, stage list, transcript placeholder, delete with confirmation). Sidebar has
  My videos; usage uses the current quota period.
- Shared: `ACTIVE_VIDEO_STATUSES`, `PERMISSION_TERMS_VERSION`, `quotaPeriodEnd`,
  `minutesUsedThisPeriod`, `billableMinutes`; errors `NOT_A_VIDEO`, `UPLOAD_NOT_FOUND`.
- New videos are created `queued` with no job yet — Step 5's worker picks them up.
- **Verified:** `npm run upload:smoke` 19/19 against real Cloudinary (own `smoketest/` folder,
  cleaned) and a throwaway DB — 2-chunk upload, idempotent finalize, cross-user claim
  refused, no-audio and too-long files rejected by Cloudinary's numbers and deleted, delete
  frees the slot. Web typecheck, lint, build; worker typecheck; shared:check; auth:smoke
  19/19. Signed out, all three APIs answer 401 and /videos redirects to sign-in.

### Step 3.5 — UI design + foundation ✅ (2026-09-28)

- Mockup canvas with 7 screens (link in docs/DESIGN.md). Rahat asked for UI copy in English
  everywhere (D32); mockup and code follow that.
- shadcn/ui 4.21 init (`base-nova`, Base UI primitives, `cn` package) + card, badge, input,
  label, separator, skeleton, table, tabs, checkbox, progress, sonner, tooltip, select.
- `globals.css` rewritten as the Cutroom token set (dark only); fonts via `next/font`
  (Bricolage Grotesque, Geist, Geist Mono, Hind Siliguri); Clerk themed via
  `lib/clerk-appearance.ts`; Toaster + TooltipProvider in the root layout.
- New: `components/brand` (Logo, AuthShell), `components/app` (AppSidebar, MobileHeader,
  StatusBadge, NewVideoCard — UI only, submit disabled until Step 4),
  `components/marketing/hero-visual.tsx`, `lib/video-labels.ts`, `formatDuration` / `fromNow`.
- `/dashboard` moved into the `(app)` route group with a shared shell layout. The dashboard
  lists the user's real videos (`ownedBy`, newest 8) with status, stage, clip count, expiry.
- Landing rebuilt; its pricing numbers come from the `limits` / `retention` settings.
  Sign-in/up, blocked and admin (layout + overview) restyled.
- **Verified:** typecheck, lint and production build pass; the prod server renders `/` and
  `/blocked` without errors and shows settings-driven pricing (100 MB, 7 days).

### Step 3 — Clerk auth + admin bootstrap ✅ (2026-09-28)

- `@clerk/nextjs` 7.9.7 (Clerk Core 3 — `<Show>` replaces SignedIn/SignedOut; provider
  inside `<body>`). `src/proxy.ts`: Clerk on all pages + API; signed-out visitors to
  `/dashboard`, `/admin` → our `/sign-in`.
- `src/lib/auth/`: lazy Clerk → `users` sync (D28: one Clerk call + one write per user per
  15 min, race-safe upsert), ADMIN_EMAILS bootstrap (verified primary email only, never
  demotes, audited as `user.admin.bootstrap`), sign-ups switch, suspension + maintenance
  rules (admins bypass maintenance). Guards: `requireUser/requireAdmin` (API → JSON
  401/403) and `requireUserPage/requireAdminPage` (redirect / `/blocked` / 404).
- `apiRoute()` wrapper → `{ error: { code, message, retryable } }`; raw errors never leak.
- Pages: `/` (landing), `/sign-in`, `/sign-up`, `/dashboard` (plan + limits),
  `/blocked`, `/admin` (shell + overview: user/video counts, settings versions, recent
  audit). `GET /api/me`. New error code `SIGNUPS_DISABLED`. `ADMIN_EMAILS` in env schema.
- `npm run typecheck` now runs `next typegen` (route types for `PageProps`/`LayoutProps`).
- **Verified:** `npm run auth:smoke` 19/19 on real Atlas (throwaway DB, dropped); web
  typecheck + lint + build pass; `npm run check` 4/4; worker typecheck + shared:check pass.
  Production server, signed out: `/api/me` → 401 JSON, `/dashboard` and `/admin` → 307 to
  `/sign-in?redirect_url=…`, `/blocked?code=<unknown>` shows only the generic message.
- **Browser test (Rahat, 2026-09-28):** signed up with the owner email on `localhost:4000` →
  dashboard shows the Admin link; DB has `role: admin` + one `user.admin.bootstrap` audit entry.
- Dev server port changed to **4000** (`npm run dev` / `npm run start`).

### Step 2 — Database layer ✅ (2026-09-28)

- Design: `docs/SCHEMA.md`, `docs/ADMIN.md` (researched Atlas free limits, Mongoose 9
  breaking changes, Groq Whisper limits before writing code).
- `shared/src/`: 9 models (users, videos, transcripts, analysis_runs, clips, renders,
  usage_events, settings, audit_logs), enums, `AppError` + codes, NFC text setter,
  `ownedBy()`, settings zod schemas + cached service with optimistic versioning + audit,
  `effectiveExpiry`/`isExpired`/`expiryCandidatesFilter`, `effectivePlanLimits`,
  migration `0001-seed-settings`.
- `scripts/sync-shared.mjs` (+ `--check`); hooked into `predev`/`pretypecheck` of both apps.
- Worker: `lib/db.ts`, `lib/shutdown.ts`, `lib/migrations.ts`; scripts `migrate`,
  `db:indexes`, `db:smoke`. Web: `lib/db.ts` (serverless-cached).
- **Verified:** smoke test 28/28 on real Atlas (throwaway DB, dropped); dev DB migrated
  (4 settings docs) and all 30 indexes created; worker boots and reads settings v1;
  web typecheck + lint + build pass.
- Findings: zod 4 `.default({})` doesn't fill nested defaults → `.prefault({})`;
  Groq no longer serves llama-3.3-70b → fallback is `openai/gpt-oss-120b`; Mongoose 9
  infers nested paths as nullable and rejects mistyped filters at compile time.

### Step 1 — Project skeleton ✅ (2026-09-28)

- `web/`: `create-next-app@16.3.6` (TS, Tailwind 4, ESLint, App Router, `src/`,
  `@/*` alias). Added zod 4, mongoose 9, ioredis 6, cloudinary 2, `@next/env`,
  `server-only`, tsx. `.gitignore` fixed so `.env.example` is committed.
- `web/src/lib/env.schema.ts` (zod rules, script-safe) + `env.ts` (`server-only`, throws at boot).
- `worker/`: ESM + TS 5.9 run via tsx. `src/config/env{,.schema}.ts` (loads `.env.local`
  with Node's built-in `process.loadEnvFile`), `src/lib/logger.ts` (pino), `src/index.ts`
  (boot, scratch dir, graceful-shutdown hooks; no queues yet).
- `npm run check` in both: validates env (one message per variable, never prints
  values) then pings each service. Worker also checks Groq lists `whisper-large-v3`,
  which Gemini Flash models exist, FFmpeg has libass + HarfBuzz, and the scratch dir
  is writable and not on C:. Local-tool checks run even when keys are missing.
- Verified: both typecheck clean; worker local checks 4/4 ✓; git ignores both
  `.env.local` files. git initialised on `main`, **nothing committed yet**.
- Folder renamed from the planned `app/` to `web/` (avoids `app/src/app/`).
- **All green:** `web` check 4/4, `worker` check 9/9, worker boots, `web` production build passes.

### Step 0 — Environment setup ✅ (2026-09-28)

- FFmpeg n8.1.3 (BtbN GPL build) → `D:\tools\ffmpeg\bin` — has libass, HarfBuzz,
  freetype, fribidi, fontconfig, x264.
- yt-dlp 2026.08.19 → `D:\tools\bin`. Both added to the **user** PATH.
- npm cache moved to `D:\tools\npm-cache` (C: SSD is nearly full).
- **Bangla caption test:** the `subtitles` filter renders যুক্তাক্ষর broken. The `ass`
  filter with `shaping=complex` renders everything correctly. Test files kept in
  `D:\tools\_dl\fonttest\`.
- Accounts created: Groq, Google AI Studio, Cloudinary, Clerk, MongoDB Atlas, Redis Cloud.
- Decided against Docker/WSL2/Python locally — see DECISIONS.md.

## Known issues / follow-ups

- Orphan uploads (ticket used, never finalized) stay in Cloudinary until the Step 17
  cleanup job exists. Low volume while in dev.
- Upload endpoints aren't rate-limited yet (Step 17).
- YouTube downloads in dev run at your connection's speed (~0.5 MB/s): test with short
  videos. A 720p hour is ~0.5–1 GB.
- Deleting a video while its audio is uploading can leave that audio file behind — the
  Step 17 cleanup job must also sweep `<folder>/audio/` for videos that no longer exist.
- Render quality (Step 12): a 9:16 crop of a 720p source is 405×720, upscaled. Decide then
  whether YouTube should download 1080p.
- Hugging Face Docker image (Step 18) needs yt-dlp (with its EJS component) and ffmpeg.
- Groq fallback (`openai/gpt-oss-120b`) is unstable on the clips:smoke story: 3 runs gave
  L6–L13, L6–L9 (missed the payoff) and L9–L11 (missed the setup). Gemini is the primary;
  look at this in Step 11 with the eval set.
- Snapping (D41) can end a clip on "and" when the speaker pauses there (commentary). A
  per-language "don't end on a connector" rule could follow with the eval set.

- Keys filled and verified 2026-09-28 (Cloudinary cloud `dpmpbnnpm`, Redis `noeviction`).
- Retention decision revised 2026-09-28: admin changes apply to **old and new** videos
  (computed expiry, 24 h grace, impact preview) — `docs/SCHEMA.md` §8.
- **Rotate all keys before launch** — they were pasted into a chat on 2026-09-28.
- Gemini key uses the newer `AQ.` format (works with `x-goog-api-key`); schema no longer
  requires `AIza`. Available Flash models go up to `gemini-3.8-flash` — pick the clip
  selection model with the eval set, not by version number. Step 9 kept `gemini-2.5-flash`
  (fast, answers reliably on free tier; D39) until the eval set can compare models.
- Whisper's Bangla spelling has slips ("আনন্দো", "দোয়"). Clip selection reads meaning, so
  it's fine for Steps 9–11; captions (Step 12) show this text — consider an LLM spelling
  pass or the transcript editor before launch.
- **Gemini free tier (2026-09-30):** per model. 2.5-flash = 20 requests/day (Google's 429);
  other Flash ≈ 20 and Flash-Lite ≈ 500 are third-party figures — confirm the project's real
  limits at https://ai.dev/rate-limit (D43). The fallback chains spread work over several models;
  `dailyCaps.geminiRequests` (200) is our overall ceiling. For launch volume: a paid key,
  or Mistral / OpenRouter as extra providers (Rahat's accounts needed).
- ~~**Bangla transcription quality (found 2026-09-29):**~~ Solved by D42 (2026-09-30). on a Bangla drama with background
  music Whisper gave mostly nonsense words and skipped 0:29–0:51 of dialogue; Gemini
  2.5 Flash, given the same audio, wrote clean, correctly spelled Bangla (dialect, English
  words, [music] marks) — also clearly better on the podcast fixture ("আনন্দও", "দোয়া").
  `gemini-3.5-transcribe` also works (text only). Gemini gives no word timestamps, which
  captions and cutting need. Candidate design: Gemini for the TEXT, Whisper for the TIMING
  (align Gemini's words onto Whisper's word times), or Gemini per chunk with line times +
  silence detection. Decide with Rahat before Step 12 (captions).
- Old npm cache still on C: (`C:\Users\HP\AppData\Local\npm-cache`) — safe to delete
  to reclaim space (`npm cache clean --force` won't touch it now that the cache moved;
  delete the folder manually).
