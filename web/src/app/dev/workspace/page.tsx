import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppSidebar } from "@/components/app/app-sidebar";
import { VideoWorkspace } from "@/components/app/video-workspace";
import type { ClipView } from "@/lib/videos/clips";
import type { VideoProgressView } from "@/lib/videos/progress-view";
import type { RenderView } from "@/lib/videos/renders";
import { STAGE_NAMES, type VideoStatus } from "@/shared/enums";

export const metadata: Metadata = { title: "Workspace preview (dev)", robots: { index: false, follow: false } };

/**
 * DEVELOPMENT ONLY (404 in production): the video workspace with made-up data and no
 * sign-in, so the layout can be screenshotted at laptop sizes while it's being designed.
 *   /dev/workspace?status=ready|processing|waiting&sidebar=collapsed&clips=0&request=none&find=open
 * Buttons that call the API fail here — that's expected.
 */
/** A helper because the lint forbids reading the clock while rendering. */
function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3_600_000).toISOString();
}

export default async function WorkspacePreview({ searchParams }: PageProps<"/dev/workspace">) {
  if (process.env.NODE_ENV === "production") notFound();
  const q = await searchParams;
  const waiting = q.status === "waiting"; // queued, waiting for the AI's daily quota
  const status: VideoStatus = waiting ? "queued" : q.status === "processing" ? "processing" : "ready";
  const noClips = q.clips === "0";

  const clips: ClipView[] = noClips
    ? []
    : [
        [67_000, 91_000, 90, "insight", "The speaker gives specific, enthusiastic praise for Fahan Ahmed, detailing his talent, hard work, and significant potential for the Bangladesh national team. This is a strong endorsement of a rising star."],
        [40_300, 67_000, 88, "educational", "The speaker praises emerging young players like Fahan and Shukit for their positive contributions, expressing optimism for the team's future and setting a clear goal to improve for the upcoming SAFF tournament."],
        [3_000, 22_000, 85, "emotional", "The player expresses his personal disappointment and sadness for the team's loss, highlighting his inability to contribute and the need to move on."],
        [22_000, 40_000, 80, "insight", "The speaker emphasizes the team's pride and fighting spirit despite a loss, explaining that it's normal in sports and they managed it professionally."],
      ].map(([startMs, endMs, score, momentType, reason], i) => ({
        id: `clip${i + 1}`.padEnd(24, "0"),
        rank: i + 1,
        startMs: startMs as number,
        endMs: endMs as number,
        durationMs: (endMs as number) - (startMs as number),
        score: score as number,
        momentType: momentType as ClipView["momentType"],
        reason: reason as string,
        transcriptText:
          "খেলা শেষ হইছে এখন মুভ অন করতে হবে। না এদের জন্য মানে খুশি যে এরা ভালো করতে পারছে। ফাহান এই খেলাতে ভালো করতে পারছে একটা গোল দিয়েছে। সেও বলছে সে বলছে আরও এক দুইটা দিতে পারত। সো ওর একটা হাঙ্গার আছে।",
        status: i === 3 ? "rejected" : i === 0 ? "approved" : "suggested",
        rejectReason: i === 3 ? "Boring" : null,
        cropOffsetX: 0,
        captionStyleId: "preset:bold",
        ai: null,
        kept: false,
        copy:
          i === 3
            ? null
            : {
                title: ["ফাহানের প্রশংসায় শমিত: জাতীয় দলের ভবিষ্যৎ", "তরুণদের নিয়ে আশাবাদী শমিত", "হারের পর মন খারাপ, তবু মুভ অন", ""][i]!,
                hook: "হার মানে শেষ না — শমিত বললেন সামনে কী আসছে",
                description: "ম্যাচ হারের পর শমিত তরুণ খেলোয়াড়দের প্রশংসা করলেন আর সাফে ভালো করার লক্ষ্য জানালেন।",
                hashtags: ["#বাংলাদেশফুটবল", "#শমিত", "#SAFF", "#Football"],
                coverText: "ফাহানের প্রথম গোল!",
                coverOptions: [
                  { text: "ফাহানের প্রথম গোল!", highlight: "প্রথম" },
                  { text: "গোলের ক্ষুধা মেটেনি!", highlight: "ক্ষুধা" },
                  { text: "সাফে কী হবে?", highlight: "সাফে" },
                ],
                script: "Beng" as const,
                edited: false,
              },
        copyPending: false,
        coverPending: false,
      }));

  const renders: RenderView[] = noClips
    ? []
    : [
        { id: "r1".padEnd(24, "0"), clipId: clips[0]!.id, status: "ready", progress: 1, error: null, previewUrl: "/dev-preview.mp4", downloadUrl: "#", bytes: 7_697_375, outdated: false, coverFrames: [1, 2, 3, 4, 5, 6].map((n) => `/dev/frame?n=${n}`) },
        { id: "r2".padEnd(24, "0"), clipId: clips[1]!.id, status: "rendering", progress: 0.45, error: null, previewUrl: null, downloadUrl: null, bytes: null, outdated: false, coverFrames: [] },
      ];

  const now = new Date().toISOString();
  const progress: VideoProgressView = {
    id: "preview".padEnd(24, "0"),
    status,
    stage: status === "processing" ? "transcribe" : null,
    progress: status === "processing" ? 0.3 : 1,
    mediaDurationMs: 115_264,
    stages: Object.fromEntries(
      STAGE_NAMES.map((name, i) => [
        name,
        status === "processing"
          ? { status: i < 2 ? "done" : i === 2 ? "running" : "pending", progress: i === 2 ? 0.4 : i < 2 ? 1 : 0, startedAt: now, finishedAt: i < 2 ? now : null }
          : { status: name === "copy" ? "skipped" : "done", progress: 1, startedAt: now, finishedAt: now },
      ]),
    ) as VideoProgressView["stages"],
    activity: null,
    workerOnline: null,
    waitUntil: waiting ? hoursFromNow(7) : null,
    error: null,
  };

  const segments = Array.from({ length: 14 }, (_, i) => ({
    startMs: i * 8_000,
    endMs: i * 8_000 + 8_000,
    text: "বাট আমাদের একটু রেসপন্ড করতে হবে, আমাদের এই টুর্নামেন্ট থেকে একটু মুভ অন করতে হবে আর ফোকাস দিতে হবে সাফ এ ভালো করতে।",
  }));

  return (
    <div className="flex min-h-dvh">
      <AppSidebar
        initialCollapsed={q.sidebar === "collapsed"}
        isAdmin
        user={{ name: "Preview user", email: "preview@example.com" }}
        usage={{ minutesUsed: 38, monthlyMinutes: 200, plan: "free", resetsOn: "Oct 28" }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <VideoWorkspace
          videoId={"preview".padEnd(24, "0")}
          title="সাফে ভালো করবে বাংলাদেশ আশা শমিতের | Star Play"
          language="bn"
          status={status}
          errorCode={null}
          meta={["1:55", "Bangla", "YouTube · Star Play", "Added an hour ago"]}
          languageRequested={null}
          source={{ kind: "none" }}
          aspect={16 / 9}
          durationMs={115_264}
          clips={clips}
          transcript={{ language: "bn", model: "gemini-3-flash-preview", wordCount: 600, segments }}
          renders={renders}
          progress={progress}
          expired={false}
          clipsNote="Clips appear here once the AI has read the transcript."
          transcriptNote="The transcript appears here once transcription finishes."
          focus={noClips ? null : { intent: "sports", query: null }}
          clipRequest={q.request === "none" ? { status: "no_moments", intent: "custom", query: "where they talk about the final", failure: null, at: now } : null}
          copyRequests={status === "ready" ? { left: 8, limit: 10 } : null}
          captionScript={q.script === "Latn" ? "Latn" : "Beng"}
          findClips={{ left: 2, limit: 3, blocked: status === "processing" ? "Wait until processing finishes." : null, initialOpen: q.find === "open" }}
        />
      </div>
    </div>
  );
}
