"use client";

import { FileTextIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { usePlayer } from "@/components/app/source-player";
import type { TranscriptView } from "@/components/app/transcript-panel";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ClipView } from "@/lib/videos/clips";

/**
 * The transcript inside the workspace. Lines of the selected clip are highlighted (and
 * scrolled to when the selection changes); clicking a line plays from there.
 */
export function TranscriptList({ transcript, clips, emptyNote }: { transcript: TranscriptView | null; clips: ClipView[]; emptyNote: string }) {
  const { selectedId, playFrom } = usePlayer();
  const listRef = useRef<HTMLOListElement>(null);
  const clip = clips.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    if (!clip) return;
    listRef.current?.querySelector<HTMLElement>("[data-in-clip='true']")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [clip]);

  if (!transcript) {
    return (
      <div className="flex items-start gap-3 px-5 py-8 text-sm text-subtle">
        <FileTextIcon className="mt-0.5 size-5 shrink-0" strokeWidth={1.8} />
        {emptyNote}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <p className="px-5 pt-3 text-xs text-subtle">
        {transcript.wordCount.toLocaleString("en-US")} words · {transcript.segments.length} lines · click a line to play from there
      </p>
      <ol ref={listRef} className="p-2" lang={transcript.language}>
        {transcript.segments.map((s) => {
          const inClip = !!clip && s.endMs > clip.startMs && s.startMs < clip.endMs;
          return (
            <li key={`${s.startMs}-${s.endMs}`}>
              <button
                type="button"
                data-in-clip={inClip}
                onClick={() => playFrom(s.startMs)}
                className={cn(
                  "flex w-full gap-4 rounded-lg px-3 py-2 text-left transition-colors hover:bg-raised",
                  inClip && "bg-primary/10 hover:bg-primary/15",
                )}
              >
                <span className={cn("w-12 shrink-0 pt-0.5 text-right font-mono text-xs", inClip ? "text-primary" : "text-subtle")}>
                  {formatDuration(s.startMs)}
                </span>
                <span className="min-w-0 flex-1 text-[15px] leading-relaxed text-foreground/90">{s.text}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
