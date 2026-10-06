/**
 * What the video page polls: a small, client-safe snapshot of processing state.
 * Imports types and enums only, so client components can use it.
 */
import {
  TERMINAL_VIDEO_STATUSES,
  type StageName,
  type StageStatus,
  type ActivityKind,
  type VideoStatus,
} from "@/shared/enums";

export type StageView = {
  status: StageStatus;
  /** 0..1 inside this stage (shown while it runs). */
  progress: number;
  startedAt: string | null;
  finishedAt: string | null;
};

export type VideoProgressView = {
  id: string;
  status: VideoStatus;
  stage: StageName | null;
  /** 0..1 */
  progress: number;
  /** The video's length once ingest has measured it — drives the time-left estimate. */
  mediaDurationMs: number | null;
  stages: Record<StageName, StageView>;
  /** A download in progress (bytes, speed, time left); null when nothing is transferring. */
  activity: {
    kind: ActivityKind;
    doneBytes: number;
    totalBytes: number | null;
    bytesPerSec: number;
    etaSec: number | null;
  } | null;
  /**
   * Only filled while the video is queued: false = no worker is running, so nothing will
   * start until one comes back. Null = not checked / unknown.
   */
  workerOnline: boolean | null;
  /**
   * Only filled while the video is queued: the AI's daily quota is used up and processing
   * continues by itself at this time (ISO). Null = not waiting for that.
   */
  waitUntil: string | null;
  /** User-safe message; `retryable` = the user may press Retry. */
  error: { code: string; message: string; retryable: boolean } | null;
};

export function isTerminalStatus(status: VideoStatus): boolean {
  return (TERMINAL_VIDEO_STATUSES as readonly string[]).includes(status);
}
