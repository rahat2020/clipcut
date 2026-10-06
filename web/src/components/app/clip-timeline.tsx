"use client";

import { scoreTone } from "@/components/app/clip-bits";
import { usePlayer } from "@/components/app/source-player";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ClipView } from "@/lib/videos/clips";

/**
 * Where the suggested clips sit in the whole video, at a glance: one bar per clip,
 * coloured by score. Click a bar to play that clip.
 */
export function ClipTimeline({ clips, durationMs }: { clips: ClipView[]; durationMs: number }) {
  const { selectedId, playClip } = usePlayer();
  if (clips.length === 0 || durationMs <= 0) return null;
  const pct = (ms: number) => `${Math.min(Math.max((ms / durationMs) * 100, 0), 100)}%`;

  return (
    <div className="flex flex-col gap-1.5">
      <div role="group" aria-label="Clips on the video timeline" className="relative h-9 rounded-lg border bg-sunken">
        {clips.map((c) => {
          const tone = scoreTone(c.score);
          const selected = selectedId === c.id;
          const widthPct = ((c.endMs - c.startMs) / durationMs) * 100;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => playClip(c.id, c.startMs, c.endMs)}
              title={`Clip ${c.rank} · ${formatDuration(c.startMs)}–${formatDuration(c.endMs)}${c.score != null ? ` · score ${c.score}` : ""}`}
              aria-label={`Play clip ${c.rank}, ${formatDuration(c.startMs)} to ${formatDuration(c.endMs)}`}
              aria-pressed={selected}
              style={{ left: pct(c.startMs), width: `max(${widthPct}%, 6px)` }}
              className={cn(
                "absolute inset-y-1 flex items-center justify-center overflow-hidden rounded-md font-mono text-[10px] font-semibold transition-[filter,box-shadow] hover:brightness-125",
                tone === "high" && "bg-primary/75 text-primary-foreground",
                tone === "mid" && "bg-warning/70 text-primary-foreground",
                tone === "low" && "bg-muted-foreground/45 text-foreground",
                selected && "ring-2 ring-foreground ring-offset-1 ring-offset-sunken",
                c.status === "rejected" && !selected && "opacity-35",
              )}
            >
              {widthPct >= 2.5 ? c.rank : ""}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-subtle">
        <span>0:00</span>
        <span>{formatDuration(durationMs)}</span>
      </div>
    </div>
  );
}
