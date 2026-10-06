/**
 * Cloudinary rules for source-video uploads. No `server-only` and no env import, so
 * scripts/upload-smoke-test.ts can run it; server code gets the config from lib/cloudinary.ts.
 *
 * Facts checked against the real account (2026-09-28; npm run upload:smoke re-checks them):
 * - The account uses dynamic folders: `public_id` carries the path, `asset_folder` is
 *   only for the Media Library view.
 * - One signature covers every chunk of a chunked upload (same X-Unique-Upload-Id).
 * - `type: "authenticated"` makes the file private: the plain URL is 404, a signed URL works.
 * - The Admin API returns duration / has_audio only with `media_metadata: true`.
 */
import { v2 as cloudinary } from "cloudinary";

export type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** "dev" locally, "prod" in production (CLOUDINARY_FOLDER). */
  baseFolder: string;
};

/** Chunk size for browser uploads. Cloudinary needs ≥ 5 MB per chunk except the last. */
export const UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

/** A signed upload is accepted for about an hour after its timestamp. */
const SIGNATURE_TTL_MS = 55 * 60_000;

function configure(cfg: CloudinaryConfig) {
  cloudinary.config({ cloud_name: cfg.cloudName, api_key: cfg.apiKey, api_secret: cfg.apiSecret, secure: true });
  return cloudinary;
}

export function sourceAssetFolder(cfg: CloudinaryConfig, userId: string): string {
  return `${cfg.baseFolder}/sources/${userId}`;
}

/** The only public id a given user may upload a given video to. */
export function sourcePublicId(cfg: CloudinaryConfig, userId: string, videoId: string): string {
  return `${sourceAssetFolder(cfg, userId)}/${videoId}`;
}

export type UploadTicket = {
  videoId: string;
  publicId: string;
  uploadUrl: string;
  chunkBytes: number;
  expiresAt: string;
  /** Form fields sent with every chunk. Contains no secret — the signature is one-way. */
  fields: Record<string, string>;
};

/**
 * Signs a direct browser → Cloudinary upload for exactly one public id. The signature
 * covers public_id, asset_folder and type, so the browser can't change where the file
 * lands or make it public.
 */
export function createUploadTicket(cfg: CloudinaryConfig, args: { userId: string; videoId: string; now?: Date }): UploadTicket {
  const now = args.now ?? new Date();
  const params = {
    timestamp: String(Math.floor(now.getTime() / 1000)),
    public_id: sourcePublicId(cfg, args.userId, args.videoId),
    asset_folder: sourceAssetFolder(cfg, args.userId),
    type: "authenticated",
  };
  const signature = configure(cfg).utils.api_sign_request(params, cfg.apiSecret);
  return {
    videoId: args.videoId,
    publicId: params.public_id,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cfg.cloudName}/video/upload`,
    chunkBytes: UPLOAD_CHUNK_BYTES,
    expiresAt: new Date(now.getTime() + SIGNATURE_TTL_MS).toISOString(),
    fields: { ...params, api_key: cfg.apiKey, signature },
  };
}

export type UploadedVideo = {
  publicId: string;
  bytes: number;
  format: string;
  durationMs: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
};

type AdminResource = {
  bytes?: number;
  format?: string;
  duration?: number;
  width?: number;
  height?: number;
  frame_rate?: number;
  has_video?: boolean;
  has_audio?: boolean;
  codec?: string;
  audio_codec?: string;
};

function isNotFound(err: unknown): boolean {
  const e = err as { error?: { http_code?: number }; http_code?: number };
  return e?.error?.http_code === 404 || e?.http_code === 404;
}

/**
 * What Cloudinary actually stored — the authoritative size, length and streams, never
 * the numbers the browser reported. Null when nothing exists at that public id.
 */
export async function inspectUploadedVideo(cfg: CloudinaryConfig, publicId: string): Promise<UploadedVideo | null> {
  let r: AdminResource;
  try {
    r = (await configure(cfg).api.resource(publicId, {
      resource_type: "video",
      type: "authenticated",
      media_metadata: true,
    })) as AdminResource;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  return {
    publicId,
    bytes: r.bytes ?? 0,
    format: r.format ?? "",
    durationMs: Math.round((r.duration ?? 0) * 1000),
    width: r.width ?? null,
    height: r.height ?? null,
    fps: r.frame_rate ?? null,
    hasVideo: r.has_video ?? (r.width ?? 0) > 0,
    hasAudio: r.has_audio ?? false,
    videoCodec: r.codec ?? null,
    audioCodec: r.audio_codec ?? null,
  };
}

/** Deletes a source video. Returns false instead of throwing so callers can retry later. */
export async function deleteSourceVideo(cfg: CloudinaryConfig, publicId: string): Promise<boolean> {
  try {
    const res = (await configure(cfg).uploader.destroy(publicId, {
      resource_type: "video",
      type: "authenticated",
      invalidate: true,
    })) as { result?: string };
    return res.result === "ok" || res.result === "not found";
  } catch {
    return false;
  }
}

/**
 * Deletes a video's JSON files — private "raw" assets under
 * <folder>/transcripts/<userId>/<videoId>/ (word timestamps, raw Whisper responses) and
 * <folder>/analysis/<userId>/<videoId>/ (clip-selection prompts + answers). False on
 * failure, to retry later.
 */
export async function deleteVideoDataFiles(cfg: CloudinaryConfig, userId: string, videoId: string): Promise<boolean> {
  try {
    const api = configure(cfg).api;
    for (const kind of ["transcripts", "analysis"]) {
      await api.delete_resources_by_prefix(`${cfg.baseFolder}/${kind}/${userId}/${videoId}/`, {
        resource_type: "raw",
        type: "authenticated",
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes EVERY file of one user (admin "delete user data"): sources and extracted audio
 * (video assets) and transcript/analysis JSON (raw assets), by folder prefix — so files
 * of videos that never finished are caught too. False on any failure, to retry later.
 */
export async function deleteUserFiles(cfg: CloudinaryConfig, userId: string): Promise<boolean> {
  const api = configure(cfg).api;
  const groups: { kinds: string[]; resource_type: "video" | "image" | "raw" }[] = [
    { kinds: ["sources", "audio", "renders"], resource_type: "video" },
    { kinds: ["renders"], resource_type: "image" }, // cover frames (Step 15.5)
    { kinds: ["transcripts", "analysis"], resource_type: "raw" },
  ];
  try {
    for (const g of groups) {
      for (const kind of g.kinds) {
        await api.delete_resources_by_prefix(`${cfg.baseFolder}/${kind}/${userId}/`, {
          resource_type: g.resource_type,
          type: "authenticated",
        });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes a video's rendered clips and their cover frames (<folder>/renders/<userId>/<videoId>/ —
 * MP4s are video assets, covers image assets). False on failure, to retry later.
 */
export async function deleteVideoRenders(cfg: CloudinaryConfig, userId: string, videoId: string): Promise<boolean> {
  try {
    for (const resource_type of ["video", "image"] as const) {
      await configure(cfg).api.delete_resources_by_prefix(`${cfg.baseFolder}/renders/${userId}/${videoId}/`, { resource_type, type: "authenticated" });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Signed URL of a rendered clip. With `downloadAs`, Cloudinary sends it as an attachment
 * with that file name (letters, digits, "-" and "_" only).
 */
export function signedRenderUrl(cfg: CloudinaryConfig, publicId: string, downloadAs?: string): string {
  return configure(cfg).url(publicId, {
    resource_type: "video",
    type: "authenticated",
    sign_url: true,
    secure: true,
    format: "mp4",
    ...(downloadAs ? { flags: `attachment:${downloadAs.replace(/[^A-Za-z0-9_-]/g, "_")}` } : {}),
  });
}

/** Signed URL of a cover frame (private JPEG next to a render, Step 15.5). */
export function signedCoverFrameUrl(cfg: CloudinaryConfig, publicId: string): string {
  return configure(cfg).url(publicId, { resource_type: "image", type: "authenticated", sign_url: true, secure: true, format: "jpg" });
}

/** Signed (non-expiring) URL of the private source video, for the in-app player. */
export function signedSourceUrl(cfg: CloudinaryConfig, publicId: string): string {
  return configure(cfg).url(publicId, { resource_type: "video", type: "authenticated", sign_url: true, secure: true });
}

/** Signed JPEG poster frame, 480 px wide, from a couple of seconds in (first frames are often black). */
export function signedThumbnailUrl(cfg: CloudinaryConfig, publicId: string, durationMs: number): string {
  const offset = durationMs > 4_000 ? "2" : "0";
  return configure(cfg).url(publicId, {
    resource_type: "video",
    type: "authenticated",
    sign_url: true,
    secure: true,
    format: "jpg",
    transformation: [{ start_offset: offset, width: 480, crop: "limit" }],
  });
}
