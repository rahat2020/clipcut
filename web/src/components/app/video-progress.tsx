"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  HourglassIcon,
  RotateCwIcon,
  ServerOffIcon,
  WifiLowIcon,
} from "lucide-react";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { StageList } from "@/components/app/stage-list";
import { Button } from "@/components/ui/button";
import { formatBytes, formatSpeed, formatTimeLeft } from "@/lib/format";
import { isComingSoon, STAGE_LABELS } from "@/lib/video-labels";
import { estimateRemainingMs, type RemainingEstimate } from "@/shared/estimates";
import { isTerminalStatus, type VideoProgressView } from "@/lib/videos/progress-view";
import { SLOW_TRANSFER_BYTES_PER_SEC } from "@/shared/enums";

/** "today 1:00 PM" / "tomorrow 1:00 PM" in the viewer's time zone (a function: the lint forbids reading the clock while rendering). */
function resumeLabel(iso: string): string {
  const at = dayjs(iso);
  return `${at.isSame(dayjs(), "day") ? "today" : "tomorrow"} ${at.format("h:mm A")}`;
}

/** Poll every 2 s for the first minute, then every 5 s; stop once the video is finished. */
const FAST_MS = 2_000;
const SLOW_MS = 5_000;
const FAST_POLLS = 30;

type ApiError = { error?: { message?: string } };

async function fetchProgress(id: string): Promise<VideoProgressView> {
  const res = await fetch(`/api/videos/${id}`, { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as ({ video?: VideoProgressView } & ApiError) | null;
  if (!res.ok || !body?.video) throw new Error(body?.error?.message ?? "Couldn’t load progress.");
  return body.video;
}

async function postRetry(id: string): Promise<void> {
  const res = await fetch(`/api/videos/${id}/retry`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error?.message ?? "Couldn’t retry. Please try again.");
  }
}

/**
 * The video page's progress section (top of the workspace side panel). Starts from the
 * server-rendered state, then polls `GET /api/videos/:id`. When the status changes, the
 * server parts of the page (badge, clips, transcript) are refreshed too.
 *
 * While the video processes, every stage shows. Once it has finished or stopped, the
 * stage list folds away behind "Show steps" so the clips get the space.
 */
export function VideoProgress({ initial }: { initial: VideoProgressView }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const queryKey = ["video-progress", initial.id];

  const { data: video, dataUpdatedAt } = useQuery({
    queryKey,
    queryFn: () => fetchProgress(initial.id),
    initialData: initial,
    refetchInterval: (q) => {
      const current = q.state.data;
      if (current && isTerminalStatus(current.status)) return false;
      return q.state.dataUpdateCount > FAST_POLLS ? SLOW_MS : FAST_MS;
    },
  });

  const lastStatus = useRef(initial.status);
  useEffect(() => {
    if (video.status === lastStatus.current) return;
    lastStatus.current = video.status;
    router.refresh();
  }, [video.status, router]);

  const retry = useMutation({
    mutationFn: () => postRetry(initial.id),
    onSuccess: async () => {
      toast.success("Back in the queue.");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn’t retry."),
  });

  const percent = Math.round(video.progress * 100);
  const comingSoon = isComingSoon(video.status, video.error?.code);
  // "now" = when this poll answered, so rendering stays pure; polls come every 2–5 s.
  const estimate = estimateRemainingMs({
    stages: video.stages,
    mediaMs: video.mediaDurationMs,
    now: dataUpdatedAt || Date.parse(video.stages.ingest.startedAt ?? "") || 0,
    downloadEtaSec: video.activity?.etaSec ?? null,
  });
  const active = video.status === "queued" || video.status === "processing";
  const note =
    video.status === "queued"
      ? video.waitUntil
        ? "Waiting for AI capacity"
        : "Waiting in line"
      : video.status === "processing"
        ? video.stage
          ? STAGE_LABELS[video.stage]
          : "Starting…"
        : null;

  return (
    <section aria-label="Progress" className="flex w-full flex-col gap-4">
      {comingSoon ? (
        <div className="flex gap-3 rounded-xl border border-primary/30 bg-primary/10 p-3.5 text-sm text-primary">
          <CircleCheckIcon className="mt-0.5 size-4.5 shrink-0" />
          <span>Your clips are ready. Titles, hooks and rendered videos come in a later update.</span>
        </div>
      ) : video.status === "failed" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3.5">
          <div role="alert" className="flex gap-3 text-sm text-destructive">
            <CircleAlertIcon className="mt-0.5 size-4.5 shrink-0" />
            <span>{video.error?.message ?? "Processing failed."}</span>
          </div>
          {video.error?.retryable && (
            <Button variant="outline" className="self-start" onClick={() => retry.mutate()} disabled={retry.isPending}>
              <RotateCwIcon className={retry.isPending ? "animate-spin" : undefined} />
              {retry.isPending ? "Retrying…" : "Try again"}
            </Button>
          )}
        </div>
      ) : video.status === "ready" ? (
        <div className="flex gap-3 rounded-xl border border-primary/30 bg-primary/10 p-3.5 text-sm text-primary">
          <CircleCheckIcon className="mt-0.5 size-4.5 shrink-0" />
          <span>Processing finished.</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-heading text-3xl font-bold tracking-tight tabular-nums">{percent}%</span>
            <span aria-live="polite" className={video.status === "processing" ? "text-sm text-info" : "text-sm text-muted-foreground"}>
              {note}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Processing progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-2 overflow-hidden rounded-full bg-border"
          >
            <div className="h-full rounded-full bg-info transition-[width] duration-700" style={{ width: `${percent}%` }} />
          </div>
          {estimate && !video.waitUntil && <TimeLeft estimate={estimate} queued={video.status === "queued"} />}
          {video.status === "queued" && video.waitUntil && (
            <div role="status" className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-[13px] leading-snug text-warning">
              <ClockIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                Today&apos;s free AI capacity is used up. Your video is saved and carries on by itself around{" "}
                <span suppressHydrationWarning className="font-semibold">
                  {resumeLabel(video.waitUntil)}
                </span>
                . You don&apos;t need to do anything.
              </span>
            </div>
          )}
          {video.activity && <TransferDetails activity={video.activity} />}
          {video.status === "queued" && video.workerOnline === false && (
            <div
              role="status"
              className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-[13px] leading-snug text-warning"
            >
              <ServerOffIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                The processing server is offline right now. Your video is saved and starts automatically as soon as
                it&apos;s back.
              </span>
            </div>
          )}
        </div>
      )}

      {active ? (
        <>
          <StageList stages={video.stages} comingSoon={comingSoon} />
          <div className="flex gap-3 rounded-xl border bg-sunken p-3.5 text-[13px] leading-relaxed text-muted-foreground">
            <BellIcon className="mt-0.5 size-4 shrink-0" strokeWidth={1.8} />
            <span>You can close this tab. We keep working, and your clips will be waiting in My videos.</span>
          </div>
        </>
      ) : (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-subtle select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" />
            Show steps
          </summary>
          <div className="pt-4">
            <StageList stages={video.stages} comingSoon={comingSoon} />
          </div>
        </details>
      )}
    </section>
  );
}

/** "About 3 min left" — rough (shared/estimates.ts); honest when a stage runs long. */
function TimeLeft({ estimate, queued }: { estimate: RemainingEstimate; queued: boolean }) {
  const minutes = Math.round(estimate.remainingMs / 60_000);
  const text = estimate.slow
    ? "Taking longer than usual — still working on it"
    : minutes < 1
      ? "Less than a minute left"
      : `About ${minutes} min left${queued ? " once it starts" : ""}`;
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <ClockIcon className="size-3.5" strokeWidth={2} />
      {text}
    </span>
  );
}

type Activity = NonNullable<VideoProgressView["activity"]>;

/**
 * What a download is doing right now: bytes, speed, time left — and a plain-language
 * note when it's slow, so a long "Preparing video" doesn't look stuck.
 */
function TransferDetails({ activity: a }: { activity: Activity }) {
  if (a.kind === "waiting_transcription") {
    return (
      <div
        role="status"
        className="flex gap-2.5 rounded-lg border border-info/30 bg-info/10 px-3 py-2.5 text-[13px] leading-snug text-info"
      >
        <HourglassIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          The transcription service is at its hourly limit, so your video is waiting its turn
          {a.etaSec != null ? ` — ${formatTimeLeft(a.etaSec)} left` : ""}. It continues automatically.
        </span>
      </div>
    );
  }
  const what = a.kind === "download_youtube" ? "Downloading from YouTube" : "Fetching your upload";
  const slow = a.bytesPerSec > 0 && a.bytesPerSec < SLOW_TRANSFER_BYTES_PER_SEC;
  const left = a.etaSec != null ? formatTimeLeft(a.etaSec) : null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
        <span>
          {what} · <span className="font-mono">{formatBytes(a.doneBytes)}</span>
          {a.totalBytes ? (
            <>
              {" of "}
              <span className="font-mono">{formatBytes(a.totalBytes)}</span>
            </>
          ) : null}
          {a.bytesPerSec > 0 && (
            <>
              {" · "}
              <span className="font-mono">{formatSpeed(a.bytesPerSec)}</span>
            </>
          )}
        </span>
        {left && <span>{left} left</span>}
      </div>
      {slow && (
        <div
          role="status"
          className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-[13px] leading-snug text-warning"
        >
          <WifiLowIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            The connection is slow right now ({formatSpeed(a.bytesPerSec)}), so this step takes longer than usual
            {left ? ` — ${left} left for the download` : ""}. Nothing is wrong, and you can leave this page.
          </span>
        </div>
      )}
    </div>
  );
}
