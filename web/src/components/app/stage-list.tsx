import { CheckIcon, LoaderCircleIcon, MinusIcon, XIcon } from "lucide-react";

import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { STAGE_LABELS } from "@/lib/video-labels";
import { STAGE_NAMES, type StageName, type StageStatus } from "@/shared/enums";

export type StageView = {
  status: StageStatus;
  progress?: number | null;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
};

const NOTES: Record<StageName, string> = {
  ingest: "Check format, length and audio",
  audio: "Pull the soundtrack for transcription",
  transcribe: "Speech to text with word-level timing",
  analyze: "Read the whole transcript and rank moments",
  copy: "Title, hook and hashtags for each clip",
  render: "9:16 clips with captions burned in",
};

function took(s: StageView): string | null {
  if (!s.startedAt || !s.finishedAt) return null;
  return formatDuration(new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime());
}

/** The pipeline as a vertical stepper (docs/DESIGN.md — Processing screen). */
export function StageList({
  stages,
  comingSoon = false,
}: {
  stages: Partial<Record<StageName, StageView | null>>;
  /** The failed stage isn't built yet (STAGE_NOT_READY): show it as "coming", not failed. */
  comingSoon?: boolean;
}) {
  return (
    <ol className="flex flex-col">
      {STAGE_NAMES.map((name, i) => {
        const stored = stages[name] ?? { status: "pending" as const };
        const later = comingSoon && stored.status === "failed";
        const s = later ? { ...stored, status: "skipped" as const } : stored;
        const last = i === STAGE_NAMES.length - 1;
        return (
          <li key={name} className="flex gap-3.5">
            <div className="flex w-7 shrink-0 flex-col items-center">
              <StageIcon status={s.status} />
              {!last && <span className="min-h-5 w-px flex-1 bg-border" />}
            </div>
            <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5 pt-1", !last && "pb-4")}>
              <div className="flex justify-between gap-3">
                <span className={cn("text-[15px] font-medium", s.status === "pending" && "text-subtle")}>{STAGE_LABELS[name]}</span>
                <span className="pt-0.5 font-mono text-xs text-subtle">
                  {s.status === "running" && (s.progress ?? 0) > 0 ? `${Math.round((s.progress ?? 0) * 100)}%` : took(s)}
                </span>
              </div>
              <span className={cn("text-[13px] leading-snug", s.status === "running" ? "text-info" : "text-subtle")}>
                {later
                  ? "Coming in a later update"
                  : name === "copy" && s.status === "skipped"
                    ? "Not written — use “Write post text” on a clip"
                    : s.status === "failed"
                    ? "Failed"
                    : s.status === "skipped"
                      ? "Skipped"
                      : NOTES[name]}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StageIcon({ status }: { status: StageStatus }) {
  const base = "flex size-7 shrink-0 items-center justify-center rounded-full";
  switch (status) {
    case "done":
      return (
        <span className={cn(base, "bg-primary/15 text-primary")}>
          <CheckIcon className="size-4" strokeWidth={2.6} />
        </span>
      );
    case "running":
      return (
        <span className={cn(base, "bg-info/15 text-info")}>
          <LoaderCircleIcon className="size-4 animate-spin" strokeWidth={2.4} />
        </span>
      );
    case "failed":
      return (
        <span className={cn(base, "bg-destructive/15 text-destructive")}>
          <XIcon className="size-4" strokeWidth={2.6} />
        </span>
      );
    case "skipped":
      return (
        <span className={cn(base, "bg-accent text-subtle")}>
          <MinusIcon className="size-4" />
        </span>
      );
    default:
      return <span className={cn(base, "border-[1.5px] border-line-strong")} />;
  }
}
