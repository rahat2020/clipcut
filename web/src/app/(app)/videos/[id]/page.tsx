import type { Types } from "mongoose";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import type { PlayerSource } from "@/components/app/source-player";
import type { TranscriptView } from "@/components/app/transcript-panel";
import { VideoWorkspace } from "@/components/app/video-workspace";
import { requireUserPage } from "@/lib/auth/page-guards";
import { cloudinaryConfig } from "@/lib/cloudinary";
import { formatBytes, formatDuration, fromNow } from "@/lib/format";
import { LANGUAGE_NAMES } from "@/lib/video-labels";
import { signedSourceUrl } from "@/lib/uploads/cloudinary-core";
import { toClipRequestView } from "@/lib/videos/clip-request";
import { loadClips } from "@/lib/videos/clips";
import { loadRenderViews } from "@/lib/videos/renders";
import { toProgressView, withWorkerStatus } from "@/lib/videos/progress";
import { objectIdString } from "@/lib/videos/schemas";
import { effectivePlanLimits, getSettings, isExpired, ownedBy, Transcript, Video, type VideoDoc } from "@/shared";

export const metadata: Metadata = { title: "Video" };

/** The video's current transcript, only if it belongs to this video and user. */
async function loadTranscript(video: Pick<VideoDoc, "currentTranscriptId" | "userId"> & { _id: Types.ObjectId }): Promise<TranscriptView | null> {
  if (!video.currentTranscriptId) return null;
  const t = await Transcript.findOne({ _id: video.currentTranscriptId, videoId: video._id, userId: video.userId })
    .select({ language: 1, model: 1, stats: 1, segments: 1 })
    .lean();
  if (!t) return null;
  return {
    language: t.language,
    model: t.model ?? null,
    wordCount: t.stats?.wordCount ?? 0,
    segments: t.segments.map((seg) => ({ startMs: seg.startMs, endMs: seg.endMs, text: seg.text })),
  };
}

/** Loads one video of the signed-in user and lays it out as the single-screen workspace. */
export default async function VideoPage({ params }: PageProps<"/videos/[id]">) {
  const user = await requireUserPage();
  const { id } = await params;
  if (!objectIdString.safeParse(id).success) notFound();

  const video = await Video.findOne({ _id: id, ...ownedBy(user), deletedAt: null }).lean();
  if (!video) notFound();

  const publicId = video.source?.cloudinary?.publicId;
  const playable = publicId && !video.retention?.assetsDeletedAt;
  const [transcript, clips, renders, retention, progress, limitSettings] = await Promise.all([
    loadTranscript(video),
    loadClips(video),
    loadRenderViews(cloudinaryConfig, video),
    getSettings("retention"),
    withWorkerStatus(toProgressView(video)),
    getSettings("limits"),
  ]);
  const expired = !!video.retention?.assetsDeletedAt || isExpired(video, user.plan, retention);
  const active = video.status === "queued" || video.status === "processing";
  const planLimits = effectivePlanLimits(user, limitSettings);
  const requestLimit = planLimits.clipRequestsPerVideo;
  const clipRequest = toClipRequestView(video);
  // YouTube sources are never stored; the page shows YouTube's own (privacy-enhanced) player.
  const youtubeId = video.source.type === "youtube" ? video.source.externalId : null;
  const source: PlayerSource = youtubeId
    ? { kind: "youtube", videoId: youtubeId }
    : playable
      ? { kind: "file", src: signedSourceUrl(cloudinaryConfig, publicId), poster: video.thumbnailUrl ?? null }
      : { kind: "none" };
  const stopped = video.status === "failed" || video.status === "canceled";

  const meta = [
    ...(video.media?.durationMs != null ? [formatDuration(video.media.durationMs)] : []),
    LANGUAGE_NAMES[video.language],
    [
      video.source.type === "upload" ? "Uploaded file" : "YouTube",
      video.source.sizeBytes ? formatBytes(video.source.sizeBytes) : null,
      video.source.oembed?.authorName ?? null,
    ]
      .filter(Boolean)
      .join(" · "),
    `Added ${fromNow(video.createdAt)}`,
  ];

  return (
    <VideoWorkspace
      videoId={id}
      title={video.title}
      language={video.language}
      status={video.status}
      errorCode={video.error?.code ?? null}
      meta={meta}
      languageRequested={video.languageCheck?.switched ? video.languageCheck.requested : null}
      source={source}
      aspect={video.media?.width && video.media.height ? video.media.width / video.media.height : null}
      durationMs={video.media?.durationMs ?? 0}
      clips={clips?.clips ?? []}
      transcript={transcript}
      renders={renders}
      progress={progress}
      expired={expired}
      clipsNote={
        clips
          ? "We didn't find a moment in this video that works as a short clip."
          : stopped
            ? "No clips — processing stopped before moments were found."
            : "Clips appear here once the AI has read the transcript."
      }
      transcriptNote={
        stopped ? "No transcript — processing stopped before transcription finished." : "The transcript appears here once transcription finishes."
      }
      focus={clips?.focus ?? null}
      clipRequest={clipRequest}
      copyRequests={
        video.status === "ready" && planLimits.copyRequestsPerVideo > 0
          ? { left: Math.max(0, planLimits.copyRequestsPerVideo - (video.counts?.copyRequests ?? 0)), limit: planLimits.copyRequestsPerVideo }
          : null
      }
      captionScript={video.options?.captionScript === "Latn" ? "Latn" : "Beng"}
      findClips={
        transcript && requestLimit > 0 && video.status !== "canceled"
          ? {
              left: Math.max(0, requestLimit - (video.counts?.clipRequests ?? 0)),
              limit: requestLimit,
              blocked: active ? "Wait until processing finishes." : expired ? "This video’s files have expired." : null,
            }
          : null
      }
    />
  );
}
