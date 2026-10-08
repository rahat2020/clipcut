# worker/ — background job processor

Project-wide rules are in `../CLAUDE.md`. This file covers `worker/` only.

Node 22 + TypeScript run through **tsx** (dev and production — no build step).
Consumes BullMQ jobs from Redis, runs FFmpeg/yt-dlp, calls Groq and Gemini, uploads
results to Cloudinary, and records every state change in MongoDB.
Deploys to a Hugging Face Space as a Docker image (Step 17).

## Layout

```
src/index.ts              entry: BullMQ worker + dispatcher loops + presence; graceful shutdown
src/config/env.ts         validated env — import { env } from "./config/env"
src/config/env.schema.ts  zod rules + loadEnvFile() (no side effects; scripts import it)
src/lib/logger.ts         pino (pretty in dev, JSON in prod, secrets redacted)
src/lib/db.ts             connectDb() — one long-lived connection, pool 10, closes on shutdown
src/lib/shutdown.ts       onShutdown(hook) registry (index.ts runs it on SIGINT/SIGTERM)
src/lib/migrations.ts     runMigrations() / migrationStatus() with a lock document
src/lib/redis.ts          bullConnection() options for BullMQ · redis() client for our own keys
src/lib/presence.ts       worker:<id>:heartbeat in Redis (admin panel reads it)
src/lib/indexes.ts        assertUniqueIndexes() — at boot in production: a missing unique index (the charge ledger!) stops the worker
src/lib/loop.ts           every(name, ms, task) — non-overlapping background loop
src/queues/pipeline-queue.ts  queue + job options (3 attempts, 10 s backoff) · enqueueRun()
src/pipeline/dispatcher.ts    queued videos → BullMQ (every 5 s) · stuck-run recovery (every 60 s)
src/pipeline/run.ts           claimRun() · PipelineRun: guarded writes, heartbeat, stage lifecycle
src/pipeline/stages/          one file per stage + index.ts registry (missing = STAGE_NOT_READY)
src/processors/pipeline-processor.ts  job → stages in order, skip done, retry policy
src/services/storage/cloudinary.ts    SDK · inspectSourceVideo · downloadPrivateFile · uploadPrivateAudio
src/services/media/     ffprobe.ts (probeMedia) · audio.ts (extractAudio, bitrate rule) · ytdlp.ts
src/lib/exec.ts         runTool(bin, args, {timeoutMs, signal, onStdoutLine}) — the ONLY way to run tools
src/lib/transfer.ts     TransferMeter — speed + time left for downloads (→ run.reportActivity)
src/pipeline/source.ts  ensureSource(ctx) — local source file, downloaded if this job doesn't have it
src/pipeline/limits.ts  limitsFor(video) · assertLengthAllowed() on the real length
src/pipeline/usage.ts   chargeMinutes() — once per video, ledger first, period rollover
src/services/transcription/  groq.ts (Whisper call) · normalize.ts (pure clean-up, tested)
src/services/ai/daily-caps.ts  reserveDailyCap() — Redis counters vs settings.ai.dailyCaps
src/services/ai/llm.ts   generateJson() — the LLMProvider: retries, fallback chain, caps (gemini.ts, groq-chat.ts)
src/services/clips/      lines.ts (transcript → numbered lines) · prompt.ts (versioned prompts) · moments.ts (lines → clips)
src/lib/backup.ts       writeBackup / readBackup / restoreBackup (gzip Extended JSON) · src/backup/ storage.ts (Cloudinary) + schedule.ts (daily)
src/cleanup/            cleanup.ts (sweeps: abandoned, deleted, expired, purge, orphans) · schedule.ts (kill switch + Redis lock)
src/services/storage/cleanup-storage.ts  deleteVideoFiles() / listStoredVideos() — Cloudinary, by prefix
src/shared/               GENERATED copy of ../shared/src — never edit here
scripts/migrate.ts, db-indexes.ts, db-smoke-test.ts, pipeline-smoke-test.ts
scripts/check-services.ts verify keys + local tools
.scratch/jobs/<jobId>/    per-job temp files (gitignored; cleared on startup) — never on C:
.scratch/fixtures/        test audio for transcribe:smoke (gitignored, kept)
```

Renders (Step 12, D45): `src/renders/` (claims, produce, dispatcher), `src/services/render/` (captions → ASS,
ffmpeg encode), `src/processors/render-processor.ts`; caption fonts in `assets/fonts/` (ship them in the Docker image).
Stage `copy` is a placeholder until Step 15. Models come from `src/shared/`.

Adding a stage: write `src/pipeline/stages/<name>.ts` (a `StageHandler`), register it in
`stages/index.ts`. Use `ctx.run.reportProgress(0..1)`, `ctx.run.signal`, `ctx.scratchDir`;
never write the video document except through `ctx.run` (it enforces the zombie guard).

## Rules

- ESM (`"type": "module"`), `moduleResolution: Bundler`, extensionless relative imports.
- Read config only through `env`; never `process.env` directly.
- **FFmpeg / ffprobe / yt-dlp:** `runTool(env.FFMPEG_PATH, [...args], { timeoutMs })` from
  `lib/exec.ts` only (spawn, shell: false). No string concatenation of user input into
  arguments; YouTube URLs are rebuilt from the validated id. Always a timeout and `run.signal`.
- **Bangla captions:** `ass=<file>:fontsdir=<dir>:shaping=complex`. Never `subtitles=`.
- Every job gets its own folder `path.join(env.SCRATCH_DIR, jobId)`, removed in `finally`.
- Steps are idempotent: check MongoDB for a completed stage before redoing it.
- Throw BullMQ `UnrecoverableError` for errors retrying can't fix (bad input, video too
  long, no audio) so attempts aren't wasted.
- AI decides WHAT (moments, copy); code decides HOW (timestamps, crop, encoding). The clip
  AI answers transcript line numbers, never times (D39). Call LLMs only via `generateJson`.
  Clip cuts come from `services/clips/snap.ts` (D41): rules are constants versioned `snap@N`;
  change them only with a new version, and check against real videos.
- Prompts are versioned (`clip-select@1`); never change a released version's wording — add
  a new version and point `settings.ai.clipSelection.promptVersion` at it.
  LLM output is validated with zod and clamped before it touches FFmpeg.
- Register cleanup with `onShutdown()` so SIGTERM finishes the current job cleanly.

## Commands

```
npm run dev         # tsx watch
npm run start       # production start
npm run check       # verify keys, ffmpeg (libass/HarfBuzz), yt-dlp, scratch dir
npm run typecheck   # syncs shared, then tsc --noEmit
npm run migrate     # apply pending migrations (-- --status to list)
npm run db:indexes  # create missing indexes
npm run db:smoke    # 29 DB checks in a throwaway database (incl. the missing-unique-index guard)
npm run pipeline:smoke # 19 queue/pipeline checks (incl. AI-quota wait, charged-once minutes): real Redis (own prefix) + throwaway DB
npm run media:smoke    # 11 ingest/audio checks: real ffmpeg, yt-dlp, YouTube, Cloudinary smoketest/
npm run transcribe:smoke # 15 checks: Gemini pieces (D42), Whisper fallback, charging; needs .scratch/fixtures (PROGRESS Step 7)
npm run clips:smoke    # 24 checks: clip rules, snapping, loudness (ffmpeg), real Gemini/Groq, analyze stage, admin re-run, Find new clips (fake AI)
npm run render:smoke   # 20 checks (incl. cover frames, key-word colour, hook, auto zoom by PSNR): captions/ASS, encode (Bangla captions, 60→30 fps), YouTube section, render stage + queue + stuck sweep
npm run backup:smoke   # 5 checks: backup/restore round trip, damaged files refused, real Cloudinary upload/download
npm run db:backup      # whole database → D:\backups (-- --cloud also uploads); db:restore -- <file> --into <db> (never the live DB)
npm run cleanup:smoke  # 8 checks: the cleanup job with a fake Cloudinary (expiry, grace, retry, purge, orphans, guards)
npm run cleanup:run    # dry run of the cleanup on the real data; -- --apply deletes, -- --orphans scans Cloudinary
npm run copy:smoke     # 12 checks: post text + cover ideas + key words (copy@4) (cleaning, prompt, real Gemini), cover-only rewrite, Banglish (alignment, real Gemini), copy stage with a fake AI
```
