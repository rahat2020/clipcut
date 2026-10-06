"use client";

import { useEffect, useState, type ReactNode } from "react";

import { ClipCard } from "@/components/app/clip-card";
import type { CopyRequests } from "@/components/app/clip-post-text";
import { ClipList } from "@/components/app/clip-list";
import { usePlayer } from "@/components/app/source-player";
import type { TranscriptView } from "@/components/app/transcript-panel";
import { TranscriptList } from "@/components/app/transcript-list";
import { VideoProgress } from "@/components/app/video-progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ClipView } from "@/lib/videos/clips";
import type { VideoProgressView } from "@/lib/videos/progress-view";
import type { RenderView } from "@/lib/videos/renders";
import type { Language } from "@/shared/enums";

type Tab = "clips" | "transcript";

/**
 * The workspace's side panel. While a video processes (or after it failed) its progress sits
 * on top; once it's ready, the steps move to the header and the panel is all clips.
 *
 * Clips tab = master–detail: the selected clip's card, or the list ("All clips"). Picking a
 * clip anywhere (list, timeline under the player) opens its card. ↑ / ↓ step through clips
 * when focus isn't in a text field. On large screens the panel fills the viewport height and
 * only its contents scroll; on phones it flows with the page.
 */
export function VideoSidePanel({
  videoId,
  language,
  progress,
  clips,
  transcript,
  renders,
  processing,
  expired,
  clipsNote,
  transcriptNote,
  notice,
  copyRequests,
}: {
  videoId: string;
  language: Language;
  /** Null once the video is ready (the header has the steps then). */
  progress: VideoProgressView | null;
  clips: ClipView[];
  transcript: TranscriptView | null;
  renders: RenderView[];
  processing: boolean;
  expired: boolean;
  clipsNote: string;
  transcriptNote: string;
  /** One line above the tabs (how the last "Find new clips" ended). */
  notice?: ReactNode;
  copyRequests: CopyRequests | null;
}) {
  const { selectedId, select } = usePlayer();
  // Controlled on purpose: uncontrolled Base UI Tabs can lose its selection (see new-video-card.tsx).
  const [tab, setTab] = useState<Tab>(clips.length === 0 && transcript ? "transcript" : "clips");
  // The list is open only for the selection it was opened with: picking a clip anywhere else
  // (e.g. the timeline under the player) changes the selection, which shows that clip's card.
  const [listAt, setListAt] = useState<{ id: string | null } | null>(null);

  const showList = listAt !== null && listAt.id === selectedId;
  const index = clips.findIndex((c) => c.id === selectedId);
  const clip = index >= 0 ? clips[index]! : null;
  const step = (by: number) => {
    const next = clips[index + by];
    if (next) select(next.id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (tab !== "clips" || index < 0) return;
      const next = clips[index + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      select(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clips, index, select, tab]);

  return (
    <aside aria-label="Clips and progress" className="flex flex-col overflow-hidden rounded-2xl border bg-card lg:min-h-0 lg:flex-1">
      {progress && (
        // Tall while processing (every stage shows): capped so the tabs keep room, scrolls if needed.
        <div className="shrink-0 border-b p-5 lg:max-h-[60%] lg:overflow-y-auto">
          <VideoProgress initial={progress} />
        </div>
      )}
      {notice}
      <Tabs value={tab} onValueChange={(v) => (v === "clips" || v === "transcript") && setTab(v)} className="flex flex-col gap-0 lg:min-h-0 lg:flex-1">
        <TabsList variant="line" className="h-11! w-full shrink-0 justify-start gap-4 rounded-none border-b px-4">
          <TabsTrigger value="clips" className="flex-none px-1">
            Clips{clips.length > 0 ? ` (${clips.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="transcript" className="flex-none px-1">
            Transcript
          </TabsTrigger>
        </TabsList>
        <TabsContent value="clips" className="flex flex-col lg:min-h-0 lg:flex-1">
          {clip && !showList ? (
            <ClipCard
              clip={clip}
              index={index}
              total={clips.length}
              onPrev={index > 0 ? () => step(-1) : undefined}
              onNext={index < clips.length - 1 ? () => step(1) : undefined}
              onList={() => setListAt({ id: selectedId })}
              videoId={videoId}
              language={language}
              renders={renders}
              processing={processing}
              expired={expired}
              copyRequests={copyRequests}
            />
          ) : (
            <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <ClipList clips={clips} language={language} emptyNote={clipsNote} onPick={() => setListAt(null)} />
            </div>
          )}
        </TabsContent>
        <TabsContent value="transcript" className="lg:min-h-0 lg:overflow-y-auto">
          <TranscriptList transcript={transcript} clips={clips} emptyNote={transcriptNote} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
