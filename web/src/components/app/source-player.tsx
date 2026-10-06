"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The video page's player and a way for other panels (clip list, timeline, transcript)
 * to say "play from here to there". Uploaded files play in a <video> that pauses itself at
 * the end of a clip; YouTube uses its embed's own start/end parameters.
 *
 * `selectedId` is the clip the user picked last — it stays selected after the clip ends,
 * so its details keep showing. `frame` is the 9:16 framing being adjusted (Step 13): while
 * set, the player shades what the clip will leave out.
 */

export type PlayerSource =
  | { kind: "youtube"; videoId: string }
  | { kind: "file"; src: string; poster: string | null }
  | { kind: "none" };

type PlayRequest = { startMs: number; endMs: number | null; nonce: number };

type PlayerContextValue = {
  request: PlayRequest | null;
  selectedId: string | null;
  /** Select a clip and play just its part. */
  playClip: (id: string, startMs: number, endMs: number) => void;
  /** Play from a moment to the end (a transcript line). */
  playFrom: (startMs: number) => void;
  select: (id: string | null) => void;
  stop: () => void;
  /** Horizontal crop offset (-1 … 1) to preview on the player, or null for none. */
  frame: number | null;
  setFrame: (offset: number | null) => void;
};

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children, initialSelectedId = null }: { children: ReactNode; initialSelectedId?: string | null }) {
  const [request, setRequest] = useState<PlayRequest | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [frame, setFrame] = useState<number | null>(null);
  const playClip = useCallback((id: string, startMs: number, endMs: number) => {
    setSelectedId(id);
    setRequest((prev) => ({ startMs, endMs, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const playFrom = useCallback((startMs: number) => {
    setRequest((prev) => ({ startMs, endMs: null, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const stop = useCallback(() => setRequest(null), []);
  const value = useMemo(
    () => ({ request, selectedId, playClip, playFrom, select: setSelectedId, stop, frame, setFrame }),
    [request, selectedId, playClip, playFrom, stop, frame],
  );
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return ctx;
}

const YOUTUBE_EMBED = "https://www.youtube-nocookie.com/embed/";

function youtubeSrc(videoId: string, request: PlayRequest | null): string {
  if (!request) return `${YOUTUBE_EMBED}${videoId}`;
  const params = new URLSearchParams({ start: String(Math.floor(request.startMs / 1000)), autoplay: "1" });
  if (request.endMs != null) params.set("end", String(Math.ceil(request.endMs / 1000)));
  return `${YOUTUBE_EMBED}${videoId}?${params.toString()}`;
}

/**
 * Where a 9:16 crop with this offset sits in the 16:9 player box, as fractions of the box.
 * Mirrors the encoder's crop (worker services/render/encode.ts): the biggest 9:16 box of the
 * picture, centred vertically, moved sideways. `aspect` = the source's width ÷ height
 * (YouTube is assumed 16:9; a file shows letterboxed with object-contain).
 */
export function frameBox(aspect: number, offset: number) {
  const box = 16 / 9;
  const vw = aspect >= box ? 1 : aspect / box;
  const vh = aspect >= box ? box / aspect : 1;
  const target = 9 / 16;
  const width = vw * (aspect > target ? target / aspect : 1);
  const height = vh * (aspect > target ? 1 : aspect / target);
  const o = Math.min(Math.max(offset, -1), 1);
  return { left: (1 - vw) / 2 + ((vw - width) / 2) * (1 + o), top: (1 - vh) / 2 + (vh - height) / 2, width, height };
}

export function SourcePlayer({ source, aspect, className }: { source: PlayerSource; aspect?: number | null; className?: string }) {
  const { request, stop, frame } = usePlayer();
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // On phones the list is below the player: bring the player into view when something plays.
  useEffect(() => {
    if (request) boxRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [request]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !request || source.kind !== "file") return;
    el.currentTime = request.startMs / 1000;
    el.play().catch(() => {});
    if (request.endMs == null) return;
    const end = request.endMs;
    const onTime = () => {
      if (el.currentTime * 1000 >= end) {
        el.pause();
        stop();
      }
    };
    el.addEventListener("timeupdate", onTime);
    return () => el.removeEventListener("timeupdate", onTime);
  }, [request, source.kind, stop]);

  return (
    <div ref={boxRef} className={cn("relative aspect-video scroll-mt-16 overflow-hidden rounded-2xl border bg-raised", className)}>
      {source.kind === "youtube" ? (
        <iframe
          // A new request remounts the embed with its start/end (whole seconds).
          key={request?.nonce ?? 0}
          src={youtubeSrc(source.videoId, request)}
          title="YouTube video player"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          className="size-full"
        />
      ) : source.kind === "file" ? (
        <video
          ref={videoRef}
          controls
          preload="metadata"
          poster={source.poster ?? undefined}
          src={source.src}
          className="size-full bg-black object-contain"
        />
      ) : (
        <div className="flex size-full items-center justify-center px-6 text-center text-sm text-subtle">
          The source file has been removed.
        </div>
      )}
      {frame !== null && source.kind !== "none" && <FrameOverlay aspect={source.kind === "youtube" ? 16 / 9 : (aspect ?? 16 / 9)} offset={frame} />}
    </div>
  );
}

/** The 9:16 frame on top of the player; everything outside it is shaded. Clicks go through to the player. */
function FrameOverlay({ aspect, offset }: { aspect: number; offset: number }) {
  const b = frameBox(aspect, offset);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <div
        className="absolute rounded-sm border-2 border-primary shadow-[0_0_0_9999px_color-mix(in_srgb,var(--background)_62%,transparent)] transition-[left] duration-150"
        style={{ left: `${b.left * 100}%`, top: `${b.top * 100}%`, width: `${b.width * 100}%`, height: `${b.height * 100}%` }}
      >
        <span className="absolute top-1.5 left-1.5 rounded bg-primary px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary-foreground">9:16</span>
      </div>
    </div>
  );
}
