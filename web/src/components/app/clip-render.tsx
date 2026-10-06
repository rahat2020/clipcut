"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, FilmIcon, LoaderCircleIcon, RotateCwIcon, WandSparklesIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { ClipCoverDialog, type CoverWordsInput } from "@/components/app/clip-cover";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RenderView } from "@/lib/videos/renders";

const POLL_MS = 3_000;

type ApiError = { error?: { message?: string } };

async function fetchRenders(videoId: string): Promise<RenderView[]> {
  const res = await fetch(`/api/videos/${videoId}/renders`, { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as ({ renders?: RenderView[] } & ApiError) | null;
  if (!res.ok || !body?.renders) throw new Error(body?.error?.message ?? "Couldn’t load renders.");
  return body.renders;
}

export async function postRender(clipId: string): Promise<RenderView> {
  const res = await fetch(`/api/clips/${clipId}/render`, { method: "POST" });
  const body = (await res.json().catch(() => null)) as ({ render?: RenderView } & ApiError) | null;
  if (!res.ok || !body?.render) throw new Error(body?.error?.message ?? "Couldn’t start rendering. Please try again.");
  return body.render;
}

const active = (r: RenderView | undefined) => r?.status === "queued" || r?.status === "rendering";

/**
 * Every clip's latest render for this video, polled while one is rendering or the video is
 * still processing (the pipeline renders the best clips itself).
 */
export function useRenders(videoId: string, initial: RenderView[], processing: boolean) {
  return useQuery({
    queryKey: ["renders", videoId],
    queryFn: () => fetchRenders(videoId),
    initialData: initial,
    refetchInterval: (q) => (processing || (q.state.data ?? []).some(active) ? POLL_MS : false),
  });
}

/**
 * The selected clip as a finished 9:16 MP4: preview + Download when rendered, otherwise a
 * way to render it (Step 12). Step 13 adds trim / framing / caption style next to this.
 */
export function ClipRender({
  videoId,
  clipId,
  rank,
  render,
  processing,
  expired,
  cover,
}: {
  videoId: string;
  clipId: string;
  rank: number;
  render: RenderView | undefined;
  processing: boolean;
  expired: boolean;
  /** Words to start the cover with (Step 15.5 / 15.6). */
  cover: CoverWordsInput;
}) {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => postRender(clipId),
    onSuccess: (view) => {
      queryClient.setQueryData<RenderView[]>(["renders", videoId], (old = []) => [...old.filter((r) => r.clipId !== clipId), view]);
    },
    onError: (err) => toast.error(err.message),
  });

  const status = render?.status;
  const ready = status === "ready" && render?.previewUrl && render.downloadUrl;
  const percent = Math.round((render?.progress ?? 0) * 100);

  let line: ReactNode;
  let action: ReactNode = null;
  if (expired) {
    line = "This video’s files have expired, so clips can’t be rendered or downloaded.";
  } else if (ready) {
    line = render.outdated
      ? "Made with older settings — render again for the current look."
      : `Ready${render.bytes ? ` · ${formatBytes(render.bytes)}` : ""} · captions burned in`;
    action = (
      <div className="flex flex-wrap gap-2">
        <a href={render.downloadUrl!} className={buttonVariants({ size: "sm", variant: render.outdated ? "outline" : "default" })}>
          <DownloadIcon />
          Download
        </a>
        {render.coverFrames.length > 0 && <ClipCoverDialog frames={render.coverFrames} rank={rank} words={cover} />}
        {render.outdated && (
          <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? <LoaderCircleIcon className="animate-spin" /> : <RotateCwIcon />}
            Render again
          </Button>
        )}
      </div>
    );
  } else if (status === "rendering") {
    line = `Rendering… ${percent}%`;
  } else if (status === "queued") {
    line = "Waiting to render…";
  } else if (status === "failed") {
    line = <span className="text-destructive">{render?.error ?? "Rendering failed."}</span>;
    action = (
      <Button variant="outline" size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
        <RotateCwIcon />
        Try again
      </Button>
    );
  } else if (processing) {
    line = "The best clips render once processing finishes; you can render this one after that.";
  } else {
    line = "Not rendered yet. Rendering makes a 9:16 MP4 with captions — about a minute.";
    action = (
      <Button variant="outline" size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
        {start.isPending ? <LoaderCircleIcon className="animate-spin" /> : <WandSparklesIcon />}
        Render clip
      </Button>
    );
  }

  return (
    <div className="flex gap-4 rounded-xl border bg-sunken p-3">
      <div className="relative flex aspect-[9/16] w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-background [@media(max-height:700px)]:w-20">
        {ready && !expired ? (
          <video
            key={render.id}
            src={render.previewUrl!}
            controls
            playsInline
            preload="metadata"
            aria-label={`Clip ${rank}, rendered`}
            className="size-full object-cover"
          />
        ) : active(render) ? (
          <LoaderCircleIcon className="size-5 animate-spin text-info" />
        ) : (
          <FilmIcon className="size-5 text-subtle" strokeWidth={1.8} />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2.5">
        <span className="text-sm font-medium">9:16 clip</span>
        <span className={cn("text-[13px] leading-snug", active(render) ? "text-info" : "text-muted-foreground")}>{line}</span>
        {status === "rendering" && (
          <div
            role="progressbar"
            aria-label="Render progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 max-w-60 overflow-hidden rounded-full bg-border"
          >
            <div className="h-full rounded-full bg-info transition-[width] duration-500" style={{ width: `${percent}%` }} />
          </div>
        )}
        {action && <div>{action}</div>}
      </div>
    </div>
  );
}
