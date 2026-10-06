import { ChevronRightIcon, InfoIcon, LanguagesIcon } from "lucide-react";
import Link from "next/link";

import { ClipEditToolbar } from "@/components/app/clip-review";
import { ClipTimeline } from "@/components/app/clip-timeline";
import { DeleteVideoButton } from "@/components/app/delete-video-button";
import { FindClipsPopover } from "@/components/app/find-clips-popover";
import { PlayerProvider, SourcePlayer, type PlayerSource } from "@/components/app/source-player";
import { StatusBadge } from "@/components/app/status-badge";
import { StepsPopover } from "@/components/app/steps-popover";
import type { TranscriptView } from "@/components/app/transcript-panel";
import { VideoSidePanel } from "@/components/app/video-side-panel";
import { ROUTES } from "@/lib/routes";
import { focusLabel, LANGUAGE_NAMES } from "@/lib/video-labels";
import type { ClipRequestView } from "@/lib/videos/clip-request";
import type { ClipFocusView, ClipView } from "@/lib/videos/clips";
import type { VideoProgressView } from "@/lib/videos/progress-view";
import type { RenderView } from "@/lib/videos/renders";
import type { Language, VideoStatus } from "@/shared/enums";

export type VideoWorkspaceProps = {
  videoId: string;
  title: string;
  language: Language;
  status: VideoStatus;
  errorCode: string | null;
  /** Short facts after the status: length, language, source, when it was added. */
  meta: string[];
  /** Set when we switched the language from what the user picked (D38). */
  languageRequested: Language | null;
  source: PlayerSource;
  /** Source width ÷ height, for the framing overlay. */
  aspect: number | null;
  durationMs: number;
  clips: ClipView[];
  transcript: TranscriptView | null;
  renders: RenderView[];
  progress: VideoProgressView;
  expired: boolean;
  clipsNote: string;
  transcriptNote: string;
  /** What the clips on screen were picked for. */
  focus: ClipFocusView | null;
  /** The latest "Find new clips" request, while it's recent enough to mention. */
  clipRequest: ClipRequestView | null;
  /** "Find new clips" (Step 14); null when the video has no transcript to search. */
  findClips: { left: number; limit: number; blocked: string | null; initialOpen?: boolean } | null;
  /** "Write again" / "Write post text" requests left (Step 15); null hides them. */
  copyRequests: { left: number; limit: number } | null;
  /** Letters of a Bangla video's captions and post text (Step 15). */
  captionScript: "Beng" | "Latn";
};

/**
 * Space taken by everything on the left except the player — page padding, header, timeline,
 * edit toolbar and the gaps (≈ 22.5rem). The player gets the rest of the viewport height, so
 * the page never scrolls on screens 1024 px and wider (a 1366×768 laptop included). On wide
 * screens the left column stops at 62 % so the clip panel keeps room.
 */
const PLAYER_MAX_W = "lg:max-w-[calc((100dvh_-_22.5rem)*16/9)]";

/**
 * One video as a single-screen workspace (docs/DESIGN.md):
 *
 *   header ─ title · status · facts ··················· [Steps] [Delete]
 *   left   ─ source player (with the 9:16 framing overlay), clip timeline, edit toolbar
 *   right  ─ progress while processing, then Clips (card ⇄ list) | Transcript
 *
 * Phones: one column, the player pinned under the top bar, the rest scrolls.
 */
/** How the last "Find new clips" ended, when it didn't bring a new set. */
function ClipRequestNote({ request, language }: { request: ClipRequestView | null; language: VideoWorkspaceProps["language"] }) {
  if (!request || (request.status !== "no_moments" && request.status !== "failed")) return null;
  const what = focusLabel(request);
  return (
    <p role="status" className="flex items-start gap-2 border-b px-4 py-2.5 text-[13px] leading-snug text-info">
      <InfoIcon className="mt-0.5 size-4 shrink-0" />
      {request.status === "no_moments" ? (
        <span>
          No new moments found for <span lang={request.query ? language : undefined}>{what}</span>, so your clips are unchanged.
        </span>
      ) : (
        <span>Couldn’t find new clips: {request.failure}. Your clips are unchanged, and this try wasn’t counted.</span>
      )}
    </p>
  );
}

export function VideoWorkspace(p: VideoWorkspaceProps) {
  const active = p.status === "queued" || p.status === "processing";
  const first = p.clips[0]?.id ?? null;

  return (
    <main className="flex w-full flex-col gap-4 px-4 py-4 sm:px-6 lg:h-dvh lg:overflow-hidden">
      <header className="flex shrink-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Link href={ROUTES.videos} className="shrink-0 text-sm text-subtle hover:text-foreground">
              My videos
            </Link>
            <ChevronRightIcon className="size-3.5 shrink-0 text-subtle" />
            <h1 lang={p.language} title={p.title} className="min-w-0 truncate font-heading text-lg font-bold tracking-tight sm:text-xl">
              {p.title}
            </h1>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-subtle">
            <StatusBadge status={p.status} errorCode={p.errorCode} />
            {p.clips.length > 0 && <span className="text-foreground">{p.clips.length} {p.clips.length === 1 ? "clip" : "clips"}</span>}
            {p.focus && p.clips.length > 0 && (
              <span lang={p.focus.query ? p.language : undefined} className="max-w-64 truncate" title={focusLabel(p.focus)}>
                Focus: {focusLabel(p.focus)}
              </span>
            )}
            {p.meta.map((m) => (
              <span key={m}>{m}</span>
            ))}
          </p>
          {p.languageRequested && (
            <p className="mt-1 flex items-start gap-2 text-[13px] text-info">
              <LanguagesIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                We heard {LANGUAGE_NAMES[p.language]} in this video, so the transcript and clips are in {LANGUAGE_NAMES[p.language]}. (You picked{" "}
                {LANGUAGE_NAMES[p.languageRequested]}.)
              </span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {p.findClips && (
            <FindClipsPopover videoId={p.videoId} language={p.language} current={p.focus} {...p.findClips} />
          )}
          {p.status === "ready" && <StepsPopover stages={p.progress.stages} />}
          <DeleteVideoButton videoId={p.videoId} active={active} />
        </div>
      </header>

      {/* Keyed on the first clip: a new set of clips (e.g. picked again) starts from its clip 1. */}
      <PlayerProvider key={first ?? "no-clips"} initialSelectedId={first}>
        <div className="grid grid-cols-1 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(min(100%,480px),min(62%,calc((100dvh_-_22.5rem)*16/9)))_minmax(360px,1fr)]">
          <div className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
            <div className="sticky top-14 z-10 -mx-4 flex flex-col gap-3 bg-background px-4 pb-2 sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:bg-transparent lg:p-0">
              <SourcePlayer source={p.source} aspect={p.aspect} className={`w-full ${PLAYER_MAX_W}`} />
              <ClipTimeline clips={p.clips} durationMs={p.durationMs} />
            </div>
            <ClipEditToolbar
              clips={p.clips}
              videoId={p.videoId}
              videoMs={p.durationMs}
              processing={active}
              expired={p.expired}
              language={p.language}
              captionScript={p.captionScript}
              canSwitchScript={!!p.copyRequests && p.copyRequests.left > 0}
            />
          </div>

          <div className="flex min-w-0 flex-col lg:min-h-0">
            <VideoSidePanel
              videoId={p.videoId}
              language={p.language}
              progress={p.status === "ready" ? null : p.progress}
              clips={p.clips}
              transcript={p.transcript}
              renders={p.renders}
              processing={active}
              expired={p.expired}
              clipsNote={p.clipsNote}
              transcriptNote={p.transcriptNote}
              notice={active ? null : <ClipRequestNote request={p.clipRequest} language={p.language} />}
              copyRequests={p.copyRequests}
            />
          </div>
        </div>
      </PlayerProvider>
    </main>
  );
}
