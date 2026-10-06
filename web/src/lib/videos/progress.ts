import "server-only";

import type { Types } from "mongoose";

import { ERROR_SPECS, ownedBy, STAGE_NAMES, Video, type ErrorCode, type StageName, type VideoDoc } from "@/shared";

import { isAnyWorkerOnline } from "../redis";
import type { StageView, VideoProgressView } from "./progress-view";

/** Only the fields the progress view needs (keeps each 2-second poll ~1 KB). */
export const PROGRESS_PROJECTION = { status: 1, pipeline: 1, error: 1, "media.durationMs": 1 } as const;

type ProgressSource = Pick<VideoDoc, "status" | "pipeline" | "error" | "media"> & { _id: Types.ObjectId };

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Activity older than this is from a worker that went quiet — don't show stale speeds. */
const ACTIVITY_FRESH_MS = 30_000;

export function toProgressView(video: ProgressSource, now = new Date()): VideoProgressView {
  const stages = Object.fromEntries(
    STAGE_NAMES.map((name): [StageName, StageView] => {
      const s = video.pipeline?.stages?.[name];
      return [
        name,
        { status: s?.status ?? "pending", progress: s?.progress ?? 0, startedAt: iso(s?.startedAt), finishedAt: iso(s?.finishedAt) },
      ];
    }),
  ) as Record<StageName, StageView>;

  // Show the message for the code from ERROR_SPECS when we know it (wording can improve
  // after the error was stored); fall back to the stored, already user-safe message.
  const err = video.error;
  const spec = err ? ERROR_SPECS[err.code as ErrorCode] : undefined;

  return {
    id: String(video._id),
    status: video.status,
    stage: (video.pipeline?.stage as StageName | null | undefined) ?? null,
    progress: video.status === "ready" ? 1 : (video.pipeline?.progress ?? 0),
    mediaDurationMs: video.media?.durationMs ?? null,
    activity: activityView(video, now),
    workerOnline: null,
    waitUntil: waitUntilView(video, now),
    stages,
    error: err ? { code: err.code, message: spec?.message ?? err.message, retryable: err.retryable ?? false } : null,
  };
}

function waitUntilView(video: ProgressSource, now: Date): string | null {
  const at = video.pipeline?.waitUntil;
  return video.status === "queued" && at && new Date(at).getTime() > now.getTime() ? new Date(at).toISOString() : null;
}

function activityView(video: ProgressSource, now: Date): VideoProgressView["activity"] {
  const a = video.pipeline?.activity;
  if (!a || video.status !== "processing" || now.getTime() - new Date(a.at).getTime() > ACTIVITY_FRESH_MS) return null;
  return {
    kind: a.kind,
    doneBytes: a.doneBytes ?? 0,
    totalBytes: a.totalBytes ?? null,
    bytesPerSec: a.bytesPerSec ?? 0,
    etaSec: a.etaSec ?? null,
  };
}

/** The signed-in user's video progress, or null if it isn't theirs / doesn't exist. */
export async function loadProgressView(user: { _id: Types.ObjectId }, videoId: string): Promise<VideoProgressView | null> {
  const video = await Video.findOne({ _id: videoId, ...ownedBy(user), deletedAt: null })
    .select(PROGRESS_PROJECTION)
    .lean<ProgressSource>();
  return video ? withWorkerStatus(toProgressView(video)) : null;
}

/** For a queued video, whether any worker is running to pick it up. */
export async function withWorkerStatus(view: VideoProgressView): Promise<VideoProgressView> {
  if (view.status !== "queued") return view;
  return { ...view, workerOnline: await isAnyWorkerOnline() };
}
