/**
 * Every error the app shows or records has a stable code. Messages here are safe to
 * show users; technical detail goes to logs, never to the UI.
 */

type ErrorSpec = { status: number; retryable: boolean; message: string };

export const ERROR_SPECS = {
  // request / auth
  VALIDATION_FAILED: { status: 400, retryable: false, message: "Some of the information sent was invalid." },
  UNAUTHENTICATED: { status: 401, retryable: false, message: "Please sign in to continue." },
  FORBIDDEN: { status: 403, retryable: false, message: "You don't have permission to do that." },
  ACCOUNT_SUSPENDED: { status: 403, retryable: false, message: "Your account is suspended. Contact support." },
  SIGNUPS_DISABLED: { status: 403, retryable: false, message: "New sign-ups are closed right now. Please check back later." },
  NOT_FOUND: { status: 404, retryable: false, message: "We couldn't find that." },
  CONFLICT: { status: 409, retryable: false, message: "This was changed by someone else. Reload and try again." },
  SETTINGS_CONFLICT: { status: 409, retryable: false, message: "Settings were changed in another tab. Reload and try again." },

  // limits and switches
  COPY_REQUEST_LIMIT: { status: 429, retryable: false, message: "You've rewritten this video's post text as often as your plan allows." },
  CLIP_REQUEST_LIMIT: { status: 429, retryable: false, message: "You've used all your new clip searches for this video." },
  QUOTA_EXCEEDED: { status: 402, retryable: false, message: "You've used all your processing minutes for this month." },
  CONCURRENCY_LIMIT: { status: 429, retryable: true, message: "You already have a video processing. Try again when it finishes." },
  RATE_LIMITED: { status: 429, retryable: true, message: "Too many requests. Please wait a moment." },
  MAINTENANCE: { status: 503, retryable: true, message: "We're doing maintenance. Please try again soon." },
  UPLOADS_DISABLED: { status: 503, retryable: true, message: "New uploads are paused right now." },
  YOUTUBE_DISABLED: { status: 503, retryable: false, message: "YouTube links aren't supported right now. Please upload the file." },

  // source video
  FILE_TOO_LARGE: { status: 413, retryable: false, message: "This file is larger than your plan allows." },
  VIDEO_TOO_LONG: { status: 422, retryable: false, message: "This video is longer than your plan allows." },
  NO_AUDIO_TRACK: { status: 422, retryable: false, message: "This video has no audio, so there's nothing to transcribe." },
  NOT_A_VIDEO: { status: 422, retryable: false, message: "This file doesn't look like a video. Try an MP4, MOV or WebM file." },
  UPLOAD_NOT_FOUND: { status: 404, retryable: false, message: "We couldn't find your upload. Please upload the file again." },
  UNSUPPORTED_SOURCE: { status: 422, retryable: false, message: "This link isn't supported. Upload the file or use a YouTube link." },
  VIDEO_UNAVAILABLE: {
    status: 422,
    retryable: false,
    message: "This video can't be accessed. Check the link and make sure you have permission to use it.",
  },
  MEDIA_EXPIRED: { status: 410, retryable: false, message: "This video's files have expired and were deleted. Your titles and transcript are still here; upload the video again to make new clips." },

  // processing
  DOWNLOAD_FAILED: { status: 502, retryable: true, message: "We couldn't download the video. Try again; if it keeps failing, check that the link is public." },
  TRANSCRIPTION_FAILED: { status: 502, retryable: true, message: "We couldn't transcribe the audio. Try again in a few minutes." },
  AI_UNAVAILABLE: { status: 503, retryable: true, message: "The AI service is busy. We'll retry automatically." },
  AI_OUTPUT_INVALID: { status: 502, retryable: true, message: "The AI returned an unusable answer. We'll retry." },
  AI_DAILY_CAP_REACHED: { status: 503, retryable: true, message: "Today's AI capacity is used up. Processing resumes automatically when it comes back." },
  NO_MOMENTS_FOUND: {
    status: 422,
    retryable: false,
    message: "We couldn't find a moment in this video that works as a short clip.",
  },
  FFMPEG_FAILED: { status: 500, retryable: true, message: "We couldn't process this video file. Try again; if it keeps failing, export it as an MP4 and upload that." },
  STORAGE_FAILED: { status: 502, retryable: true, message: "We couldn't save the file. We'll retry." },
  PROCESSING_STALLED: { status: 500, retryable: true, message: "Processing stopped unexpectedly. Please try again." },
  /** Development only: the pipeline reached a stage whose code isn't built yet (PROGRESS.md). */
  STAGE_NOT_READY: {
    status: 503,
    retryable: true,
    message: "This part of processing isn't available yet. Try again after the next update.",
  },

  INTERNAL: { status: 500, retryable: true, message: "Something went wrong on our side." },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_SPECS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  /** Extra context for logs and API responses. Never put secrets or raw stack traces here. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    options: { message?: string; details?: Record<string, unknown>; cause?: unknown; retryable?: boolean } = {},
  ) {
    const spec: ErrorSpec = ERROR_SPECS[code];
    super(options.message ?? spec.message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = spec.status;
    this.retryable = options.retryable ?? spec.retryable;
    this.details = options.details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** MongoDB duplicate-key error (unique index violation). */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}
