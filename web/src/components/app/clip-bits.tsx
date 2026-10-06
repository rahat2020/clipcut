import { cn } from "@/lib/utils";

/** docs/DESIGN.md: scores ≥ 85 use the accent, 75–84 the warning colour, the rest stay quiet. */
export function scoreTone(score: number | null): "high" | "mid" | "low" {
  if (score == null) return "low";
  if (score >= 85) return "high";
  if (score >= 75) return "mid";
  return "low";
}

export function Score({ score, className }: { score: number | null; className?: string }) {
  if (score == null) return null;
  const tone = scoreTone(score);
  return (
    <span
      title="AI score out of 100"
      className={cn(
        "font-mono text-xs font-medium tabular-nums",
        tone === "high" && "text-primary",
        tone === "mid" && "text-warning",
        tone === "low" && "text-subtle",
        className,
      )}
    >
      {score}
    </span>
  );
}
