import { FilmIcon } from "lucide-react";
import Link from "next/link";

import { StatusBadge } from "@/components/app/status-badge";
import { formatDuration, fromNow } from "@/lib/format";
import { isComingSoon, STAGE_LABELS } from "@/lib/video-labels";
import { effectiveExpiry, ERROR_SPECS, type ErrorCode, type RetentionSettings, type VideoDoc } from "@/shared";

export type CardVideo = Pick<
  VideoDoc,
  "title" | "language" | "status" | "media" | "pipeline" | "counts" | "error" | "retention" | "thumbnailUrl"
> & { _id: unknown };

/** Fields a VideoCard needs — pass to `.select()` so list queries stay small. */
export const VIDEO_CARD_FIELDS = {
  title: 1,
  language: 1,
  status: 1,
  media: 1,
  pipeline: 1,
  counts: 1,
  error: 1,
  retention: 1,
  thumbnailUrl: 1,
} as const;

/** One video in a grid: poster, status, length, title and a one-line state. Links to its page. */
export function VideoCard({ video: v, plan, retention }: { video: CardVideo; plan: string; retention: RetentionSettings }) {
  const progress = Math.round((v.pipeline?.progress ?? 0) * 100);
  const expiry = effectiveExpiry(v, plan, retention);
  let meta: { text: string; className: string };
  let badgeLabel: string | undefined;

  if (v.status === "processing") {
    const stage = v.pipeline?.stage;
    badgeLabel = stage ? STAGE_LABELS[stage] : undefined;
    meta = { text: `${progress}% done`, className: "text-info" };
  } else if (isComingSoon(v.status, v.error?.code)) {
    meta = { text: `${v.counts?.clips ?? 0} clips · titles and rendering come in a later update`, className: "text-subtle" };
  } else if (v.status === "failed") {
    const code = v.error?.code as ErrorCode | undefined;
    meta = { text: (code && ERROR_SPECS[code]?.message) || "Processing failed.", className: "text-destructive" };
  } else if (v.status === "ready") {
    const clips = `${v.counts?.clips ?? 0} clips`;
    meta = { text: expiry ? `${clips} · deletes ${fromNow(expiry)}` : clips, className: "text-subtle" };
  } else {
    meta = { text: v.status === "queued" ? "Waiting to start" : "Not started", className: "text-subtle" };
  }

  return (
    <Link href={`/videos/${String(v._id)}`} className="group flex flex-col gap-3 rounded-xl outline-offset-4">
      <div className="relative aspect-video overflow-hidden rounded-xl border bg-raised transition-colors group-hover:border-line-strong">
        {v.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed Cloudinary URL, already resized
          <img src={v.thumbnailUrl} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center">
            <FilmIcon className="size-7 text-subtle" strokeWidth={1.6} />
          </div>
        )}
        <StatusBadge status={v.status} errorCode={v.error?.code} label={badgeLabel} className="absolute top-2 left-2 bg-background/85 backdrop-blur" />
        {v.media?.durationMs != null && (
          <span className="absolute right-2 bottom-2 rounded-md bg-background/85 px-1.5 py-0.5 font-mono text-[11px]">
            {formatDuration(v.media.durationMs)}
          </span>
        )}
        {v.status === "processing" && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-background/80">
            <div className="h-full bg-info" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 lang={v.language} className="truncate text-base font-semibold group-hover:text-primary">
          {v.title}
        </h3>
        <p className={`text-[13px] ${meta.className}`}>{meta.text}</p>
      </div>
    </Link>
  );
}
