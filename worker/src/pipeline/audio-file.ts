import { stat } from "node:fs/promises";
import path from "node:path";

import { downloadPrivateFile } from "../services/storage/cloudinary";
import { AppError } from "../shared";
import type { StageContext } from "./stages/types";

/** The audio file from the audio stage: in this job's scratch folder, or fetched from Cloudinary. */
export async function ensureAudio(ctx: StageContext): Promise<string> {
  const { video, scratchDir, run } = ctx;
  const format = video.audio?.format || "ogg";
  const local = path.join(scratchDir, `audio.${format}`);
  const exists = await stat(local).then(
    (s) => s.size > 0,
    () => false,
  );
  if (exists) return local;

  const publicId = video.audio?.publicId;
  if (!publicId) throw new AppError("INTERNAL", { message: "The audio step didn't finish." });
  let bytes: number | null;
  try {
    bytes = await downloadPrivateFile({ publicId, format, dest: local, signal: run.signal });
  } catch (cause) {
    if (run.signal.aborted) throw cause;
    throw new AppError("STORAGE_FAILED", { cause });
  }
  if (bytes === null) throw new AppError("INTERNAL", { message: "The extracted audio is missing. Please try again." });
  return local;
}
