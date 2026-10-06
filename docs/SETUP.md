# Setup

How to get this project running on a Windows machine from scratch.
Nothing needs admin rights, Docker, WSL2 or Python.

## 1. Tools

| Tool | Version | Where | How |
|---|---|---|---|
| Node.js | 22+ | default installer | nodejs.org |
| Git | any | default installer | git-scm.com |
| FFmpeg + ffprobe | 8.1 (GPL build with libass + HarfBuzz) | `D:\tools\ffmpeg\bin` | BtbN build from GitHub: `ffmpeg-n8.1-latest-win64-gpl-8.1.zip` |
| yt-dlp | latest | `D:\tools\bin\yt-dlp.exe` | github.com/yt-dlp/yt-dlp/releases |

Add `D:\tools\ffmpeg\bin` and `D:\tools\bin` to the **user** PATH, then open a new
terminal. Keep tools off C: — the SSD is nearly full.

Move npm's cache off C: as well:

```bash
npm config set cache "D:\tools\npm-cache"
```

> gyan.dev's FFmpeg mirror was very slow from Bangladesh; GitHub was ~20× faster.
> If a download stalls, resume it with `curl -L -C - -o file.zip <url>`.

## 2. Accounts (all free, no card)

| Service | URL | You need |
|---|---|---|
| Groq | console.groq.com | API key (`gsk_…`) |
| Google AI Studio | aistudio.google.com/apikey | API key (`AIza…`) |
| Cloudinary | cloudinary.com | cloud name, API key, API secret |
| Clerk | dashboard.clerk.com | publishable key (`pk_…`), secret key (`sk_…`) |
| MongoDB Atlas | mongodb.com/atlas | M0 cluster, Mumbai region, connection string |
| Redis Cloud | redis.io/try-free | 30 MB database, connection URL |

Settings that matter:
- **Atlas → Network Access:** allow `0.0.0.0/0` (Hugging Face IPs change). Use a
  password with only letters and digits.
- **Redis Cloud → Configuration → Data eviction policy:** `noeviction`.

## 3. Environment files

Each project has a template. Copy it and fill in the keys — never paste keys into chat
or commit them.

```bash
cp web/.env.example    web/.env.local
cp worker/.env.example worker/.env.local
```

MongoDB, Redis and Cloudinary values are the same in both files.

## 4. Install and verify

```bash
cd web    && npm install && npm run check
cd worker && npm install && npm run check
```

Both should end with every line `✓`. Each failure line includes a hint.

## 5. Run

```bash
cd web    && npm run dev     # http://localhost:4000
cd worker && npm run dev
```
