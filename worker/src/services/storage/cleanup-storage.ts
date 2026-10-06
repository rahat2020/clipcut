import { CLEANUP_TIMING } from "../../shared";
import { env } from "../../config/env";
import { cloudinary } from "./cloudinary";

/**
 * Cloudinary side of the cleanup job (Step 17, docs/SCHEMA.md §8): delete everything one video
 * owns, and list which videos have files. Everything is private (`type: authenticated`) and filed
 * by `<folder>/<kind>/<userId>/<videoId>…`:
 *
 *   sources/    video   the uploaded source (public id ends with the video id)
 *   audio/      video   the extracted soundtrack (Cloudinary files audio under "video")
 *   renders/    video + image   rendered MP4s and their cover frames
 *   transcripts/, analysis/   raw   JSON files
 *
 * Video ids are always 24 hex characters, so a prefix of `<…>/<videoId>` can't hit another video.
 */

type ResourceType = "video" | "image" | "raw";

/** Where each kind of file lives. `folder` = the video has a folder of files, else one public id. */
const KINDS: { kind: string; resourceType: ResourceType; folder: boolean }[] = [
  { kind: "sources", resourceType: "video", folder: false },
  { kind: "audio", resourceType: "video", folder: false },
  { kind: "renders", resourceType: "video", folder: true },
  { kind: "renders", resourceType: "image", folder: true },
  { kind: "transcripts", resourceType: "raw", folder: true },
  { kind: "analysis", resourceType: "raw", folder: true },
];

const VIDEO_ID = /^[a-f0-9]{24}$/;
/** Cloudinary deletes at most this many per call and says `partial` when there are more. */
const MAX_DELETE_ROUNDS = 20;

/** True when Cloudinary says "too many Admin API calls" (HTTP 420 / 429): stop and try later. */
export function isRateLimited(err: unknown): boolean {
  const e = err as { http_code?: number; error?: { http_code?: number } } | null;
  const code = e?.http_code ?? e?.error?.http_code;
  return code === 420 || code === 429;
}

/** Deletes every file of one video. Throws when Cloudinary refuses (nothing is marked done then). */
export async function deleteVideoFiles(userId: string, videoId: string): Promise<void> {
  if (!VIDEO_ID.test(videoId) || !/^[a-f0-9]{24}$/.test(userId)) throw new Error("refusing to delete: bad user or video id");
  for (const { kind, resourceType, folder } of KINDS) {
    const prefix = `${env.CLOUDINARY_FOLDER}/${kind}/${userId}/${videoId}${folder ? "/" : ""}`;
    for (let round = 0; round < MAX_DELETE_ROUNDS; round++) {
      const res = (await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: resourceType, type: "authenticated" })) as {
        partial?: boolean;
      };
      if (!res.partial) break;
    }
  }
}

/** A video that has files in Cloudinary: whose, and when its newest file was made. */
export type StoredVideo = { userId: string; videoId: string; newestAt: Date; files: number };

type Listed = { resources?: { public_id: string; created_at?: string }[]; next_cursor?: string };

/**
 * Every video that has files under this folder, read from Cloudinary's file list (500 per call,
 * `maxListPages` calls per kind). Used to find files no video owns.
 */
export async function listStoredVideos(opts: { maxPages?: number } = {}): Promise<StoredVideo[]> {
  const maxPages = opts.maxPages ?? CLEANUP_TIMING.maxListPages;
  const found = new Map<string, StoredVideo>();
  for (const { kind, resourceType } of KINDS) {
    const prefix = `${env.CLOUDINARY_FOLDER}/${kind}/`;
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = (await cloudinary.api.resources({
        type: "authenticated",
        resource_type: resourceType,
        prefix,
        max_results: 500,
        ...(cursor ? { next_cursor: cursor } : {}),
      })) as Listed;
      for (const r of res.resources ?? []) {
        // <folder>/<kind>/<userId>/<videoId>[/...]
        const parts = r.public_id.slice(prefix.length).split("/");
        const [userId, videoId] = parts;
        if (!userId || !videoId || !VIDEO_ID.test(userId) || !VIDEO_ID.test(videoId)) continue;
        const at = r.created_at ? new Date(r.created_at) : new Date();
        const key = `${userId}/${videoId}`;
        const prev = found.get(key);
        if (prev) {
          prev.files++;
          if (at > prev.newestAt) prev.newestAt = at;
        } else {
          found.set(key, { userId, videoId, newestAt: at, files: 1 });
        }
      }
      cursor = res.next_cursor;
      if (!cursor) break;
    }
  }
  return [...found.values()];
}
