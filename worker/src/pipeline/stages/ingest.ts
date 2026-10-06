import { probeMedia } from "../../services/media/ffprobe";
import { probeYouTube } from "../../services/media/ytdlp";
import { AppError, getSettings } from "../../shared";
import { assertLengthAllowed, limitsFor } from "../limits";
import { ensureSource } from "../source";
import type { StageHandler } from "./types";

const PUBLIC_AVAILABILITY = new Set(["public", "unlisted"]);
const LIVE_STATES = new Set(["is_live", "is_upcoming", "post_live"]);

/**
 * Ingest: get the source into the scratch folder, measure it with ffprobe, and stop
 * early if it can't or mustn't be processed. Writes `media` (the ffprobe facts, which
 * every later stage trusts).
 *
 * YouTube is checked BEFORE downloading (live, private, age-gated, too long) so we don't
 * pull a 2-hour video just to reject it.
 */
export const ingest: StageHandler = async (ctx) => {
  const { video, run, log } = ctx;
  const { user, limits } = await limitsFor(video);

  if (video.source.type === "youtube") {
    const system = await getSettings("system");
    if (!system.youtubeEnabled || !limits.allowYoutube) throw new AppError("YOUTUBE_DISABLED");
    if (!video.source.externalId) throw new AppError("UNSUPPORTED_SOURCE");

    const info = await probeYouTube(video.source.externalId, run.signal);
    log.info({ durationMs: info.durationMs, liveStatus: info.liveStatus, availability: info.availability }, "youtube info");
    if (info.liveStatus && LIVE_STATES.has(info.liveStatus)) {
      throw new AppError("UNSUPPORTED_SOURCE", {
        message: "Live streams can't be processed. Try again once the stream has ended and been saved.",
      });
    }
    if ((info.availability && !PUBLIC_AVAILABILITY.has(info.availability)) || info.ageLimit >= 18) {
      throw new AppError("VIDEO_UNAVAILABLE");
    }
    if (info.durationMs) assertLengthAllowed(info.durationMs, user, limits);
    await run.reportProgress(0.05);
  }

  const file = await ensureSource(ctx, (f) => void run.reportProgress(0.05 + f * 0.85).catch(() => {}));
  const probe = await probeMedia(file, run.signal);
  log.info(probe, "source probed");

  if (!probe.hasVideo || probe.durationMs <= 0) throw new AppError("NOT_A_VIDEO");
  if (!probe.hasAudio) throw new AppError("NO_AUDIO_TRACK");
  assertLengthAllowed(probe.durationMs, user, limits);

  const media = {
    durationMs: probe.durationMs,
    width: probe.width ?? undefined,
    height: probe.height ?? undefined,
    fps: probe.fps ?? undefined,
    hasAudio: probe.hasAudio,
    videoCodec: probe.videoCodec ?? undefined,
    audioCodec: probe.audioCodec ?? undefined,
  };
  await run.setFields({ media });
  ctx.video.media = media; // later stages in this job read it from here
};
