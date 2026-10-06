import { stat } from "node:fs/promises";
import path from "node:path";

import { AUDIO_FORMAT, audioBitrateKbps, extractAudio, TRANSCRIBE_MAX_BYTES } from "../../services/media/audio";
import { audioPublicId, uploadPrivateAudio } from "../../services/storage/cloudinary";
import { AppError } from "../../shared";
import { ensureSource } from "../source";
import type { StageHandler } from "./types";

/**
 * Audio: source → small mono 16 kHz Opus file for transcription, stored privately in
 * Cloudinary (`<folder>/audio/<userId>/<videoId>`) so the transcribe stage — possibly in a
 * later job — never needs the source video again. Writes `audio`.
 */
export const audio: StageHandler = async (ctx) => {
  const { video, run, log, scratchDir } = ctx;
  const durationMs = video.media?.durationMs;
  if (!durationMs) throw new AppError("INTERNAL", { message: "Video length is unknown — the ingest step didn't finish." });

  const source = await ensureSource(ctx, (f) => void run.reportProgress(f * 0.3).catch(() => {}));

  const bitrateKbps = audioBitrateKbps(durationMs);
  const output = path.join(scratchDir, `audio.${AUDIO_FORMAT}`);
  const t0 = Date.now();
  try {
    await extractAudio({
      input: source,
      output,
      durationMs,
      bitrateKbps,
      signal: run.signal,
      onProgress: (f) => void run.reportProgress(0.3 + f * 0.5).catch(() => {}),
    });
  } catch (cause) {
    if (run.signal.aborted) throw cause;
    throw new AppError("FFMPEG_FAILED", { message: "We couldn't read the audio in this video.", cause });
  }

  const { size } = await stat(output);
  if (size > TRANSCRIBE_MAX_BYTES) {
    // audioBitrateKbps() makes this impossible up to the 3-hour plan cap; guard anyway.
    throw new AppError("INTERNAL", { message: "The audio is too large to transcribe.", details: { size } });
  }
  log.info({ bitrateKbps, bytes: size, ms: Date.now() - t0 }, "audio extracted");

  const publicId = audioPublicId(String(video.userId), String(video._id));
  let uploaded;
  try {
    uploaded = await uploadPrivateAudio(output, publicId);
  } catch (cause) {
    throw new AppError("STORAGE_FAILED", { cause });
  }
  await run.reportProgress(1);

  const audioDoc = { publicId, format: uploaded.format || AUDIO_FORMAT, bitrateKbps, bytes: uploaded.bytes || size };
  await run.setFields({ audio: audioDoc });
  ctx.video.audio = audioDoc;
};
