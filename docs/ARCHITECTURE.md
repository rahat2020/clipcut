# Architecture

## System

```
                 ┌──────────────┐
                 │   Browser    │
                 └──┬────────┬──┘
   signed upload   │        │  REST + polling (every 2 s)
   (≤100 MB)       ▼        ▼
          ┌────────────┐  ┌───────────────────────────────┐
          │ Cloudinary │  │ web/  — Next.js 16 on Vercel   │
          └─────▲──────┘  │  UI + API route handlers       │
                │         │  Clerk auth                    │
                │         └──────┬───────────────┬─────────┘
                │                │ enqueue       │ read/write
                │                ▼               ▼
                │         ┌────────────┐   ┌──────────────┐
                │         │ Redis Cloud│   │ MongoDB Atlas│
                │         │  (BullMQ)  │   │  (truth)     │
                │         └──────▲─────┘   └──────▲───────┘
                │                │ consume        │ status, results
                │         ┌──────┴────────────────┴───────┐
                └─────────│ worker/ — Hugging Face Space   │
                 upload   │  Node + BullMQ + FFmpeg        │
                 renders  │  yt-dlp                        │
                          └───────┬───────────────┬────────┘
                                  ▼               ▼
                            Groq Whisper      Gemini 2.5 Flash
                            (transcribe)      (pick clips, write copy)
```

The worker only makes outbound connections, so it needs no public URL.

## Request flow — "process this video"

1. Browser asks `web` for a Cloudinary upload signature (size/type/quota checked server-side).
2. Browser uploads the file straight to Cloudinary. The 100 MB never touches our servers.
3. Browser calls `POST /api/videos` with the Cloudinary result + permission confirmation.
4. `web` writes a `videos` document (`status: queued`). The worker's dispatcher sees it within
   ~5 s, gives it a run id and adds a BullMQ job (D35 — web never touches the queue).
5. Worker runs the pipeline, writing stage + progress to MongoDB as it goes.
6. Browser polls `GET /api/videos/:id` and renders the stage list.
7. Finished clips are Cloudinary URLs stored on `clips` / `renders` documents.

For YouTube: step 1–2 are replaced by an oEmbed pre-check in `web`; the worker
downloads with yt-dlp (≤1080p, `system.render.youtubeMaxHeight`) and verifies duration.

## Worker pipeline

| Stage | What happens | Output |
|---|---|---|
| ingest | YouTube: yt-dlp info → reject live/private/too long; download source to `.scratch/<jobId>/`, `ffprobe`, gate on duration/audio/minutes | `media` on video doc |
| audio | `ffmpeg -vn -ac 1 -ar 16000 -c:a libopus` (bitrate fits Groq's 25 MB) | private audio in Cloudinary, `audio` on video doc |
| transcribe | language check (Whisper samples, D38) → Bangla: audio cut into 3–15 s pieces at pauses, Gemini writes each piece's text (~10 min per request), word times estimated (D42); English or Gemini failing: Groq `whisper-large-v3` with word timestamps | `transcripts` doc |
| analyze | Gemini gets the **whole** transcript as numbered lines → answers line ranges (D39); code fits length, drops overlaps, ranks | `analysis_runs` row + `clips` docs |
| snap (inside analyze, D41) | loudness of the stored audio (while the model thinks) → each clip's start/end moves to a clean boundary (sentence end, real pause) within 6 s, cut in the quiet ≤0.4 s before / ≤0.7 s after the words, 15–90 s kept | final `clips` times + `snap` rules |
| copy | one request writes title / hook / description / hashtags for every shown clip; Banglish videos also get their clips' words spelled in Latin (D48). Never fails the video | `clips.copy`, `transcripts.latnWords` |
| render | best 3 clips (D45): cut → crop 9:16 (+ offset) → `ass` captions `shaping=complex` → x264 → private Cloudinary MP4. Other clips: "Render clip" → `renders` doc `queued` → render dispatcher → `clip-render` queue (uploads re-downloaded; YouTube: only the clip's section) | `renders` docs + Cloudinary files |

Principle: **AI decides WHAT (which moments, what copy). Code decides HOW (exact
timestamps, crop, encoding).** LLM output never becomes an FFmpeg argument directly.

Every stage is idempotent: completed stages are recorded in MongoDB and skipped on retry.
The scratch folder is deleted in `finally`.

## Data model (sketch — superseded by `docs/SCHEMA.md`)

- `users` — `clerkId`, `email`, `plan`, `quota { monthlyMinutes, usedMinutes, periodStart }`
- `videos` — `userId`, `sourceType (upload|youtube)`, `sourceUrl`, `cloudinary {}`,
  `probe {}`, `language (bn|en)`, `permission { confirmed, at, ip }`, `status`,
  `pipeline { stage, progress, stages[] }`, `error { code, message, retryable }`
- `transcripts` — `videoId`, `language`, `segments[]`, `wordsUrl` (word-level JSON in Cloudinary)
- `clips` — `videoId`, `start`, `end`, `score`, `reason`, `momentType`, `title`, `hook`,
  `hashtags`, `status (suggested|approved|rejected)`
- `renders` — `clipId`, `aspectRatio`, `captionStyle`, `cropOffset`, `status`, `cloudinary {}`

## Environment variables

| Variable | web | worker | Where it comes from |
|---|:-:|:-:|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✓ | | Clerk → API Keys |
| `CLERK_SECRET_KEY` | ✓ | | Clerk → API Keys |
| `MONGODB_URI` | ✓ | ✓ | Atlas → Connect → Drivers |
| `MONGODB_DB` | ✓ | ✓ | our choice: `ai_video_shorter` |
| `REDIS_URL` | ✓ | ✓ | Redis Cloud → Connect |
| `CLOUDINARY_CLOUD_NAME` | ✓ | ✓ | Cloudinary dashboard |
| `CLOUDINARY_API_KEY` | ✓ | ✓ | Cloudinary → API Keys |
| `CLOUDINARY_API_SECRET` | ✓ | ✓ | Cloudinary → API Keys |
| `CLOUDINARY_FOLDER` | ✓ | ✓ | `dev` locally, `prod` in production |
| `ADMIN_EMAILS` | ✓ | | owner emails, comma-separated (docs/ADMIN.md §1) |
| `GROQ_API_KEY` | optional | ✓ | console.groq.com (web: admin AI page only — model list + Test) |
| `GEMINI_API_KEY` | optional | ✓ | aistudio.google.com/apikey (web: admin AI page only) |
| `SCRATCH_DIR` | | ✓ | defaults to `worker/.scratch` |
