"use client";

import { BackupCard, CloudinaryCard, MongoCard } from "@/components/admin/health-cards";
import { ExpiryForm } from "@/components/admin/expiry-form";
import { LimitsForm } from "@/components/admin/limits-form";
import { ImpactText, RetentionForm } from "@/components/admin/retention-form";
import { SystemForm } from "@/components/admin/system-form";
import { Panel } from "@/components/admin/ui";
import type { LimitsSettings, RetentionSettings, SystemSettings } from "@/shared";

/** Fake data and do-nothing actions: lets the admin forms be looked at without signing in (dev only). */

const plan = { monthlyMinutes: 60, maxFileMB: 100, maxDurationMin: 60, concurrentJobs: 1, maxClipsPerVideo: 10, clipRequestsPerVideo: 3, copyRequestsPerVideo: 10, allowYoutube: true };
const limits: LimitsSettings = { plans: { free: plan, pro: { ...plan, monthlyMinutes: 600, concurrentJobs: 2, maxDurationMin: 120 } } };
const retention: RetentionSettings = { plans: { free: { days: 7 } }, graceHours: 24, changedAt: new Date("2026-10-01T09:00:00Z"), purgeSoftDeletedAfterDays: 30 };
const system: SystemSettings = {
  maintenanceMode: false,
  maintenanceMessage: "",
  uploadsEnabled: true,
  processingEnabled: true,
  workerConcurrency: 1,
  youtubeEnabled: true,
  signupsEnabled: true,
  cleanupEnabled: true,
  backupEnabled: true,
  render: { autoRenderTop: 3, youtubeMaxHeight: 1080, crf: 21, preset: "veryfast" },
};

const ok = async () => ({ ok: true as const, data: { version: 2 } });

export function AdminPreview({ view }: { view: string }) {
  if (view === "limits") return <LimitsForm initial={limits} version={1} userCounts={{ free: 12, pro: 1 }} save={ok} />;
  if (view === "retention") {
    return (
      <RetentionForm
        initial={retention}
        version={1}
        plans={["free", "pro"]}
        save={ok}
        preview={async () => ({
          ok: true as const,
          data: {
            impact: { videos: 14, changed: 9, shortened: 6, lengthened: 3, dueAtOnce: 2, earliest: "2026-10-07T09:00:00.000Z", usersAffected: 4 },
            purgeDue: 1,
            confirm: "3",
            graceUntil: "2026-10-07T09:00:00.000Z",
          },
        })}
      />
    );
  }
  if (view === "impact") {
    return (
      <Panel title="What the review dialog says">
        <div className="px-4.5 py-4 text-muted-foreground">
          <ImpactText r={{ impact: { videos: 14, changed: 9, shortened: 6, lengthened: 3, dueAtOnce: 2, earliest: "2026-10-07T09:00:00.000Z", usersAffected: 4 }, purgeDue: 1, confirm: "3", graceUntil: "2026-10-07T09:00:00.000Z" }} />
        </div>
      </Panel>
    );
  }
  if (view === "system") return <SystemForm initial={{ ...system, maintenanceMode: true, maintenanceMessage: "Back at noon." }} version={3} save={ok} />;
  if (view === "health") {
    return (
      <Panel title="Storage & backups">
        <div className="grid grid-cols-1 gap-px bg-border md:grid-cols-3">
          <MongoCard usedBytes={96 * 1024 * 1024} />
          <CloudinaryCard usage={{ ok: true, used: 3.4, limit: 25, plan: "Free" }} />
          <BackupCard health={{ tone: "ok", headline: "Last backup 5 hours ago", detail: "2026-10-07 07:00 UTC · 20 KB · 87 documents" }} />
        </div>
        <div className="grid grid-cols-1 gap-px border-t bg-border md:grid-cols-3">
          <MongoCard usedBytes={480 * 1024 * 1024} />
          <CloudinaryCard usage={{ ok: false, reason: "couldn’t ask Cloudinary (HTTP 401)" }} />
          <BackupCard health={{ tone: "danger", headline: "Last backup FAILED", detail: "2026-10-07 07:00 UTC · the backup is 12.1 MB, over the 9 MB Cloudinary’s free plan accepts" }} />
        </div>
      </Panel>
    );
  }
  return (
    <Panel title="Files" aside="Kept until 2026-10-14 09:00 UTC · in 7 days · custom date">
      <ExpiryForm hasOverride action={async () => ({ ok: true as const, data: null })} />
    </Panel>
  );
}
