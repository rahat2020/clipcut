"use client";

import { ChevronLeftIcon, ChevronRightIcon, ListIcon, PlayIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Score } from "@/components/app/clip-bits";
import { ClipPostText, requestCoverWords, type CopyRequests } from "@/components/app/clip-post-text";
import { ClipRender, useRenders } from "@/components/app/clip-render";
import { ClipVerdict } from "@/components/app/clip-review";
import { usePlayer } from "@/components/app/source-player";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/format";
import { MOMENT_LABELS } from "@/lib/video-labels";
import type { ClipView } from "@/lib/videos/clips";
import type { RenderView } from "@/lib/videos/renders";
import type { Language } from "@/shared/enums";

/**
 * One clip, in the side panel (master–detail): where it is, approve / reject, why the AI
 * picked it, the rendered 9:16 MP4, its post text and what's said. ‹ › (or ↑ / ↓) step through the clips;
 * the timeline under the player always shows them all. Editing lives under the player.
 */
export function ClipCard({
  clip,
  index,
  total,
  onPrev,
  onNext,
  onList,
  videoId,
  language,
  renders: initialRenders,
  processing,
  expired,
  copyRequests,
}: {
  clip: ClipView;
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  onList: () => void;
  videoId: string;
  language: Language;
  renders: RenderView[];
  processing: boolean;
  expired: boolean;
  copyRequests: CopyRequests | null;
}) {
  const { playClip } = usePlayer();
  const { data: renders } = useRenders(videoId, initialRenders, processing);
  const [moreReason, setMoreReason] = useState(false);
  const router = useRouter();

  async function suggestCoverWords() {
    try {
      await requestCoverWords(videoId, clip.id);
      toast.success("Writing new cover ideas… this takes a few seconds.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t start. Please try again.");
    }
  }

  return (
    <section aria-label={`Clip ${clip.rank}`} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="sm" onClick={onList}>
          <ListIcon />
          All clips
        </Button>
        <span className="ml-auto text-xs text-subtle tabular-nums">
          Clip {index + 1} of {total}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Previous clip" disabled={!onPrev} onClick={onPrev}>
          <ChevronLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next clip" disabled={!onNext} onClick={onNext}>
          <ChevronRightIcon />
        </Button>
      </div>

      {/* Fits a laptop screen as is; scrolls only on very short windows or while a reject reason is asked. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h2 className="font-heading text-base font-semibold">Clip {clip.rank}</h2>
          <span className="font-mono text-sm">
            {formatDuration(clip.startMs)}–{formatDuration(clip.endMs)}
          </span>
          <span className="text-xs text-subtle">{Math.round(clip.durationMs / 1000)} s</span>
          <span className="rounded-4xl border px-2 py-0.5 text-xs text-muted-foreground">{MOMENT_LABELS[clip.momentType]}</span>
          {clip.ai && <span className="text-xs text-subtle">Trimmed</span>}
          {clip.kept && (
            <span className="text-xs text-subtle" title="Approved in an earlier set and kept when new clips were found">
              Kept
            </span>
          )}
          <Score score={clip.score} className="ml-auto text-sm" />
        </div>

        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <ClipVerdict key={`${clip.id}:${clip.status}`} clip={clip} />
          </div>
          <Button variant="ghost" size="sm" onClick={() => playClip(clip.id, clip.startMs, clip.endMs)}>
            <PlayIcon />
            Play
          </Button>
        </div>

        {clip.reason && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            <span className={moreReason ? undefined : "line-clamp-2"}>{clip.reason}</span>
            {clip.reason.length > 140 && (
              <button type="button" onClick={() => setMoreReason((m) => !m)} className="text-foreground/80 underline-offset-2 hover:underline">
                {moreReason ? "Less" : "More"}
              </button>
            )}
          </p>
        )}

        <ClipRender
          videoId={videoId}
          clipId={clip.id}
          rank={clip.rank}
          render={renders.find((r) => r.clipId === clip.id)}
          processing={processing}
          expired={expired}
          cover={{
            options: clip.copy?.coverOptions ?? [],
            fallback: clip.copy?.coverText || clip.copy?.title || "",
            lang: clip.copy?.script === "Latn" ? undefined : language,
            pending: clip.coverPending && processing,
            suggest: copyRequests && {
              run: suggestCoverWords,
              disabledReason: processing ? "Wait for the video to finish" : copyRequests.left > 0 ? null : "No rewrites left for this video",
            },
          }}
        />

        <ClipPostText clip={clip} videoId={videoId} language={language} processing={processing} requests={copyRequests} />

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-subtle">What’s said</span>
          <p lang={language} className="text-[15px] leading-relaxed text-foreground/90">
            {clip.transcriptText}
          </p>
        </div>
      </div>
    </section>
  );
}
