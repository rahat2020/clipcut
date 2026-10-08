# Database schema design

Status: **approved 2026-09-28** (retention 7 days for source + clips, applied retroactively;
admin panel added — see §3.9, §3.10, §8 and `docs/ADMIN.md`). Researched 2026-09-28.

This document decides what we store, where, and — most importantly — how the
schema can change and grow without downtime or data loss.

---

## 1. Constraints that shape the design

| Constraint | Source | Consequence |
|---|---|---|
| Atlas free tier: **0.5 GB** storage | Atlas docs | Big blobs (word timestamps, raw AI output) go to Cloudinary; Mongo stores pointers |
| Atlas free tier: **100 ops/sec** (reads + writes) | Atlas docs | Worker progress writes are throttled; polling reads are tiny and stop when done |
| Atlas free tier: **no automated backups** | Atlas docs | We need our own export script (Step 16) |
| Atlas free tier: 500 connections, 10 GB transfer / 7 days | Atlas docs | Small connection pools; small polling responses |
| Atlas free tier pauses after 30 idle days | Atlas docs | Harmless in dev; production always has traffic |
| Two apps deploy **separately** (Vercel, Hugging Face) | our architecture | Old and new code run side by side during deploys → changes must be backward-compatible |
| Redis Cloud free has **no persistence** | Redis dashboard | MongoDB is the source of truth for every job's state |
| Mongoose 9 / MongoDB driver 7 | installed | No `next()` in middleware; `returnDocument: 'after'`; `QueryFilter` type |
| Groq Whisper: 25 MB per file, URL input allowed | Groq docs | 60 min at 16 kHz mono ~32 kbps ≈ 14 MB → no audio chunking in MVP |
| Bangla-first | product | Language + script on every text field; Unicode normalisation rules |

---

## 2. Design principles

1. **MongoDB is the truth; Redis is only a delivery mechanism.** Every status, stage and
   result lives in Mongo. A lost Redis job can be rebuilt from Mongo.
2. **Every document carries `userId`.** Needed for authorization on every query, and it
   is the natural shard key if we ever outgrow one cluster.
3. **Media positions are integer milliseconds** (`startMs`, `endMs`, `durationMs`).
   No float seconds — no rounding drift between Whisper, snapping and FFmpeg.
   Wall-clock times are `Date` (UTC).
4. **Only targeted atomic updates** (`updateOne` + `$set` / `$inc`). Never
   `replaceOne`, `findOneAndReplace`, or saving a whole loaded document from the worker.
   This is what makes mixed-version deploys safe: code that doesn't know a new field
   never touches it.
5. **State changes are guarded.** Transitions use conditional updates, e.g.
   `updateOne({ _id, status: 'queued' }, { $set: { status: 'processing' } })`.
   If it matches 0 documents, someone else already moved it — do nothing.
6. **Bounded arrays only.** Anything that can grow without limit gets its own collection.
7. **Every AI output records its provenance** — provider, model, prompt version. Clip
   accuracy is our differentiator; we can't improve what we can't attribute.
8. **`schemaVersion` on every document** (see §6).
9. **Text is Unicode NFC-normalised on write, preserving ZWJ/ZWNJ** (U+200D/U+200C).
   Bangla conjunct forms like র‍্যা depend on them; stripping "invisible" characters
   silently breaks rendering and search.

---

## 3. Collections (MVP)

```
users ──┬─< videos ──┬─< transcripts        (versions: ASR, user edit, Banglish)
        │            ├─< analysis_runs ──< clips ──< renders
        │            └─ (counts, current pointers)
        ├─< usage_events                    (append-only ledger)
        └─< audit_logs                      (every admin action)
settings                                     (admin-tunable config: ai, limits, retention, system)
_migrations                                  (internal)
```

### 3.1 `users`

Created lazily on the first authenticated request (Clerk is the identity provider; we
own everything else).

| Field | Type | Notes |
|---|---|---|
| `clerkId` | string | **unique** |
| `email` | string | lowercased |
| `name`, `imageUrl` | string? | copied from Clerk, refreshed on login |
| `uiLocale` | `'bn' \| 'en'` | default `'bn'` |
| `defaultVideoLanguage` | `'bn' \| 'en'` | pre-fills the upload form |
| `role` | `'user' \| 'admin'` | admin panel access; see `docs/ADMIN.md` for how the first admin is created |
| `status` | `'active' \| 'suspended'` | suspended users can log in and download, but can't start new processing |
| `suspension` | `{ reason, at, byUserId }?` | |
| `plan` | string | `'free'` for now; limits for each plan live in `settings.limits` |
| `limitsOverride` | partial plan limits? | admin can give one user more minutes, bigger files, etc. |
| `quota` | `{ periodStart, minutesUsed }` | fast counter (the limit comes from plan + override); `usage_events` is the audit trail |
| `flags` | object | feature flags (`betaTester`, …) |
| `lastSeenAt`, `deletedAt` | Date? | |

Indexes: `{ clerkId: 1 }` unique · `{ email: 1 }` · `{ role: 1 }` · `{ createdAt: -1 }` (admin user list)

### 3.2 `videos`

One uploaded or linked source video and its processing state.

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId | |
| `clientRequestId` | string? | idempotency — a double-click can't create two videos |
| `title` | string | editable; defaults to file name / YouTube title |
| `language` | `'bn' \| 'en'` | **spoken** language, chosen by the user; corrected by the transcribe step when clearly wrong (D38) |
| `languageCheck` | `{ requested, detected[], switched, at }?` | result of that check |
| `source` | `{ type: 'upload'\|'youtube'\|'direct_url', url?, externalId?, originalFilename?, sizeBytes?, cloudinary?: { publicId, format, bytes }, oembed?: { title, authorName, thumbnailUrl } }` | |
| `permission` | `{ confirmedAt, ip?, userAgent?, termsVersion }` | legal record of "I own or have permission" |
| `media` | `{ durationMs, width, height, fps, hasAudio, videoCodec, audioCodec }?` | from ffprobe |
| `audio` | `{ publicId, format, bitrateKbps, bytes }?` | compressed audio sent to Groq |
| `options` | `{ intent, customQuery?, targetClipCount, minClipMs, maxClipMs, aspectRatio, captionStyleId, captionScript? }` | what the user asked for; `captionScript` `'Beng'\|'Latn'` = Bangla letters or Banglish for a Bangla video's captions and post text (Step 15, D48) |
| `status` | `'draft'\|'queued'\|'processing'\|'ready'\|'failed'\|'canceled'` | |
| `pipeline` | see below | |
| `error` | `{ code, message, stage, retryable, at }?` | user-safe message; details in logs |
| `currentTranscriptId`, `currentAnalysisRunId` | ObjectId? | pointers to the active versions |
| `clipRequest` | `{ status: 'pending'\|'done'\|'no_moments'\|'failed', intent, query?, requestedAt, finishedAt?, analysisRunId?, errorCode?, previousStages?: { analyze, copy, render } }?` | the user's latest "Find new clips" (Step 14, D47). `options.intent/customQuery` are updated with it; a failed or empty request leaves the current clips |
| `counts` | `{ clips, renders, clipRequests, copyRequests }` | denormalised for the list page; `clipRequests` = "Find new clips" used (plan limit `clipRequestsPerVideo`); `copyRequests` = post-text rewrites / Banglish switches (`copyRequestsPerVideo`) |
| `thumbnailUrl` | string? | |
| `retention` | `{ finishedAt?, expireOverrideAt?, assetsDeletedAt? }` | `finishedAt` = when processing ended (ready **or** failed). The expiry date is **not stored** — it is computed from the current settings every time (§8), so an admin change applies to old and new videos alike. `expireOverrideAt` = admin set this one video by hand. After deletion the video is **archived**: clips, titles and hooks stay visible, but nothing can be played, downloaded or re-rendered |
| `deletedAt` | Date? | soft delete |

`pipeline` is an **object keyed by stage name**, not an array — so the worker can update
one stage with a plain `$set: { 'pipeline.stages.transcribe.status': 'done' }` (no
`arrayFilters`):

```ts
pipeline: {
  runId: string,          // new value on every (re)process — see "zombie guard"
  jobId?: string,         // BullMQ id, for debugging only
  stage: 'ingest' | 'audio' | 'transcribe' | 'analyze' | 'copy' | 'render' | null,
  progress: number,       // 0..1 overall
  heartbeatAt?: Date,     // worker touches this while alive
  recoveries: number,     // stuck-run restarts; reset when the user retries
  waitUntil?: Date,       // queued video waiting for the AI's daily quota; dispatcher skips it until then (Step 17)
  quotaWaits: number,     // such waits so far (max PIPELINE_TIMING.maxQuotaWaits, then failed); reset on retry
  activity?: { kind, doneBytes, totalBytes?, bytesPerSec, etaSec?, at }, // live download info, ≤1 write / 5 s
  analyzeWith?: { provider, model, promptVersion, requestedBy, at }, // admin "pick clips again"; cleared when that run succeeds (D40)
  stages: {
    ingest:     { status, progress, attempts, startedAt?, finishedAt? },
    audio:      { … },
    transcribe: { … },
    analyze:    { … },
    copy:       { … },
    render:     { … },
  }
}
```

**Zombie guard:** every worker write includes `'pipeline.runId': myRunId` in its filter.
If the user retried and a new run started, an old worker that wakes up can't overwrite
the new run's state.

**Stuck-job recovery:** on startup and every minute the worker looks for
`status: 'processing'` with `pipeline.heartbeatAt` older than 2 minutes (heartbeat every
30 s) and puts them back to `queued` under a new run id, counting `pipeline.recoveries`;
after 3 it marks the video failed (`PROCESSING_STALLED`). Constants: `PIPELINE_TIMING`
in `shared/src/pipeline.ts`. This is what makes Redis's lack of persistence harmless.

Indexes:
- `{ userId: 1, createdAt: -1 }` — dashboard list
- `{ status: 1, 'pipeline.heartbeatAt': 1 }` — stuck-job recovery
- `{ userId: 1, clientRequestId: 1 }` unique, partial (only where `clientRequestId` exists)
- `{ 'retention.finishedAt': 1 }` — cleanup job finds candidates for expiry
- `{ status: 1, updatedAt: -1 }` — admin "failed in the last 24 h" view

### 3.3 `transcripts`

Versioned. The first version comes from Whisper; later versions come from user
corrections (transcript editor) or Banglish transliteration. Old versions are never
mutated, so clips always know exactly which text they were cut from.

| Field | Type | Notes |
|---|---|---|
| `videoId`, `userId` | ObjectId | |
| `version` | number | 1, 2, 3… per video |
| `kind` | `'asr' \| 'user_edit' \| 'transliteration'` | |
| `basedOnVersion` | number? | for edits/transliterations |
| `language` | `'bn' \| 'en'` | |
| `script` | `'Beng' \| 'Latn'` | ISO 15924 — Bangla script vs Banglish |
| `provider`, `model` | string | e.g. `groq` `whisper-large-v3`, or `gemini` `gemini-3-flash-preview` (Bangla, D42; `a+b` when batches used two models) |
| `wordTiming` | `'asr' \| 'estimated'`? | `asr` = word times from Whisper; `estimated` = spread over each piece's speech (Gemini text, D42). Missing on older transcripts = `asr` |
| `durationMs` | number | |
| `segments` | `[{ startMs, endMs, text, avgLogprob?, noSpeechProb? }]` | bounded (~1 per 3–6 s) |
| `words` | `{ publicId, url, count }` | word-level timestamps as JSON in Cloudinary |
| `raw` | `{ publicId }?` | untouched provider response, for reprocessing |
| `latnWords` | `Record<"<startMs>_<endMs>", string>`? | Banglish spelling of caption words inside clips (Step 15, D48); written key by key |
| `stats` | `{ wordCount, segmentCount, avgLogprob }` | |

`avgLogprob` / `noSpeechProb` are kept because they tell boundary snapping where the
speech is confident and where there's silence or noise.

Indexes: `{ videoId: 1, version: -1 }` unique

### 3.4 `analysis_runs`

One row every time the AI picks clips — first run, "give me more", or a natural-language
search ("find the funniest moments"). Old runs are kept.

| Field | Type | Notes |
|---|---|---|
| `videoId`, `userId`, `transcriptId` | ObjectId | |
| `kind` | `'initial' \| 'regenerate' \| 'search'` | |
| `input` | `{ intent, query?, targetClipCount, minClipMs, maxClipMs, excludeClipIds? }` | |
| `ai` | `{ provider, model, promptVersion, temperature }` | e.g. `promptVersion: 'clip-select@3'` |
| `status` | `'running' \| 'done' \| 'failed'` | |
| `usage` | `{ inputTokens, outputTokens, latencyMs }` | watch free-tier limits |
| `result` | `{ candidates, accepted }` | how many the AI proposed vs survived snapping |
| `rawResponse` | `{ publicId }?` | prompt + full model output + resolve stats in Cloudinary (`<folder>/analysis/<userId>/<videoId>/<runId>.json`), for debugging and evaluation |
| `error` | object? | |

Indexes: `{ videoId: 1, createdAt: -1 }`

**Why this exists in the MVP:** Steps 9–11 are about improving clip accuracy. Without a
record of which prompt and model produced which clips — and whether users kept them —
we'd be tuning blind.

### 3.5 `clips`

| Field | Type | Notes |
|---|---|---|
| `videoId`, `userId` | ObjectId | |
| `analysisRunId` | ObjectId? | null for manual clips |
| `origin` | `'ai' \| 'manual'` | |
| `rank` | number | 1 = best within its run |
| `startMs`, `endMs`, `durationMs` | number | **after** snapping |
| `ai` | `{ rawStartMs, rawEndMs, score, momentType, reason }?` | what the AI proposed **before** snapping — needed to evaluate snapping separately from selection |
| `snap` | `{ version, basis, startRule, endRule }?` | how the cut was made (D41). `version` `snap@1` or `lines` (whole-line times only; Step 9 clips have no version). `basis` `words+audio` · `words` · `segments+audio` · `segments` · `lines`. Rules: start `clean`/`earlier`/`later`/`soft`/`none`, end the same + `max_cut`; Step 9 clips: `line_start`/`extended` · `line_end`/`extended`/`trimmed`/`max_cut` |
| `transcriptText` | string | text inside the clip |
| `copy` | `{ title, description, hook, hashtags[], coverText?, coverOptions?[{text, highlight}], emphasis?[], language, script, model, promptVersion, writtenAt?, editedAt? }?` | hook is always labelled AI-written in the UI; written by the copy stage (D48), `editedAt` when the user changed it; `emphasis` = the clip's key words as `emphasisToken`s (copy@4+, D55) — caption second colour + auto zoom; unset → numbers are emphasised |
| `copyRedoAt` | Date? | user asked for new post text; the copy stage clears it |
| `coverRedoAt` | Date? | user asked for new cover words only ("Suggest words"); the copy stage rewrites `copy.coverText`/`coverOptions` and clears it |
| `edit` | `{ cropOffsetX, captionStyleId, captionScript, autoZoom?, aiStartMs?, aiEndMs? }` | user adjustments; `autoZoom` unset = on (D55); `cropOffsetX` in −1…1; `aiStartMs/aiEndMs` = the cut before the first trim (unset = never trimmed, D46) |
| `status` | `'suggested' \| 'approved' \| 'rejected'` | |
| `feedback` | `{ reason?, at }?` | why the user rejected it — accuracy signal |
| `signals` | `{ rendered, downloaded }` | implicit "this clip was good" labels |
| `latestRenderId` | ObjectId? | |
| `keptAt` | Date? | approved when a newer set replaced its run → still shown (D47; `shared/clip-sets.ts`) |
| `deletedAt` | Date? | |

Indexes: `{ videoId: 1, status: 1, rank: 1 }` · `{ analysisRunId: 1 }`

### 3.6 `renders`

One encoded MP4 for one clip with one set of settings.

| Field | Type | Notes |
|---|---|---|
| `clipId`, `videoId`, `userId` | ObjectId | |
| `spec` | `{ startMs, endMs, aspectRatio, width, height, cropOffsetX, captionStyleId, captionScript, burnCaptions, transcriptVersion, emphasis?[], autoZoom? }` | everything that affects the output pixels; `emphasis`/`autoZoom` from render@3 (missing on older renders = none / off) |
| `specHash` | string | SHA-256 of the normalised spec |
| `status` | `'queued' \| 'rendering' \| 'ready' \| 'failed'` | |
| `progress`, `attempts` | number | |
| `output` | `{ publicId, secureUrl, bytes, durationMs }?` | |
| `coverFrames` | string[] | public ids of 6 clean 9:16 JPEG frames (`<output id>-cover-<n>`, image assets) for the cover editor (D49); empty on older renders |
| `timings` | `{ queuedAt, startedAt?, heartbeatAt?, finishedAt?, encodeMs? }` | `startedAt` = the claim stamp every worker write filters on; `heartbeatAt` every 30 s while rendering (D45) |
| `assetDeletedAt` | Date? | set by the cleanup job when the MP4 is removed from Cloudinary |
| `error` | `{ code, message, detail? }?` | `message` is user-safe; `detail` = tool stderr tail for debugging, never shown |

Indexes: `{ clipId: 1, specHash: 1 }` **unique** — asking for the same render twice
returns the existing one instead of encoding again. · `{ videoId: 1 }` · `{ status: 1, "timings.queuedAt": 1 }` (render dispatcher)

Renders have no expiry of their own; they expire with their video
(see §8).

> Expiry is never a TTL index: TTL would delete the document but leave the MP4 in
> Cloudinary, orphaned and still using quota. A cleanup job deletes the asset first,
> then marks the document.

### 3.7 `usage_events` (append-only)

| Field | Type | Notes |
|---|---|---|
| `userId`, `videoId?` | ObjectId | |
| `type` | `'transcribe' \| 'render' \| 'ai_tokens'` | |
| `quantity`, `unit` | number, `'minutes' \| 'count' \| 'tokens'` | |
| `provider`, `model` | string? | lets us see how close we are to Groq/Gemini free limits |
| `idempotencyKey` | string | **unique** — e.g. `video:<id>:run:<runId>:transcribe`; retries can't double-charge |
| `at` | Date | |

Indexes: `{ userId: 1, at: -1 }` · `{ idempotencyKey: 1 }` unique ·
`{ provider: 1, at: -1 }` (admin AI-usage view)

The `users.quota` counter is the fast path; this ledger is the audit trail and the basis
for billing later. If they ever disagree, the ledger wins.

### 3.8 `_migrations` (internal)

`{ _id: '0003-add-clip-signals', appliedAt, durationMs }`

### 3.9 `settings` — everything the admin can change without a redeploy

One document per group. `_id` is the group name. Each group is validated by a zod schema
in `shared/`, and **code defaults apply for any missing value**, so the app still boots
on an empty database.

| `_id` | Holds |
|---|---|
| `ai` | per task (`transcription`, `clipSelection`, `copyWriting`): `{ provider, model, temperature, promptVersion, fallbacks[], enabled }` (`fallbacks` replaced the single `fallback` 2026-09-30, D43 — old stored values are read as a chain until the next save); `transcription.gemini` `{ languages, models, batchMinutes }` (D42) · `dailyCaps` — our own safety limits kept below each provider's free tier (e.g. Groq audio minutes/day, Gemini requests/day) |
| `limits` | per plan: `{ monthlyMinutes, maxFileMB, maxDurationMin, concurrentJobs, maxClipsPerVideo, allowYoutube }` — `maxFileMB` is capped at 100 in code (Cloudinary free) |
| `retention` | per plan: `{ days }` (free: 7 — source and clips together) · `graceHours` (24) · `changedAt` (set automatically when any `days` value changes) · `purgeSoftDeletedAfterDays` (30) |
| `system` | `maintenanceMode` + message · `uploadsEnabled` · `youtubeEnabled` (the YouTube kill switch — now a toggle, not an env var) · `signupsEnabled` |

Common fields: `version` (incremented on every save — two admin tabs can't silently
overwrite each other), `updatedBy`, `updatedAt`, `schemaVersion`.

**Secrets never go in `settings`.** API keys stay in `.env.local` / platform secrets.
The admin panel shows only whether each key is configured and whether it works.

**Reading settings:** web and worker cache each group in memory for 60 s, so an admin
change takes effect within a minute and settings cost almost nothing against the
100 ops/sec budget. The worker reads settings once at the **start** of each job, so a
job never changes models halfway through.

**Precedence:** env (secrets, infrastructure) → `settings` (tunable behaviour) → code defaults.

### 3.10 `audit_logs` — who changed what

| Field | Type | Notes |
|---|---|---|
| `actorUserId`, `actorEmail` | | the admin |
| `action` | string | `settings.update`, `user.suspend`, `user.limits.override`, `video.delete`, `job.retry`, … |
| `target` | `{ type, id }` | |
| `diff` | `{ before, after }?` | for settings and limit changes |
| `ip`, `userAgent` | string? | |
| `at` | Date | |

Indexes: `{ at: -1 }` · `{ 'target.type': 1, 'target.id': 1 }` · TTL on `at` after
365 days (safe here — audit logs have no external files).

### 3.11 Kept in Redis, not Mongo

Some admin numbers change every few seconds; writing them to Mongo would burn the
100 ops/sec budget.

| Key | Holds |
|---|---|
| `worker:<id>:heartbeat` (TTL 60 s) | "is the worker alive?", its version, current job |
| `ai:<provider>:<metric>:<YYYY-MM-DD>` (TTL 3 days) | today's usage counter, checked against `settings.ai.dailyCaps` before each AI call (format: `aiCapKey` in shared/src/ai.ts) |
| `ratelimit:admin:<userId>:<minute>` (TTL ~65 s) | admin actions per minute (30), web/src/lib/redis.ts |
| BullMQ's own keys | waiting / active / failed job counts |

If Redis restarts these reset to zero. For the daily caps that means the limit is
briefly less strict, which is acceptable; the `usage_events` ledger in Mongo is still
complete.

---

## 4. Not in the database

| Thing | Where | Why |
|---|---|---|
| Source video files, renders, audio | Cloudinary | binary; Mongo has 0.5 GB |
| Word-level timestamps | Cloudinary (raw JSON) | ~450 KB per hour of speech; only read at render time |
| Raw AI / Whisper responses | Cloudinary (raw JSON) | debugging and reprocessing only |
| Caption style presets | code (`shared/src/caption-styles.ts`) | a handful of constants; user brand kits come later |
| Eval set (hand-labelled best moments) | repo files under `eval/` | versioned together with the prompts it measures |
| Queue jobs | Redis (BullMQ) | payload is only `{ v, videoId, runId }` or `{ v, renderId }` |

---

## 5. Storage and throughput budget (Atlas free tier)

**Storage per processed 60-minute Bangla video (estimate):**

| Item | Size |
|---|---|
| `videos` doc | ~3 KB |
| `transcripts` segments (~700 × ~400 B, Bangla is 3 bytes/char in UTF-8) | ~280 KB |
| `analysis_runs` | ~2 KB |
| 15 `clips` × ~2 KB | ~30 KB |
| `renders`, `usage_events` | ~10 KB |
| **Total** | **~325 KB** |

→ roughly **1,500 hour-long videos** before 0.5 GB (shorter videos: proportionally more).
Transcript segments dominate; if space runs out first, move segments to Cloudinary too
and keep only `stats` in Mongo — the transcripts shape already allows it.

**Operations per second (limit 100):**
- Worker progress writes: at most **1 per video per 3 s**, and only if progress moved
  ≥ 2 % (heartbeat still written every 30 s).
- Polling `GET /api/videos/:id`: one read with a projection (~1 KB), every 2 s,
  backing off to 5 s after a minute, **stopping** once status is terminal.
- ≈ 0.5 + 0.3 ops/s per actively processing video → **~100 videos processing at once**
  before the limit. Fine for beta; the upgrade path is in §7.

**Connections (limit 500):** web `maxPoolSize: 5` per serverless instance (connection
cached on `globalThis`), worker `maxPoolSize: 10`.

---

## 6. How the schema changes safely over time

### 6.1 Kinds of change

| Change | What to do | Migration? |
|---|---|---|
| Add an optional field / new collection | Add to schema with a default; readers treat "missing" as the default | No |
| Add a new enum value | Deploy **readers first** (they must handle unknown values with a default branch), then writers | No |
| Add a required field | Add as optional → backfill migration → make required | Yes |
| Rename / restructure a field | **Expand–contract** (below) | Yes |
| Add an index | Declare in schema; `npm run db:indexes` creates it | No |
| Remove an index / field | Explicit migration, only after no code reads it | Yes |

### 6.2 Expand–contract (for renames and restructures)

Because web and worker deploy at different times, both old and new code run against
the same data for a while. Never change a field in one step:

1. **Expand:** new code writes **both** old and new fields, reads new-with-fallback-to-old.
   Deploy both apps.
2. **Migrate:** backfill the new field on existing documents.
3. **Switch:** stop writing the old field. Deploy.
4. **Contract:** migration removes the old field.

### 6.3 `schemaVersion`

Every document gets `schemaVersion` (starts at 1). A migration that reshapes documents
bumps it, so code can tell old and new shapes apart and migrations can target only
`{ schemaVersion: { $lt: N } }` — safe to re-run, safe to run in batches.

### 6.4 Migration runner

- Files: `shared/migrations/NNNN-description.ts`, each exporting `up(db)`.
- `npm run migrate` (in `worker/`) runs unapplied ones in order and records them in
  `_migrations`. Every migration must be **idempotent**.
- Deploy order when a migration is involved: **migration → tolerant readers → writers.**

### 6.5 Indexes

- Development: Mongoose `autoIndex: true` (convenient).
- Production: `autoIndex: false` — otherwise every Vercel cold start re-checks every
  index. Indexes are created by `npm run db:indexes`, which only **creates** missing
  indexes (`createIndexes`); dropping an index is always a deliberate migration.

### 6.6 Queue payloads

Job data carries a version: `{ v: 1, videoId, runId }`. A worker that sees an unknown `v`
fails the job as unrecoverable instead of guessing.

---

## 7. Scaling path

| Stage | Trigger | Change | Schema impact |
|---|---|---|---|
| 0 — now | — | Atlas free tier | — |
| 1 | ~80 ops/s or ~400 MB | Paid Atlas tier (Flex or M10) + automated backups | none |
| 2 | storage pressure | Move transcript segments to object storage; archive videos older than N months | `transcripts.segments` becomes optional (already planned for) |
| 3 | teams / agencies | Workspaces (below) | migration adds `workspaceId` |
| 4 | millions of documents | Shard by hashed `userId` (or `workspaceId`) | none — every collection already has it |

**Workspaces (teams):** not in MVP. Every query goes through one ownership helper
(`ownedBy(user)` → `{ userId }`). When teams arrive, that helper returns
`{ workspaceId }` instead, a migration gives every user a personal workspace and
backfills `workspaceId`, and no route handler has to change.

**Future collections this design already leaves room for:** `workspaces`, `memberships`,
`brand_kits` (caption style ids are strings, so `preset:bold` and a brand-kit id can
coexist), `subscriptions` / `payments` (bKash, SSLCommerz), `social_accounts`,
`publications`, `api_keys`.

---

## 8. Retention and deletion (editable in the admin panel)

Decided 2026-09-28: **free plan keeps the source video and its clips for 7 days**, and
**changing the number in the admin panel applies to every video — old and new.**
Values live in `settings.retention` per plan.

| Asset | Free plan | Clock starts |
|---|---|---|
| Uploaded / downloaded source video (Cloudinary) | **7 days** | when processing ends (ready or failed) |
| Compressed audio, word timestamps, raw AI output | with the source | same |
| Renders (MP4) | **7 days** | same moment as the source — **not** from each render's own creation |
| Mongo documents | kept; soft-deleted ones purged after 30 days | — |

**Why one clock per video:** a clip can only be re-rendered while the source exists. If
renders had their own timer, a clip re-rendered on day 6 would outlive its source and
then be impossible to fix. So the whole video expires as one unit.

### How expiry is computed (never stored)

```ts
// shared/src/retention.ts — the only place this rule lives
effectiveExpiry(video, ownerPlan, settings) =
  video.retention.expireOverrideAt                           // admin set it by hand → wins
  ?? max(
       video.retention.finishedAt + settings.retention.plans[ownerPlan].days,
       settings.retention.changedAt + settings.retention.graceHours,   // safety net
     )
```

Because nothing is stored, changing `days` (or a user's plan) instantly moves the
expiry of every existing video. The UI, the API and the cleanup job all call this one
function, so they can never disagree.

**Cleanup job:** picks videos whose `finishedAt` is older than the *shortest* retention of
any plan (indexed), computes each one's effective expiry with the owner's current plan,
deletes the Cloudinary assets of those that are due, then sets `assetsDeletedAt`. Built in Step 17 (D51:
`worker/src/cleanup/`), which also retries failed user-deletes, soft-deletes abandoned drafts, purges
documents after `purgeSoftDeletedAfterDays` and scans for orphaned files.

### Safety nets for changes that affect old videos

1. **Impact preview before saving.** The admin sees e.g. *"Shortening 7 → 2 days will
   expire 143 existing videos (61 users). Earliest deletion: 29 Sep 14:00."* and must
   confirm by typing the new value.
2. **Grace period (default 24 h, admin can set 0).** No file is deleted sooner than
   `graceHours` after the setting changed, so users see the "expires soon" banner first.
   Implemented by the `max(…)` above.
3. **Lengthening can't restore deleted files.** Increasing `days` extends every video
   that still has its files; videos whose files are already gone stay archived. The
   admin preview says so.

**What the user sees:** "Available until 5 Oct" (computed live). A reminder banner
appears when less than 2 days remain. After expiry the video is **archived**: titles,
hooks, hashtags and transcript remain; play / download / re-render are disabled.

User deletes a video → hidden immediately, Cloudinary assets deleted by the cleanup job
right away, documents purged after 30 days.

**Backups:** the free tier has none. Step 16 adds `npm run db:backup` — a Node script that
exports every collection as gzipped Extended JSON to `D:\backups\` (no extra tools needed).

---

## 9. Sharing models between `web/` and `worker/`

Both apps read and write the same collections, so they must use identical schemas.

```
shared/                     ← the only place models are edited
  package.json              (mongoose + zod as devDependencies — editor types only)
  src/models/*.ts, enums.ts, errors.ts, queue-contracts.ts, caption-styles.ts
  migrations/
scripts/sync-shared.mjs     ← copies shared/src → web/src/shared and worker/src/shared
```

- The copies carry a `// GENERATED — edit shared/src instead` header and **are committed**,
  so each app builds on its own (Vercel and Hugging Face never need the sync script).
- `predev` and `pretypecheck` in both apps run the sync automatically; `--check` mode
  fails if a copy was edited by hand.
- **Why copy instead of a `file:../shared` npm dependency:** a linked package resolves
  `mongoose` from its own folder, so the app can end up with **two Mongoose instances** —
  models registered on one, the connection opened on the other, and queries hang with no
  error. Copied files resolve `mongoose` from the app that uses them, so there is exactly
  one instance.
- Connection helpers stay per app (web: serverless-cached; worker: long-lived).
- Models register with `mongoose.models.X ?? mongoose.model(...)` so Next.js hot reload
  doesn't throw `OverwriteModelError`.
- Reads that only display data use `.lean()`.

---

## 10. Decisions (answered by Rahat, 2026-09-28)

| # | Question | Decision |
|---|---|---|
| 1 | Workspaces (teams) now or later? | **Later**, behind the `ownedBy()` helper |
| 2 | Shared models: root `shared/` + copy script? | **Yes** (§9) |
| 3 | Retention for the free plan? | **Source and clips both 7 days** (§8), editable in admin; **changes apply to old and new videos** (with a 24 h grace period and an impact preview) |
| 4 | Keep `analysis_runs` + clip feedback signals in the MVP? | **Yes** |
| 5 | Admin panel? | **Yes** — `settings` + `audit_logs` collections, `users.role/status/limitsOverride`; spec in `docs/ADMIN.md` |
