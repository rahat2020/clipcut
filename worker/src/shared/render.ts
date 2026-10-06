// GENERATED — do not edit. Source: shared/src/render.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { createHash } from "node:crypto";

import { captionStyle } from "./caption-styles";
import type { AspectRatio, Language, Script } from "./enums";

/**
 * What a render is (Step 12): the spec that decides the output pixels, its hash (one
 * render per clip × spec, docs/SCHEMA.md §3.6), and the timing rules of the render queue.
 * Used by web/ (the "Render" button) and the worker (auto-render + the queue).
 */

/**
 * Bump when the encoder or caption code changes the pixels for the same spec: the hash
 * changes with it, so the next request renders again instead of reusing an old MP4.
 */
export const RENDER_ENGINE_VERSION = "render@2"; // @2: captions lower (Rahat, 2026-10-02), sound/size check

/** Output size per aspect ratio (1080 on the short side — what Reels/Shorts/TikTok want). */
export const RENDER_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

export type RenderSpec = {
  startMs: number;
  endMs: number;
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  /** -1 = far left … 0 = centre … 1 = far right. */
  cropOffsetX: number;
  captionStyleId: string;
  captionScript: Script;
  burnCaptions: boolean;
  transcriptVersion: number;
};

type ClipForSpec = {
  startMs: number;
  endMs: number;
  edit?: { cropOffsetX?: number | null; captionStyleId?: string | null } | null;
};

/** Caption letters: English → Latin; Bangla → Bangla script unless the user chose Banglish (Step 15). */
export function captionScriptFor(video: { language: Language; captionScript?: Script | null }): Script {
  return video.language === "en" ? "Latn" : (video.captionScript ?? "Beng");
}

/** The video facts a render spec needs, from a video document. */
export function specVideo(video: {
  language: Language;
  options?: { aspectRatio?: AspectRatio | null; captionScript?: Script | null } | null;
}): SpecVideo {
  return { language: video.language, aspectRatio: video.options?.aspectRatio ?? null, captionScript: video.options?.captionScript ?? null };
}

export type SpecVideo = { language: Language; aspectRatio?: AspectRatio | null; captionScript?: Script | null };

/** The spec for a clip as it stands. */
export function renderSpecForClip(clip: ClipForSpec, video: SpecVideo, transcriptVersion: number): RenderSpec {
  const aspectRatio = video.aspectRatio ?? "9:16";
  const size = RENDER_SIZES[aspectRatio];
  const offset = clip.edit?.cropOffsetX ?? 0;
  return {
    startMs: Math.round(clip.startMs),
    endMs: Math.round(clip.endMs),
    aspectRatio,
    width: size.width,
    height: size.height,
    cropOffsetX: Math.round(Math.min(Math.max(offset, -1), 1) * 100) / 100,
    captionStyleId: captionStyle(clip.edit?.captionStyleId).id,
    captionScript: captionScriptFor(video),
    burnCaptions: true,
    transcriptVersion,
  };
}

/** SHA-256 of the spec with its keys in a fixed order (+ the engine version). */
export function renderSpecHash(spec: RenderSpec): string {
  const normalised = [
    RENDER_ENGINE_VERSION,
    spec.startMs,
    spec.endMs,
    spec.aspectRatio,
    spec.width,
    spec.height,
    spec.cropOffsetX.toFixed(2),
    spec.captionStyleId,
    spec.captionScript,
    spec.burnCaptions ? 1 : 0,
    spec.transcriptVersion,
  ];
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex");
}

export const RENDER_TIMING = {
  /** A `rendering` render touches `updatedAt` at least this often. */
  heartbeatMs: 30_000,
  /** Silent longer than this → its worker died; back to the queue (or failed). */
  stuckAfterMs: 3 * 60_000,
  /** Times a render may be (re)started before it's marked failed. */
  maxAttempts: 3,
  dispatchEveryMs: 3_000,
  recoverEveryMs: 60_000,
} as const;
