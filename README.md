# AI Video Shorter

Turn one long video into ready-to-post short clips — Bangla first.

Upload a video or paste a YouTube link. The app transcribes it, finds the strongest
moments across the **whole** video, cuts 9:16 clips with correctly rendered Bangla
captions, and writes a title, hook and hashtags for each.

## Projects

| Folder | What | Runs on |
|---|---|---|
| [`web/`](web/) | Next.js 16 app — UI and API routes | Vercel |
| [`worker/`](worker/) | Background processor — FFmpeg, transcription, clip selection, rendering | Hugging Face Spaces |
| [`shared/`](shared/) | Models, settings, rules — copied into both apps by `scripts/sync-shared.mjs` | — |

## Docs

- [Setup](docs/SETUP.md) — tools, accounts, env files
- [Progress](docs/PROGRESS.md) — roadmap and current step
- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit
- [Decisions](docs/DECISIONS.md) — why it's built this way
- [Schema](docs/SCHEMA.md) — database design and how it evolves
- [Admin panel](docs/ADMIN.md) — what the owner can see and control
- [Design](docs/DESIGN.md) — UI direction, tokens, components, mockup link

## Quick start

```bash
cd web    && npm install && npm run check && npm run dev
cd worker && npm install && npm run check && npm run dev
```
