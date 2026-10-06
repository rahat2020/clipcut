"use client";

import { CheckIcon, SparklesIcon, XIcon } from "lucide-react";

import { Score } from "@/components/app/clip-bits";
import { usePlayer } from "@/components/app/source-player";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MOMENT_LABELS } from "@/lib/video-labels";
import type { ClipView } from "@/lib/videos/clips";
import type { Language } from "@/shared/enums";

/**
 * The suggested clips, best first, as compact rows for the workspace's side panel.
 * Clicking a row selects it and plays just that part; its full details show under the
 * player. Approved clips are marked; rejected ones fade (Step 13).
 */
export function ClipList({
  clips,
  language,
  emptyNote,
  onPick,
}: {
  clips: ClipView[];
  language: Language;
  emptyNote: string;
  onPick?: (id: string) => void;
}) {
  const { selectedId, playClip } = usePlayer();

  if (clips.length === 0) {
    return (
      <div className="flex items-start gap-3 px-5 py-8 text-sm text-subtle">
        <SparklesIcon className="mt-0.5 size-5 shrink-0" strokeWidth={1.8} />
        {emptyNote}
      </div>
    );
  }

  return (
    <ol aria-label="Suggested clips" className="flex flex-col gap-1 p-2">
      {clips.map((clip) => {
        const selected = selectedId === clip.id;
        return (
          <li key={clip.id}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => {
                playClip(clip.id, clip.startMs, clip.endMs);
                onPick?.(clip.id);
              }}
              className={cn(
                "group flex w-full gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors",
                selected ? "border-line-strong bg-raised" : "hover:bg-raised/60",
                clip.status === "rejected" && !selected && "opacity-55",
              )}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border font-mono text-xs",
                  selected ? "border-primary/50 bg-primary/10 text-primary" : "text-subtle",
                )}
              >
                {clip.rank}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm">
                  <span className="font-mono">
                    {formatDuration(clip.startMs)}–{formatDuration(clip.endMs)}
                  </span>
                  <span className="text-xs text-subtle">{Math.round(clip.durationMs / 1000)} s</span>
                  <span className="text-xs text-muted-foreground">{MOMENT_LABELS[clip.momentType]}</span>
                  {clip.kept && (
                    <span className="text-xs text-subtle" title="Approved in an earlier set and kept">
                      Kept
                    </span>
                  )}
                  {clip.status === "approved" && (
                    <span className="flex items-center gap-1 text-xs text-primary">
                      <CheckIcon className="size-3.5" />
                      Approved
                    </span>
                  )}
                  {clip.status === "rejected" && (
                    <span className="flex items-center gap-1 text-xs text-destructive">
                      <XIcon className="size-3.5" />
                      Rejected
                    </span>
                  )}
                  <Score score={clip.score} className="ml-auto" />
                </span>
                {clip.copy ? (
                  <span lang={clip.copy.script === "Latn" ? undefined : language} className="line-clamp-1 text-[13px] leading-snug text-foreground/85">
                    {clip.copy.title}
                  </span>
                ) : (
                  clip.reason && <span className="line-clamp-1 text-[13px] leading-snug text-muted-foreground">{clip.reason}</span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
