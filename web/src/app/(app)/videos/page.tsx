import { FilmIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { VIDEO_CARD_FIELDS, VideoCard } from "@/components/app/video-card";
import { buttonVariants } from "@/components/ui/button";
import { requireUserPage } from "@/lib/auth/page-guards";
import { ROUTES } from "@/lib/routes";
import { getSettings, ownedBy, Video } from "@/shared";

export const metadata: Metadata = { title: "My videos" };

/** Enough for months of free-plan use; add paging when someone gets close. */
const LIST_LIMIT = 60;

export default async function VideosPage() {
  const user = await requireUserPage();
  const [retention, videos] = await Promise.all([
    getSettings("retention"),
    Video.find({ ...ownedBy(user), deletedAt: null }).sort({ createdAt: -1 }).limit(LIST_LIMIT).select(VIDEO_CARD_FIELDS).lean(),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-4 py-8 sm:px-8 lg:px-10 lg:py-9">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-3xl font-bold tracking-tight sm:text-[34px]">My videos</h1>
          <p className="text-muted-foreground">
            {videos.length === 0 ? "Nothing here yet." : `${videos.length} video${videos.length === 1 ? "" : "s"}, newest first.`}
          </p>
        </div>
        <Link href={`${ROUTES.dashboard}#new-video`} className={buttonVariants()}>
          <PlusIcon />
          New video
        </Link>
      </div>

      {videos.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-16 text-center">
          <FilmIcon className="size-6 text-subtle" strokeWidth={1.8} />
          <p className="font-medium">No videos yet</p>
          <p className="text-sm text-muted-foreground">Upload one from the dashboard to get started.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {videos.map((v) => (
            <li key={String(v._id)}>
              <VideoCard video={v} plan={user.plan} retention={retention} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
