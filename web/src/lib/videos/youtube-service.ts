/**
 * YouTube link → queued video. Quick checks only (a Vercel function must answer fast):
 * the link parses, the video exists and is public (YouTube oEmbed), the user may use
 * YouTube and has a free slot and minutes left. The length is unknown until the worker
 * asks yt-dlp, so the worker applies the length and minutes rules (stages/ingest.ts).
 *
 * No `server-only`, no env import — scripts/upload-smoke-test.ts runs it.
 */
import {
  AppError,
  isDuplicateKeyError,
  minutesUsedThisPeriod,
  ownedBy,
  PERMISSION_TERMS_VERSION,
  Video,
} from "@/shared";

import { assertUploadAllowed } from "../uploads/rules";
import type { SubmitYouTubeInput } from "./schemas";
import { countActiveJobs, type UploadContext, type VideoWithId } from "./upload-service";
import { canonicalYouTubeUrl, parseYouTubeUrl } from "./youtube-url";

export type OEmbed = { title: string | null; authorName: string | null; thumbnailUrl: string | null };

/**
 * YouTube's public oEmbed endpoint: no API key, answers in ~100 ms. 401/403/404 mean
 * private, removed or not embeddable → VIDEO_UNAVAILABLE. If YouTube itself is slow or
 * down we return null and let the worker decide (it checks again with yt-dlp).
 */
export async function fetchOEmbed(videoId: string, fetchImpl: typeof fetch = fetch): Promise<OEmbed | null> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonicalYouTubeUrl(videoId))}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
  } catch {
    return null;
  }
  if ([400, 401, 403, 404].includes(res.status)) throw new AppError("VIDEO_UNAVAILABLE");
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown } | null;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return {
    title: str(body?.title, 300),
    authorName: str(body?.author_name, 200),
    thumbnailUrl: str(body?.thumbnail_url, 500),
  };
}

export async function submitYouTube(
  ctx: UploadContext,
  input: SubmitYouTubeInput,
  deps: { fetchOEmbed?: (id: string) => Promise<OEmbed | null> } = {},
): Promise<{ video: VideoWithId; created: boolean }> {
  const userId = ctx.user._id;

  // Idempotency first: a retried request returns what the first one created.
  const existing = await Video.findOne({ ...ownedBy(ctx.user), clientRequestId: input.clientRequestId }).lean<VideoWithId>();
  if (existing) return { video: existing, created: false };

  if (!ctx.system.youtubeEnabled) throw new AppError("YOUTUBE_DISABLED");
  if (!ctx.limits.allowYoutube) {
    throw new AppError("YOUTUBE_DISABLED", { message: "Your plan doesn't include YouTube links. Upload the file instead." });
  }

  const youtubeId = parseYouTubeUrl(input.url);
  if (!youtubeId) {
    throw new AppError("UNSUPPORTED_SOURCE", { message: "That doesn't look like a YouTube video link." });
  }

  // Length unknown yet: check the slot, and that at least one minute is left.
  assertUploadAllowed({
    user: ctx.user,
    limits: ctx.limits,
    facts: { bytes: 0, durationMs: null },
    activeJobs: await countActiveJobs(userId),
    now: ctx.now,
  });
  if (ctx.limits.monthlyMinutes - minutesUsedThisPeriod(ctx.user, ctx.now) < 1) throw new AppError("QUOTA_EXCEEDED");

  const oembed = await (deps.fetchOEmbed ?? fetchOEmbed)(youtubeId);
  const now = ctx.now ?? new Date();
  try {
    const doc = await Video.create({
      userId,
      clientRequestId: input.clientRequestId,
      title: oembed?.title ?? "YouTube video",
      language: input.language,
      source: {
        type: "youtube",
        url: canonicalYouTubeUrl(youtubeId),
        externalId: youtubeId,
        ...(oembed
          ? {
              oembed: {
                title: oembed.title ?? undefined,
                authorName: oembed.authorName ?? undefined,
                thumbnailUrl: oembed.thumbnailUrl ?? undefined,
              },
            }
          : {}),
      },
      permission: {
        confirmedAt: now,
        termsVersion: PERMISSION_TERMS_VERSION,
        ip: ctx.request?.ip,
        userAgent: ctx.request?.userAgent,
      },
      options: { intent: input.intent },
      status: "queued", // the worker's dispatcher picks it up (D35)
      thumbnailUrl: oembed?.thumbnailUrl ?? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    });
    return { video: doc.toObject() as VideoWithId, created: true };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await Video.findOne({ ...ownedBy(ctx.user), clientRequestId: input.clientRequestId }).lean<VideoWithId>();
    if (!raced) throw err;
    return { video: raced, created: false };
  }
}
