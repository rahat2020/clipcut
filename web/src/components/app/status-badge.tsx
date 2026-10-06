import { cn } from "@/lib/utils";
import { isComingSoon, STATUS_DISPLAY, type StatusTone } from "@/lib/video-labels";
import type { VideoStatus } from "@/shared";

const TONES: Record<StatusTone, string> = {
  accent: "bg-primary/15 text-primary",
  info: "bg-info/15 text-info",
  danger: "bg-destructive/15 text-destructive",
  neutral: "bg-accent text-muted-foreground",
};

/** Status pill. Always shows a word — color is never the only signal. */
export function StatusBadge({
  status,
  errorCode,
  label,
  className,
}: {
  status: VideoStatus;
  /** Lets a run stopped at a not-yet-built stage show as "Clips ready". */
  errorCode?: string | null;
  label?: string;
  className?: string;
}) {
  const display = isComingSoon(status, errorCode) ? { label: "Clips ready", tone: "accent" as const } : STATUS_DISPLAY[status];
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
        TONES[display.tone],
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label ?? display.label}
    </span>
  );
}
