# AI Video Shorter — project guide for Claude

Bangla-first SaaS that turns one long-form video (upload or YouTube URL) into short
9:16 clips with burned captions, AI-picked moments, and AI-written titles/hooks.

**Before doing anything, read `docs/PROGRESS.md`** — it says which step we are on.
Why each decision was made: `docs/DECISIONS.md`. System design: `docs/ARCHITECTURE.md`.
Database design and schema-change rules: `docs/SCHEMA.md` — read before touching models.
Admin panel spec: `docs/ADMIN.md`. UI design rules and tokens: `docs/DESIGN.md`.

## Who I'm working with

Rahat, solo founder. Talk to him in Bangla (technical terms in English). He wants
trade-offs explained and a clear recommendation, not a list of options. Goal is a
revenue startup, so correctness and simplicity beat cleverness.

## Layout — two independent projects, NOT a monorepo

```
web/      Next.js 16 app: UI + API routes      → deploys to Vercel
worker/   Node + BullMQ + FFmpeg job processor  → deploys to Hugging Face Spaces (Docker)
shared/   models, settings, enums, errors, retention/limits rules, migrations — SOURCE ONLY
scripts/  sync-shared.mjs (copies shared/src → web/src/shared + worker/src/shared)
docs/     PROGRESS, DECISIONS, ARCHITECTURE, SCHEMA, ADMIN, DESIGN, SETUP
```

`web/` and `worker/` each have their own `package.json`, `node_modules`, and `.env.local`.
No npm workspaces. Each has its own `CLAUDE.md`.

### Shared code — edit `shared/src/` only

- `web/src/shared/` and `worker/src/shared/` are **generated copies** (header says so).
  Never edit them; edit `shared/src/`, then run `node scripts/sync-shared.mjs`.
- `npm run dev` / `npm run typecheck` in web and worker sync automatically.
  `tsx watch` does NOT watch `shared/` — re-run the sync after editing shared code.
- `npm run shared:check` fails if a copy was edited by hand or is stale.
- Copies (not an npm link) so each app resolves one Mongoose instance (docs/SCHEMA.md §9).
- Imports inside `shared/src` are relative and extensionless; no path aliases.
- Import shared code as `@/shared` in web, `../shared` (relative) in worker.

## Product priorities (in order)

1. **Clip selection accuracy** — the differentiator. Gemini sees the whole transcript
   at once (no chunking); code snaps clip boundaries to sentence ends and silences.
2. **Bangla correctness** — transcription, captions, and AI copy must work in Bangla.
3. Everything else is table stakes; keep it simple.

## Locked stack

| Area | Choice |
|---|---|
| Frontend + API | Next.js 16 (App Router, `src/`), React 19, Tailwind 4 |
| UI | shadcn/ui on **Base UI** (`base-nova`), lucide icons, sonner — "Cutroom" theme (`docs/DESIGN.md`) |
| Client state | TanStack Query (server state) + Zustand (UI state) |
| Forms | react-hook-form + zod 4 |
| Dates | **dayjs** (+ duration, relativeTime plugins) |
| Auth | Clerk Core 3 (`@clerk/nextjs` 7) + our own `users` collection keyed by `clerkId` (lazy sync, D28) |
| DB | MongoDB Atlas M0 via Mongoose 9 — used in dev too |
| Queue | Redis Cloud free (eviction policy **must** be `noeviction`) + BullMQ 6 |
| Storage | Cloudinary free — 100 MB max per video file |
| Transcription | Bangla text: **Gemini, piece by piece** (audio cut at pauses; D42). English + fallback: **Groq `whisper-large-v3`** (word timestamps) |
| Clip AI | **Gemini 2.5 Flash** → fallback chain of more Gemini models (own quotas) → Groq, behind an `LLMProvider` interface (D43) |
| Video | FFmpeg n8.1 (`D:\tools\ffmpeg\bin`), yt-dlp (`D:\tools\bin`) |
| Reframe | Center crop + user-adjustable horizontal offset (no face tracking in MVP) |
| Realtime | Polling (`GET /api/videos/:id` every 2s) — Vercel can't hold SSE open |
| Cost | $0/month, no credit card anywhere |

## Do NOT suggest

- pnpm / yarn / Turborepo / npm workspaces / monorepo → **npm, two separate projects**
- date-fns / moment → **dayjs**
- fluent-ffmpeg → our own `execFile` wrapper
- Local LLMs (Ollama) or local Whisper → hosted Groq/Gemini (16 GB RAM, no GPU)
- Python anywhere, MediaPipe, OpenCV → not in MVP
- Docker Desktop / WSL2 for local dev → C: SSD has ~15 GB free; cloud DBs instead
- Redux → Zustand + TanStack Query
- Express server → Next.js API routes (API must run on Vercel free tier)
- TypeScript 7 → pinned to TS 5 until Next.js/ESLint support it
- Long-running work inside an API route → always enqueue a BullMQ job

## Always

- **FFmpeg / yt-dlp:** binary + args array via `runTool()` (`worker/src/lib/exec.ts`, spawn with
  `shell: false`) — never a shell string, never `exec`.
- **Bangla captions:** use the `ass` filter with `shaping=complex`
  (`-vf "ass=captions.ass:fontsdir=fonts:shaping=complex"`). The `subtitles` filter
  has no shaping option and renders যুক্তাক্ষর broken. FFmpeg exits 0 either way.
- **Paths:** `path.join()` / `path.resolve()`; never hardcode `\` or `/`. Dev runs on
  Windows, production runs on Linux.
- **Nothing on C:.** Scratch files go in `worker/.scratch/`; npm cache is `D:\tools\npm-cache`.
- **Errors:** throw `AppError` with a stable `code`; never show raw errors to users.
- **Config:** every env var goes through the zod schema in `env.ts`; missing → crash at boot.
- **Secrets:** only in `.env.local` (gitignored). Never ask Rahat to paste keys into chat.
- **Status of truth is MongoDB, not Redis.** Redis Cloud free has no persistence. web/ only
  writes `status: "queued"`; the worker's dispatcher enqueues it and restarts stuck runs (D35).
- **Language is a parameter** (`'bn' | 'en'`), never hardcoded.
- **UI copy is English** everywhere (D32). Bangla only as the spoken-language option and in
  users' own content, rendered with `lang={video.language}`.
- **Colors only from theme tokens** (`web/src/app/globals.css`) — no hex values in components.
- **Tunable behaviour comes from the `settings` collection** (AI models, caps, limits,
  retention, kill switches), never hardcoded and never env. Secrets stay in env and are
  never stored in or shown by `settings` / the admin panel.
- **Admin actions:** server-side role check from our DB → validate → act → `audit_logs`.
  No raw database editing features.
- **DB writes:** targeted `updateOne` + `$set`/`$inc` only; include `pipeline.runId` in
  worker filters; media times are integer ms. See `docs/SCHEMA.md` §2 and §6.
- **Schema changes:** follow `docs/SCHEMA.md` §6 — additive changes need no migration;
  renames use expand–contract; migrations go in `shared/src/migrations/` (append to
  `MIGRATIONS`, never reorder), must be idempotent, and use the raw `db`, not models.
- **Settings:** read with `getSettings(group)` (60 s cache); write only with
  `updateSettings(group, value, { expectedVersion, actor })` — it validates, rejects stale
  versions, stamps retention `changedAt`, and writes the audit log.
- **Retention / limits:** always via `effectiveExpiry` / `isExpired` /
  `expiryCandidatesFilter` and `effectivePlanLimits` in shared — never re-implement.
- **Ownership:** every user-facing query spreads `ownedBy(user)` into its filter.
- **Which clips a video shows:** `visibleClipsFilter` / `isVisibleClip` (shared/clip-sets.ts) —
  current run + kept clips. Never filter on `currentAnalysisRunId` alone (D47).
- **Auth (web):** route handlers → `apiRoute()` + `requireUser()` / `requireAdmin()`; pages →
  `requireUserPage()` / `requireAdminPage()`. Roles and status come from OUR `users` document,
  never from Clerk metadata or `proxy.ts`. Every admin page and action calls the guard itself.
- **Mongoose 9 facts:** `strictQuery: "throw"` and `runValidators: true` are global
  (`configureMongoose()`); nested objects infer as nullable — use `?.`; no `next()` in
  middleware; `returnDocument: "after"` not `new: true`; `QueryFilter` not `FilterQuery`.
- **zod 4 fact:** nested object defaults need `.prefault({})` — `.default({})` does
  not fill inner defaults.
- After finishing a roadmap step, update `docs/PROGRESS.md`.

## Environment

- Windows 11, Git Bash + PowerShell. Node 22.15, npm 10.
- Tools on PATH: `ffmpeg`, `ffprobe` (`D:\tools\ffmpeg\bin`), `yt-dlp` (`D:\tools\bin`).
- No admin rights in Claude's shell. Internet is ~500 KB/s and sometimes stalls —
  run big downloads in the background with resume/retry.

## Database commands (run in `worker/`)

```
npm run migrate            apply pending migrations   (-- --status to list)
npm run db:indexes         create missing indexes (never drops; reports extras)
npm run db:smoke           29 checks against a throwaway <db>_smoketest database
npm run pipeline:smoke     19 queue/pipeline checks incl. AI-quota wait + charged-once minutes (real Redis, own prefix; throwaway DB)
npm run media:smoke        11 ingest/audio checks (real ffmpeg, yt-dlp, Cloudinary smoketest/)
npm run transcribe:smoke   15 checks: transcription, Gemini pieces + Whisper fallback, charging (real Groq + Gemini; fixtures in .scratch/fixtures)
npm run clips:smoke        24 clip-selection + snapping + "Find new clips" checks (real Gemini + Groq, ffmpeg; fake AI for requests; throwaway DB)
npm run render:smoke       20 render checks: captions (key-word colour, hook), auto zoom, ffmpeg encode, cover frames, YouTube section, pipeline + render queue (throwaway DB, Cloudinary smoketest/)
npm run copy:smoke         12 post-text + cover-idea + key-word + Banglish checks (2 real Gemini requests; fake AI for the copy stage; throwaway DB)
npm run cleanup:smoke      8 cleanup-job checks (fake Cloudinary, throwaway DB) · `npm run cleanup:run` = dry run on the real data (-- --apply deletes)
npm run backup:smoke       5 backup/restore checks (throwaway DBs, real Cloudinary smoketest/) · `npm run db:backup` (→ D:\backups) · `npm run db:restore -- <file> --into <db>`
```

## Git

One git repository at the root holding both projects. Commit only when Rahat asks.
