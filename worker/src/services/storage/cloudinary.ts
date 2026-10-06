import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { v2 as cloudinary } from "cloudinary";

import { env } from "../../config/env";
import { TransferMeter, type TransferStats } from "../../lib/transfer";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

export { cloudinary };

type AdminResource = {
  bytes?: number;
  duration?: number;
  has_audio?: boolean;
  has_video?: boolean;
  width?: number;
};

export type SourceFacts = { bytes: number; durationMs: number; hasAudio: boolean; hasVideo: boolean };

function isNotFound(err: unknown): boolean {
  const e = err as { error?: { http_code?: number }; http_code?: number };
  return e?.error?.http_code === 404 || e?.http_code === 404;
}

/** What Cloudinary holds for a private source video, or null if it no longer exists. */
export async function inspectSourceVideo(publicId: string): Promise<SourceFacts | null> {
  let r: AdminResource;
  try {
    r = (await cloudinary.api.resource(publicId, {
      resource_type: "video",
      type: "authenticated",
      media_metadata: true,
    })) as AdminResource;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  return {
    bytes: r.bytes ?? 0,
    durationMs: Math.round((r.duration ?? 0) * 1000),
    hasAudio: r.has_audio ?? false,
    hasVideo: r.has_video ?? (r.width ?? 0) > 0,
  };
}

/** Where a video's extracted audio lives (private, next to the sources). */
export function audioPublicId(userId: string, videoId: string): string {
  return `${env.CLOUDINARY_FOLDER}/audio/${userId}/${videoId}`;
}

/** Signed URL of a private file (video or audio — Cloudinary files audio under "video"). */
export function signedPrivateUrl(publicId: string, format?: string): string {
  return cloudinary.url(publicId, {
    resource_type: "video",
    type: "authenticated",
    sign_url: true,
    secure: true,
    ...(format ? { format } : {}),
  });
}

/**
 * Streams a private file to disk (written to `<dest>.part`, renamed when complete, so a
 * half-downloaded file is never mistaken for a whole one). Returns bytes written.
 * Returns null if the file doesn't exist (404).
 */
export async function downloadPrivateFile(args: {
  publicId: string;
  format?: string;
  dest: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number, transfer: TransferStats) => void;
}): Promise<number | null> {
  const res = await fetch(signedPrivateUrl(args.publicId, args.format), { signal: args.signal });
  if (res.status === 404) return null;
  if (!res.ok || !res.body) throw new Error(`Cloudinary download failed: HTTP ${res.status}`);

  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const meter = new TransferMeter();
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      args.onProgress?.(total > 0 ? Math.min(received / total, 1) : 0, meter.update(received, total || null));
      cb(null, chunk);
    },
  });

  const part = `${args.dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), counter, createWriteStream(part), {
      signal: args.signal,
    });
    await rename(part, args.dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  return received;
}

/** Where a video's transcript files live: `<folder>/transcripts/<userId>/<videoId>/<name>.json`. */
export function transcriptFilePublicId(userId: string, videoId: string, name: string): string {
  return `${env.CLOUDINARY_FOLDER}/transcripts/${userId}/${videoId}/${name}.json`;
}

/** One clip-selection run's prompt + raw answer: `<folder>/analysis/<userId>/<videoId>/<runId>.json`. */
export function analysisFilePublicId(userId: string, videoId: string, analysisRunId: string): string {
  return `${env.CLOUDINARY_FOLDER}/analysis/${userId}/${videoId}/${analysisRunId}.json`;
}

/**
 * Stores JSON as a private "raw" file (word timestamps, untouched provider responses —
 * too big for MongoDB's 0.5 GB). Raw public ids keep their extension.
 */
export async function uploadPrivateJson(publicId: string, data: unknown): Promise<{ bytes: number }> {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  const r = await new Promise<{ bytes?: number }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        type: "authenticated",
        public_id: publicId,
        asset_folder: publicId.split("/").slice(0, -1).join("/"),
        overwrite: true,
        invalidate: true,
      },
      (err, result) => (err ? reject(err) : resolve(result ?? {})),
    );
    stream.end(body);
  });
  return { bytes: r.bytes ?? body.length };
}

/** Reads back a private JSON file (null if it doesn't exist). */
export async function readPrivateJson<T = unknown>(publicId: string): Promise<T | null> {
  const url = cloudinary.url(publicId, { resource_type: "raw", type: "authenticated", sign_url: true, secure: true });
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cloudinary read failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Uploads a local audio file as a private asset, replacing any earlier version. */
export async function uploadPrivateAudio(file: string, publicId: string): Promise<{ bytes: number; format: string }> {
  const r = (await cloudinary.uploader.upload(file, {
    resource_type: "video",
    type: "authenticated",
    public_id: publicId,
    // Dynamic folders: the Media Library folder is separate from the public id.
    asset_folder: publicId.split("/").slice(0, -1).join("/"),
    overwrite: true,
    invalidate: true,
  })) as { bytes?: number; format?: string };
  return { bytes: r.bytes ?? 0, format: r.format ?? "ogg" };
}

/** One rendered clip: `<folder>/renders/<userId>/<videoId>/<renderId>` (private, deleted with the video). */
export function renderPublicId(userId: string, videoId: string, renderId: string): string {
  return `${env.CLOUDINARY_FOLDER}/renders/${userId}/${videoId}/${renderId}`;
}

/** A cover frame of a render: `<render public id>-cover-<n>` (an image, deleted with the video's renders). */
export function coverFramePublicId(renderPublicIdValue: string, n: number): string {
  return `${renderPublicIdValue}-cover-${n}`;
}

/** Uploads a small JPEG as a private image (cover frames). */
export async function uploadPrivateImage(file: string, publicId: string): Promise<{ bytes: number }> {
  const r = await cloudinary.uploader.upload(file, {
    resource_type: "image",
    type: "authenticated",
    public_id: publicId,
    asset_folder: publicId.split("/").slice(0, -1).join("/"),
    overwrite: true,
    invalidate: true,
    timeout: 120_000,
  });
  return { bytes: r.bytes ?? 0 };
}

/**
 * Uploads a rendered MP4 as a private video. Chunked (20 MB), with a long timeout for slow
 * links; a clip is well under Cloudinary's 100 MB free-plan file limit.
 */
export async function uploadPrivateVideo(file: string, publicId: string): Promise<{ bytes: number; secureUrl: string; durationMs: number | null }> {
  const r = await new Promise<{ bytes?: number; secure_url?: string; duration?: number }>((resolve, reject) => {
    void cloudinary.uploader.upload_large(
      file,
      {
        resource_type: "video",
        type: "authenticated",
        public_id: publicId,
        asset_folder: publicId.split("/").slice(0, -1).join("/"),
        overwrite: true,
        invalidate: true,
        chunk_size: 20 * 1024 * 1024,
        timeout: 10 * 60_000,
      },
      (err, result) => (err ? reject(err instanceof Error ? err : new Error(JSON.stringify(err))) : resolve(result ?? {})),
    );
  });
  return { bytes: r.bytes ?? 0, secureUrl: r.secure_url ?? "", durationMs: r.duration ? Math.round(r.duration * 1000) : null };
}
