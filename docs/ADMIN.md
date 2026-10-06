# Admin panel

Status: **designed 2026-09-28**, built incrementally (see §6); **all sections built as of 2026-10-06** (Step 16, D54). Data model: `docs/SCHEMA.md`
§3.1 (`role`, `status`, `limitsOverride`), §3.9 `settings`, §3.10 `audit_logs`, §3.11 Redis keys.

Purpose: let the owner see and control the whole product from one place — users, videos
and jobs, AI models and quotas, limits, retention, and system switches — **without
redeploying and without touching the database by hand.**

Lives inside `web/` at `/admin`. Same Next.js app, same Clerk login; no separate service.

---

## 1. Access and security

**Who is an admin**
- `ADMIN_EMAILS` in `web/.env.local` (comma-separated) bootstraps the owner. When a user
  signs in with a **verified** Clerk email on that list, their `role` becomes `admin`.
  Listed admins can't be demoted from the UI — nobody can lock the owner out.
- Existing admins can grant or revoke `admin` for other users in the UI (audited).
- Why an env list and not "first user to sign up": the env can't be changed through the
  app, so a bug or a malicious request can't create an admin.

**Guards**
- Every `/admin` page and every admin action checks `role === 'admin'` **on the server,
  from our database** — never trusting anything sent by the browser:
  `requireAdminPage()` in pages/layouts (non-admins get **404**, so the panel isn't
  advertised), `requireAdmin()` in route handlers and server actions (403 JSON).
  `proxy.ts` only sends signed-out visitors to sign-in; it doesn't know roles (D29).
- The layout's check is not enough on its own — each admin page and action calls the
  guard itself (layouts don't re-run on client navigation; server actions skip them).
- Every admin action writes an `audit_logs` entry (who, what, before/after, IP, time).
- Destructive actions (delete user data, delete video, shorten retention) need the
  target's name typed to confirm (built: the user's email; `delete` for a video).
- Admin actions are rate-limited (built: 30 per admin per minute, Redis).
- Nobody changes their OWN role or status from the panel, and ADMIN_EMAILS owners can't be
  demoted, suspended or deleted from it (built in `lib/admin/users-service.ts`).
- Turn on two-step verification for the owner's Clerk account if the Clerk plan allows it.

**What the admin can never see:** API keys and passwords. The panel shows only
"configured ✓ / working ✓" for each key.

---

## 2. Sections

### Dashboard
- Users: total, new today · Videos: today, processing now, failed in 24 h
- Queue (BullMQ): waiting / active / failed
- Worker: alive? last heartbeat, version, current job (Redis heartbeat key)
- Storage: MongoDB used / 512 MB · Cloudinary credits used / 25
- AI today: Groq audio minutes, Gemini requests, Groq requests — each against its daily cap
- Loads on open and via a refresh button; auto-refresh at most every 30 s (ops budget).

### Users
- Search by email / name; filter by plan, status, role; sort by newest or most usage.
- User page: profile, plan, this month's usage vs limit, their videos, recent usage events.
- Actions: change plan · override limits (e.g. +60 minutes this month, bigger files) ·
  reset monthly usage · suspend / unsuspend (with reason) · grant / revoke admin ·
  delete all of the user's data.

### Videos and jobs
- All videos; filter by status, user, date, source type, language.
- Video page: pipeline stage timeline with timings and attempts, error code and message,
  transcript, every analysis run (model, prompt version, tokens, latency), clips showing
  **AI-proposed vs snapped** boundaries, renders.
- Actions: retry failed stage · cancel · re-run clip selection with a different
  model/prompt · override this video's expiry · delete (with Cloudinary assets).

### AI models
- Per task — transcription, clip selection, copy writing: provider, model, temperature,
  prompt version, fallback, enabled on/off.
- Model dropdowns are filled from each provider's live model list (same calls as
  `npm run check`), so a new Gemini release appears without code changes.
- "Test" button: one tiny request with the chosen model; shows latency and the reply.
- Daily caps per provider, with today's usage beside each.
- Changes apply to jobs that **start** after saving (≤ 60 s cache); running jobs keep
  their model.

### Accuracy (the differentiator)
- Per prompt version × model: clips proposed, approved, rejected, downloaded →
  acceptance rate. Top rejection reasons.
- Eval-set scores when a run was measured against `eval/` (Steps 8–11).
- This is how we'll know whether a prompt or model change actually helped.
- Built 2026-09-30 (`/admin/accuracy`, `lib/admin/accuracy-service.ts`): also shows where
  cuts landed (snap rules), transcription engines per language, failed runs. Approve /
  reject / download counts fill in with Step 13; eval scores with Steps 8 and 11.

### Limits and plans
- Per plan: monthly minutes, max file size (≤ 100 MB, enforced in code), max duration,
  concurrent jobs, max clips per video, YouTube allowed.

### Retention
- Per plan: days to keep a video's source and clips (free: 7) · grace hours (24) ·
  purge soft-deleted after N days.
- **Changes apply to every video, old and new** (expiry is computed, never stored —
  `docs/SCHEMA.md` §8).
- Before saving, an **impact preview**: how many existing videos and users the change
  affects and the earliest deletion time; confirm by typing the new value.
- Grace period: no file is deleted sooner than `graceHours` after the change (0 = no grace).
- Lengthening extends videos that still have files; already-deleted files can't come back.
- "Expiring in the next 24 h" list · per-video expiry override · "Run cleanup now" button.

### System
- Maintenance mode (+ message shown to users) · uploads on/off · YouTube on/off ·
  sign-ups on/off.
- Database: collection sizes, index list, applied and pending migrations (read-only),
  last backup time.
- Link to MongoDB Atlas Data Explorer for rare manual fixes.

### Audit log
- Every admin action, filterable by admin, action and target.

---

## 3. What the panel deliberately does NOT do

| Not included | Why | Instead |
|---|---|---|
| Raw "edit any field" database editor | Bypasses the rules that keep data consistent: status transitions, the zombie-run guard, denormalised counts, quota counters. One wrong edit corrupts a job silently. | Purpose-built actions above; Atlas Data Explorer for rare manual fixes |
| Showing or editing API keys | A leaked admin session would leak every key | Keys stay in env / platform secrets; panel shows status only |
| Running migrations from the browser | Vercel functions time out; a half-run migration is worse than none | `npm run migrate` from the worker; panel shows status |
| Logging in as a user (impersonation) | High-risk, easy to misuse | Read-only user and video pages cover support needs |

---

## 4. Rules for the code

- Admin reads and writes go through the same service functions as the rest of the app —
  no special shortcuts that skip validation or state guards.
- Settings are zod-validated before saving; the `version` field rejects a save based on
  a stale copy ("someone else changed this — reload").
- Every mutation: check admin → validate → perform → write audit log → return.
- Admin pages never poll faster than 30 s.

---

## 5. Where each piece of data comes from

| Panel shows | Source | Cost |
|---|---|---|
| Users, videos, clips, runs | MongoDB queries (indexed) | on page open only |
| Storage used | `db.stats()` + Cloudinary `usage` API | on dashboard open |
| Queue counts | BullMQ `getJobCounts()` (Redis) | free against Mongo budget |
| Worker alive | Redis heartbeat key | free against Mongo budget |
| AI usage today | Redis daily counters (fast) / `usage_events` (history) | cheap |
| Settings | `settings` collection (60 s cache) | ~0 |

---

## 6. Build plan

Built alongside the features it controls rather than all at the end:

| Step | Admin work |
|---|---|
| 2 — models ✅ | `users.role/status/limitsOverride`, `settings` (schemas + defaults + cached getter), `audit_logs` |
| 3 — auth ✅ | `ADMIN_EMAILS` bootstrap, `requireAdmin()` guard, `/admin` shell + overview (counts, settings versions, recent audit), audit actor (IP, browser) |
| 5 — queue ✅ | Queue + worker-heartbeat cards |
| 9½ — **admin catch-up** ✅ (2026-09-29) | The Step 5/7/9 pieces that were skipped: **Videos & jobs** (list + filters, video page with pipeline timeline, error, transcript, every clip run, clips AI-proposed vs final, charges, history; retry, cancel, pick clips again with another model/prompt, delete) · **AI models** (per task model/temperature/prompt/fallback/on-off, live model lists, Test button, daily caps with today's usage) · overview AI-today card. **Users** pulled forward from Step 16 at Rahat's request (list + filters, user page, plan, limit override, reset usage, suspend, admin role, delete all data) |
| 11 — accuracy | Accuracy page |
| 16 — **admin panel completion** ✅ (2026-10-06) | Dashboard storage + backup cards, limits & plans, retention with impact preview, system switches + database facts, audit-log viewer, per-video expiry. "Run cleanup now" left out: web/ never talks to the worker (D35) — the cleanup runs every 30 min |
