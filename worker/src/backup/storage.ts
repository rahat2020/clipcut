import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { env } from "../config/env";
import { BACKUP_TIMING } from "../shared";
import { cloudinary } from "../services/storage/cloudinary";

/**
 * Where database backups live: private raw files in Cloudinary under
 * `<folder>/backups/<db>/<file>` (authenticated, never public). `folder` defaults to this
 * environment's `CLOUDINARY_FOLDER`; tests pass their own. The cleanup job never touches this
 * folder (it only looks at sources, audio, renders, transcripts and analysis).
 */

export const backupPrefix = (db: string, folder = env.CLOUDINARY_FOLDER) => `${folder}/backups/${db}/`;

const common = { resource_type: "raw", type: "authenticated" } as const;

/** Uploads one backup file; throws when it is too big for Cloudinary's free plan. */
export async function uploadBackup(file: string, name: string, db: string, folder?: string): Promise<{ publicId: string; bytes: number }> {
  const { size } = await stat(file);
  if (size > BACKUP_TIMING.maxBytes) {
    throw new Error(`the backup is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${(BACKUP_TIMING.maxBytes / 1024 / 1024).toFixed(0)} MB Cloudinary's free plan accepts for raw files — keep backups somewhere else (npm run db:backup) or upgrade`);
  }
  const prefix = backupPrefix(db, folder);
  const res = await cloudinary.uploader.upload(file, {
    ...common,
    public_id: `${prefix}${name}`,
    asset_folder: prefix.replace(/\/$/, ""),
    use_filename: false,
    unique_filename: false,
    overwrite: false,
  });
  return { publicId: res.public_id, bytes: res.bytes };
}

/** Public ids of this database's backups in Cloudinary (newest last by name). */
export async function listBackups(db: string, folder?: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const res = (await cloudinary.api.resources({ ...common, prefix: backupPrefix(db, folder), max_results: 100, ...(cursor ? { next_cursor: cursor } : {}) })) as {
      resources?: { public_id: string }[];
      next_cursor?: string;
    };
    ids.push(...(res.resources ?? []).map((r) => r.public_id));
    cursor = res.next_cursor;
  } while (cursor);
  return ids.sort();
}

export async function deleteBackup(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { ...common, invalidate: true });
}

/**
 * Downloads one backup to `file`. Cloudinary's normal delivery links refuse a .gz file ("401
 * Untrusted File Access"), so this uses the API-signed download link, which is allowed.
 */
export async function downloadBackup(publicId: string, file: string): Promise<void> {
  const url = cloudinary.utils.private_download_url(publicId, "", { resource_type: "raw", type: "authenticated" } as never);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`couldn't download the backup (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
}
