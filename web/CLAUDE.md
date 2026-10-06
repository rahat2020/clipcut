@AGENTS.md

# web/ — Next.js 16 app (UI + API routes)

Project-wide rules are in `../CLAUDE.md`. This file covers `web/` only.

## Next.js 16 — don't trust memory

This is Next **16.3**, newer than most training data. Before writing routing,
middleware/proxy, caching, or data-fetching code, read the matching guide in
`node_modules/next/dist/docs/`. Known differences that matter here:
- Request interception lives in `src/proxy.ts` (not `middleware.ts`) — Clerk hooks in there.
- `params`, `searchParams`, `cookies()`, `headers()` are async — always `await` them.
- `.env*` files load from `web/`, not `web/src/`. Values expand `$VAR` — escape a literal `$` as `\$`.
- Scripts outside the Next runtime load env with `loadEnvConfig` from `@next/env`.
- `PageProps<"/x">` / `LayoutProps<"/x">` / `RouteContext<"/x">` are generated types:
  after adding a route run `npm run typecheck` (it runs `next typegen` first).

## Clerk Core 3 (`@clerk/nextjs` 7) — also newer than training data

- `<SignedIn>`, `<SignedOut>`, `<Protect>` are REMOVED (they throw). Use
  `<Show when="signed-in">` / `<Show when="signed-out">`.
- `<ClerkProvider>` sits inside `<body>`. Redirect props: `signInFallbackRedirectUrl`,
  `signUpFallbackRedirectUrl` (not `afterSignInUrl`).
- `auth()` / `currentUser()` come from `@clerk/nextjs/server`. `currentUser()` is a
  Clerk API call (rate-limited) — only `getCurrentUser()` calls it, at most every 15 min.

## UI (docs/DESIGN.md)

- shadcn/ui components live in `src/components/ui/` and are ours to edit. They use **Base UI**,
  not Radix: compose with the `render` prop, not `asChild`. Add more with
  `npx shadcn@latest add <name>`.
- `cn()` from `@/lib/utils`. Icons from `lucide-react` (`FooIcon` names).
- Colors, radii and fonts come from the tokens in `src/app/globals.css` (`bg-card`,
  `text-subtle`, `bg-primary/15`, `font-heading`, `font-mono`). Never a hex in a component;
  the one exception is `src/lib/clerk-appearance.ts`.
- Dark only: `<html class="dark">`. UI copy in English. Put `lang={video.language}` on
  elements showing user content so Bangla gets its font and line-height.
- React Compiler lint forbids impure calls (`Date.now()`, `Math.random()`) in component
  bodies — do data loading in a plain async function and call it from the page.

## Layout

```
src/app/            routes (pages + route handlers under src/app/api/)
src/app/(app)/      signed-in pages sharing the sidebar shell (dashboard/)
src/components/     ui/ (shadcn) · brand/ (Logo, AuthShell) · app/ (sidebar, StatusBadge,
                    NewVideoCard) · marketing/ (landing hero)
src/lib/env.ts      validated server env — import { env } from "@/lib/env"
src/lib/env.schema.ts   zod rules (no server-only; scripts import this)
src/lib/db.ts       connectDb() — cached on globalThis, pool 5 (serverless-safe)
src/lib/routes.ts   ROUTES — app paths (sign-in, dashboard, admin, blocked)
src/lib/api.ts      apiRoute() wrapper → standard JSON error body { error: { code, message } }
src/lib/auth/       session.ts   getCurrentUser / requireUser / requireAdmin   (route handlers)
                    page-guards.ts  requireUserPage / requireAdminPage          (pages, layouts)
                    user-sync.ts    Clerk → users upsert, ADMIN_EMAILS, access rules (no server-only)
                    audit-actor.ts  auditActorFor(user) → actor with IP + browser for audit logs
src/lib/uploads/    cloudinary-core.ts (tickets, inspect, signed URLs) · rules.ts (limits)
                    · client-upload.ts (browser chunked upload)
src/lib/videos/     upload-service.ts (request → finalize → retry → delete) · schemas.ts (zod, client-safe)
                    · progress.ts (server) / progress-view.ts (client-safe type) for polling
                    · youtube-url.ts (parse, client-safe) · youtube-service.ts (oEmbed + submit)
src/lib/rate-limit-core.ts  RATE_LIMITS table + consumeRateLimit (testable) · limitUser(user, bucket) in lib/redis.ts — every API route calls it
src/lib/redis.ts    worker presence + daily AI counters (admin panel), admin rate limit — never the job queue (D35)
src/lib/admin/      videos-service · users-service · ai-service · settings-service (limits, retention, system, per-video expiry) · retention-impact · audit-service · system-info (+ system-types, client-safe) (no server-only; admin:smoke runs them)
                    · action.ts runAdminAction(): requireAdmin + rate limit + safe error → ActionResult
src/app/admin/*/actions.ts   server actions ("use server"), one per admin action, each via runAdminAction
src/components/admin/  admin-nav, ui (Panel, Facts, NativeSelect, Pagination, Tag), form-parts (FormSection, SwitchField, NumberField, SaveBar), health-cards, action-button
                    (confirm dialog + typed confirmation), rerun-clips-form, user-forms, ai-settings-form
src/components/providers.tsx  TanStack Query client
src/proxy.ts        Clerk; signed-out visitors to /dashboard, /videos, /admin → sign-in
src/app/admin/      admin panel (layout 404s non-admins)
src/shared/         GENERATED copy of ../shared/src — import as "@/shared", never edit
scripts/            standalone tsx scripts (check-services.ts, auth-smoke-test.ts)
```

## Rules

- Call `await connectDb()` before any model query in a route handler / server component.
- Read config only through `env` from `@/lib/env`, never `process.env` directly
  (exception: `NEXT_PUBLIC_*` in client components).
- `@/lib/env` imports `server-only`; never import it from a client component.
- Route handlers do short work only: validate, write MongoDB (e.g. `status: "queued"`),
  return. The worker's dispatcher picks queued work up — web/ never enqueues (D35).
  Anything slow belongs in `../worker/`.
- Every route handler is wrapped in `apiRoute()` and starts with `requireUser()` or
  `requireAdmin()`; queries spread `ownedBy(user)`. Never read Clerk ids from the request body.
- Every page under `/dashboard` calls `requireUserPage()`; every page, layout and server
  action under `/admin` calls `requireAdminPage()` / `requireAdmin()` ITSELF — the layout
  check alone is not enough. Admin mutations then call `writeAudit` with `auditActorFor(admin)`.
  Admin server actions go through `runAdminAction()` (role check, rate limit, safe errors)
  and call a service in `src/lib/admin/`; pass a record's id by binding: `action.bind(null, id)`.
- `requireUser()` already connects to MongoDB; any other server code calls `connectDb()` first.
- Client components never import the `@/shared` barrel (it pulls in Mongoose) — use
  `import type` from it, or import values from `@/shared/enums`. `npm run lint` enforces this
  (`local/no-shared-barrel-in-client` in eslint.config.mjs) — typecheck alone misses it.
- Source videos are private (`type: authenticated`): show them only through
  `signedSourceUrl` / `signedThumbnailUrl`. Trust Cloudinary's numbers, never the browser's.
- Progress is fetched by polling, not SSE (Vercel free tier).
- User content may be Bangla (taller glyphs): don't clamp heights of text that shows it.

## Commands

```
npm run dev         # http://localhost:4000
npm run check       # verify every key in .env.local against the real services
npm run auth:smoke  # 19 user-sync / admin-bootstrap / access checks in a throwaway DB
npm run upload:smoke # 30 upload + retry + YouTube checks: real Cloudinary (smoketest/) + throwaway DB
npm run admin:smoke  # 26 admin checks: videos, users, AI settings, limits, retention (impact + confirmation), system, audit; real DB/Cloudinary/model lists, 1 Gemini call
npm run review:smoke # 16 checks (incl. per-user rate limits): clip review, render requests, Find new clips, kept clips, post text edits + rewrite/Banglish requests — throwaway DB
# Admin forms with fake data, no sign-in (dev only): http://localhost:4000/dev/admin?view=limits|retention|system|health|impact|expiry
# Layout check without signing in (dev only): http://localhost:4000/dev/workspace — screenshot at 1280×600 / 1366×650 / 1920×950
npm run typecheck   # sync shared + next typegen + tsc --noEmit
npm run lint
npm run build
```
