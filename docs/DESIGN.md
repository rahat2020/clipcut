# Design — "Cutroom"

Status: **approved 2026-09-28** (Step 3.5). Mockup canvas (private to Rahat):
https://claude.ai/artifact/ApamCTVZxPnPonLeNJoCLH — Landing, Dashboard, Processing,
Clip review, Admin, phone Clip review, Foundations.

Direction: an editing-suite look. Warm near-black ground, quiet surfaces, **one sharp
accent** used only for the main action, high scores and "ready". No gradient washes, no
emoji, no decorative filler.

## Rules

- **UI copy is English** — buttons, labels, messages, landing page, sample data.
  Bangla appears only as the "Spoken language: Bangla" option. User content (titles,
  transcripts, captions from Bangla videos) can be Bangla: render it with `lang={video.language}`
  so the Bangla font fallback and taller line-height apply.
- **Colors only from tokens** in `web/src/app/globals.css` (Tailwind classes such as
  `bg-card`, `text-subtle`, `bg-primary/15`). Never hard-code a hex in a component.
  Exception: `web/src/lib/clerk-appearance.ts` (Clerk needs literal colors — keep in sync).
- **Status is never color alone** — every badge has a word.
- **Touch targets ≥ 40 px** (buttons default to h-10; primary CTAs h-12).
- Real elements: `<button>`, `<a>`, `<label>` + input. Icon-only buttons get `aria-label`.
- Text contrast ≥ 4.5:1. `--subtle` (#8c857c) is the lowest-contrast text color allowed.
- One primary action per screen.
- Dark only for now (`<html class="dark">`). A light palette can be added under `:root`
  later without touching components.

## Tokens

| Token | Value | Use |
|---|---|---|
| `background` | `#0e0d0c` | page |
| `sunken` | `#121110` | sidebar, insets, drop zone |
| `card` | `#161513` | cards |
| `raised` | `#1d1b19` | selected rows, hover, popovers |
| `border` / `line-strong` | `#2b2926` / `#3a3733` | hairlines / inputs, dashed zones |
| `foreground` | `#f2efea` | primary text |
| `muted-foreground` | `#a9a39a` | secondary text |
| `subtle` | `#8c857c` | captions, timestamps |
| `primary` | `#c8f169` (lime) | the accent — main actions, scores ≥ 85, Ready |
| `primary-foreground` | `#12110f` | text on the accent |
| `info` | `#7cc4ff` | processing |
| `warning` | `#f2c14e` | near a limit, scores 75–84 |
| `destructive` | `#ff8a65` | failed, reject |

Radius: `--radius` 10 px → buttons `rounded-lg` (10), cards `rounded-xl` (14), panels
`rounded-2xl` (18), pills `rounded-full`.

## Type

| Role | Font | Where |
|---|---|---|
| Headings | **Bricolage Grotesque** 600–800, tight tracking | `font-heading` |
| UI text | **Geist** 400–600 | default `font-sans` |
| Timecodes, ids, numbers in tables | **Geist Mono** | `font-mono` |
| Bangla user content | **Hind Siliguri** (fallback in both stacks) | automatic |

All from Google Fonts via `next/font` in `web/src/app/layout.tsx`.

## Components

- `web/src/components/ui/` — shadcn/ui (style `base-nova`, **Base UI** primitives, not Radix:
  compose with the `render` prop, not `asChild`). We own these files; sizes were tuned
  (button h-10 default, h-12 lg; card ring uses `border`).
- `web/src/components/brand/` — `Logo` (wordmark "Clip" + accent "Cut"), `LogoMark` (inline SVG, token colours; same drawing as `app/icon.svg` / `favicon.ico` / `apple-icon.png`, D44), `AuthShell`.
- `web/src/components/app/` — `AppSidebar` / `MobileHeader`, `StatusBadge`, `NewVideoCard`, the video workspace pieces (below).
- `web/src/components/admin/` — admin nav, `Panel`/`Facts`/`Tag`, `ActionButton` (confirm + typed confirmation), admin forms.
- `web/src/components/marketing/` — `HeroVisual`, `Silhouette`.
- `cn()` from `@/lib/utils`. Icons: `lucide-react` (`…Icon` names).

## Video page = one-screen workspace (Rahat, 2026-09-29; rebuilt 2026-10-02)

Users came here to judge clips, not to scroll. On screens 1024 px and wider the page never
scrolls — only lists do (clip list, transcript, a clip's text). Checked at 1280×600,
1366×650 and 1920×950 (browser viewport, not screen size):

```
┌ My videos › title (1 line, full on hover)    [Find new clips] [Steps] [Delete] ┐
│ ● Ready · N clips · Focus: … · 1:55 · Bangla · YouTube · Added …                 │
├──────────────────────────────────────────┬─────────────────────────────────────┤
│ player 16:9 + 9:16 framing overlay        │ progress (only while processing /   │
│ (height = viewport − 22.5rem; column      │ failed; once ready → header "Steps")│
│ ≤ 62 % on wide screens)                   │ [ Clips (N) | Transcript ]          │
│ clip timeline (all clips, click to pick)  │ ‹ All clips   Clip 2 of 4   ‹ ›     │
│ ┌ [Trim | Framing | Captions] ── toolbar ┐│ time · type · score · Approve/Reject│
│ │ one tab's controls · Save & render     ││ AI reason (2 lines, More)           │
│ └─────────────────────────────────────────┘│ 9:16 MP4 preview · Download · Render│
│                                           │ What's said (scrolls)               │
└───────────────────────────────────────────┴─────────────────────────────────────┘
```

- Clips tab is master–detail: the selected clip's card, or the list ("All clips"). Picking a
  clip anywhere (list, timeline) opens its card; ‹ › and ↑ / ↓ step through clips. The list
  being hidden is fine — the timeline always shows every clip.
- The edit toolbar shows one tab at a time so its height is fixed (~160 px); the Framing tab
  lights up the 9:16 box on the player.
- Clicking a clip in the list or timeline plays just that part; ‹ › / ↑ ↓ only select.
  Transcript lines of the selected clip are highlighted; clicking a line plays from there.
  Clip 1 is selected (card open) on arrival.
- Phones: one column; the player + timeline stick under the top bar, the rest scrolls.
- Components: `video-workspace` (layout; server), `source-player` (PlayerProvider, usePlayer,
  SourcePlayer, frame overlay), `clip-timeline`, `clip-review` (`ClipEditToolbar`, `ClipVerdict`),
  `video-side-panel`, `clip-card`, `clip-render`, `clip-list`, `transcript-list`, `steps-popover`,
  `clip-bits`.
- **Find new clips** (Step 14): a popover from the header (focus select, or "Something
  specific…" + a description). The result of a request that found nothing or failed is one line
  ABOVE the clip tabs (never in the header — that row is height-budgeted); kept clips carry a
  "Kept" label.
- **Layout preview without signing in (dev only, 404 in production):** `/dev/workspace`
  (`?status=processing`, `?sidebar=collapsed`, `?clips=0`, `?request=none`, `?find=open`) — made-up data; screenshot it with
  headless Chrome at laptop sizes after any layout change.

## UI polish backlog (Rahat, 2026-09-29)

Rahat has more UI fixes coming. Collect them here and do them as a batch between steps;
each item names the component so the fix stays local (the workspace is split into small
components for exactly this).

| Item | Where | Status |
|---|---|---|
| Status pill said "Failed" while runs stop at a stage that isn't built yet (STAGE_NOT_READY) | `isComingSoon` → "Clips ready" + "Coming in a later update" | done 2026-09-30 |
| Time left while processing | `video-progress` `TimeLeft`, `shared/estimates.ts` | done 2026-09-30 |
| Minutes: when they reset | sidebar usage card "Resets Oct 29" (`quotaResetsAt`) | done 2026-09-30 |
| Minutes: warn before submitting, not after | `NewVideoCard` `MinutesNote` (out → red note + Find clips disabled; fewer left than the plan's max length → amber note); a picked file longer than the minutes left is refused on pick | done 2026-09-30 |
| Name + logo: ClipCut | `brand/logo.tsx`, `lib/brand.ts`, `app/icon.svg`, `favicon.ico`, `apple-icon.png` (D44) | done 2026-09-30 |
| Sidebar collapsible, remembered | `AppSidebar` rail mode (`cc_sidebar` cookie, Ctrl/Cmd+B, tooltips, minutes ring) | done 2026-10-02 |
| Captions a little lower in the MP4 | `preset:bold` `marginV` 0.16 | done 2026-10-02 |
| Video page fits one laptop screen; clip panel was a tiny nested scroll | `video-workspace` rebuild: smaller player, edit toolbar with tabs, clip card in the side panel, steps in the header | done 2026-10-02 |
| (Rahat's next list goes here) | | |

## Screens → roadmap

| Screen (mockup) | Built in |
|---|---|
| Landing, sign-in/up, blocked, app shell, dashboard layout, admin overview | Step 3.5 ✅ |
| Dashboard: working upload (drag & drop, progress, cancel) · My videos · video page layout | Step 4 ✅ |
| YouTube submit (link check, embed player on video page) | Step 6 ✅ |
| Processing: live progress (polling), Try again | Step 5 ✅ |
| Processing + upload card: download speed, time left, slow-connection note | Step 6 ✅ |
| Processing: transcript text | Step 7 ✅ |
| Video workspace: one screen — player, clip timeline, selected clip · progress + Clips/Transcript tabs | 2026-09-29 ✅ (after Step 9) |
| Clip review ★ (approve/reject + reasons, trim, framing overlay, caption style) inside the workspace — `clip-review.tsx` | Step 13 ✅ (AI-vs-snapped timeline not built) |
| Rendered clip: 9:16 preview, Download, Render clip (`clip-render` in the selected-clip panel) | Step 12 ✅ |
| Caption styles (Bold / Clean picker), framing slider | Step 13 ✅ |
| Titles, hooks, hashtags + rewrite (clip card "Post text"), Banglish switch (Captions tab) | Step 15 ✅ |
| Cover editor (clip card "Cover": frame, zoom/move, Punch, AI word ideas + second-colour word, look, place → JPG) — preview at `/dev/cover` | Step 15.5 / 15.6 ✅ |
| Admin: worker & queue card | Step 5 ✅ |
| Admin: Videos & jobs, AI models, Users, AI-today card | 2026-09-29 ✅ (admin catch-up) |
| Admin: storage, accuracy cards | Steps 11, 16 |
| Phone clip review | Step 13 ✅ (same panel, one column; not checked on a phone yet) |
