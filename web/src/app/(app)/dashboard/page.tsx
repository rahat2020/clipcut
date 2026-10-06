import { ClockIcon, FilmIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NewVideoCard } from "@/components/app/new-video-card";
import { VIDEO_CARD_FIELDS, VideoCard } from "@/components/app/video-card";
import { requireUserPage } from "@/lib/auth/page-guards";
import { formatDay } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import {
  effectivePlanLimits,
  getSettings,
  minutesUsedThisPeriod,
  ownedBy,
  quotaResetsAt,
  retentionDaysForPlan,
  Video,
} from "@/shared";

export const metadata: Metadata = { title: "Home" };

const RECENT_COUNT = 8;

const TIPS = [
  "One or two people talking to camera — podcasts, talks, classes",
  "Clear audio. Background music makes transcription less accurate",
  "10 to 60 minutes long — more material, better picks",
];

export default async function DashboardPage() {
  const user = await requireUserPage();
  const [limits, retention, system, videos] = await Promise.all([
    getSettings("limits"),
    getSettings("retention"),
    getSettings("system"),
    Video.find({ ...ownedBy(user), deletedAt: null }).sort({ createdAt: -1 }).limit(RECENT_COUNT).select(VIDEO_CARD_FIELDS).lean(),
  ]);
  const planLimits = effectivePlanLimits(user, limits);
  const resetsAt = quotaResetsAt(user);
  const keepDays = retentionDaysForPlan(retention, user.plan);
  const firstName = user.name?.split(" ")[0];

  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-4 py-8 sm:px-8 lg:px-10 lg:py-9">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-3xl font-bold tracking-tight sm:text-[34px]">
          {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        </h1>
        <p className="text-base text-muted-foreground">Turn a long video into short clips with captions.</p>
      </div>

      <div className="flex flex-col gap-6 xl:flex-row">
        <NewVideoCard
          maxFileMB={planLimits.maxFileMB}
          maxDurationMin={planLimits.maxDurationMin}
          youtubeAllowed={planLimits.allowYoutube && system.youtubeEnabled}
          uploadsEnabled={system.uploadsEnabled}
          defaultLanguage={user.defaultVideoLanguage}
          minutes={{
            left: Math.max(planLimits.monthlyMinutes - minutesUsedThisPeriod(user), 0),
            monthly: planLimits.monthlyMinutes,
            resetsOn: resetsAt ? formatDay(resetsAt) : null,
          }}
        />

        <aside className="flex w-full shrink-0 flex-col gap-4 xl:w-80">
          <div className="flex flex-col gap-4 rounded-2xl border bg-card p-5">
            <span className="text-sm text-muted-foreground">Works best with</span>
            <ol className="flex flex-col gap-3.5 text-[15px] leading-snug">
              {TIPS.map((tip, i) => (
                <li key={tip} className="flex gap-3">
                  <span className="pt-0.5 font-mono text-xs text-primary">{String(i + 1).padStart(2, "0")}</span>
                  <span>{tip}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="flex gap-3 rounded-2xl border bg-sunken p-5 text-sm leading-relaxed text-muted-foreground">
            <ClockIcon className="mt-0.5 size-[18px] shrink-0" strokeWidth={1.8} />
            <span>
              Videos and clips are kept for {keepDays} days on the {user.plan} plan. Download the ones you want to keep.
            </span>
          </div>
        </aside>
      </div>

      <section aria-labelledby="recent-title" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 id="recent-title" className="font-heading text-[22px] font-semibold tracking-tight">
            Recent videos
          </h2>
          {videos.length >= RECENT_COUNT && (
            <Link href={ROUTES.videos} className="text-sm text-muted-foreground hover:text-foreground">
              View all
            </Link>
          )}
        </div>
        {videos.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-12 text-center">
            <FilmIcon className="size-6 text-subtle" strokeWidth={1.8} />
            <p className="font-medium">No videos yet</p>
            <p className="text-sm text-muted-foreground">Your videos and their clips will show up here.</p>
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
      </section>
    </main>
  );
}
