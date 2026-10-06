import { z } from "zod";

import { env } from "../../config/env";
import { runTool } from "../../lib/exec";

/** What we keep about a media file. Width/height are as DISPLAYED (rotation applied). */
export type MediaProbe = {
  durationMs: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Degrees the player rotates the picture (phone videos): 0, 90, 180 or 270. */
  rotation: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
};

const streamSchema = z.looseObject({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  duration: z.string().optional(),
  disposition: z.looseObject({ attached_pic: z.number().optional() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
  side_data_list: z.array(z.looseObject({ rotation: z.number().optional() })).optional(),
});

const probeSchema = z.object({
  format: z.looseObject({ duration: z.string().optional() }).optional(),
  streams: z.array(streamSchema).default([]),
});

/** "30000/1001" → 29.97; "0/0" → null. */
function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 1000) / 1000;
}

function normalizeRotation(deg: number): number {
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

export async function probeMedia(file: string, signal?: AbortSignal): Promise<MediaProbe> {
  const { stdout } = await runTool(
    env.FFPROBE_PATH,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", file],
    { timeoutMs: 60_000, signal },
  );
  const data = probeSchema.parse(JSON.parse(stdout));

  // Cover art in audio files shows up as a one-frame "video" stream — not a video.
  const video = data.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = data.streams.find((s) => s.codec_type === "audio");

  const rawRotation =
    video?.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? Number(video?.tags?.rotate ?? 0);
  const rotation = normalizeRotation(Number.isFinite(rawRotation) ? rawRotation : 0);
  const sideways = rotation === 90 || rotation === 270;

  const seconds = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  return {
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    width: (sideways ? video?.height : video?.width) ?? null,
    height: (sideways ? video?.width : video?.height) ?? null,
    fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
    rotation,
    hasVideo: !!video,
    hasAudio: !!audio,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}
