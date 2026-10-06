import type { ReactNode } from "react";

import { formatBytes } from "@/lib/format";
import { MONGO_LIMIT_BYTES, type BackupHealth, type CloudinaryUsage } from "@/lib/admin/system-types";
import { cn } from "@/lib/utils";

/** The storage and backup cards shared by the Overview and the System page (docs/ADMIN.md §2). */

export function UsageBar({ share }: { share: number }) {
  const pct = Math.min(100, Math.max(0, Math.round(share * 100)));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full", share >= 0.9 ? "bg-destructive" : share >= 0.7 ? "bg-warning" : "bg-primary")} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 bg-card px-4.5 py-3.5">
      <span className="text-[13px] text-subtle">{label}</span>
      {children}
    </div>
  );
}

export function MongoCard({ usedBytes }: { usedBytes: number | null }) {
  if (usedBytes === null) {
    return (
      <Card label="MongoDB">
        <span className="text-sm text-subtle">Couldn’t read the database size.</span>
      </Card>
    );
  }
  const share = usedBytes / MONGO_LIMIT_BYTES;
  return (
    <Card label="MongoDB (data + indexes)">
      <span className="font-heading text-2xl font-bold tabular-nums">
        {formatBytes(usedBytes)}
        <span className="text-sm font-normal text-subtle"> / 512 MB</span>
      </span>
      <UsageBar share={share} />
      <span className={cn("text-xs", share >= 0.9 ? "text-destructive" : share >= 0.7 ? "text-warning" : "text-subtle")}>
        {share >= 0.9 ? "almost full — the free database stops accepting writes at 512 MB" : `${Math.round(share * 100)}% of the free database`}
      </span>
    </Card>
  );
}

export function CloudinaryCard({ usage }: { usage: CloudinaryUsage }) {
  if (!usage.ok) {
    return (
      <Card label="Cloudinary">
        <span className="text-sm text-subtle">Unknown — {usage.reason}.</span>
      </Card>
    );
  }
  const share = usage.limit > 0 ? usage.used / usage.limit : 0;
  return (
    <Card label="Cloudinary credits (this month)">
      <span className="font-heading text-2xl font-bold tabular-nums">
        {usage.used.toFixed(1)}
        <span className="text-sm font-normal text-subtle"> / {usage.limit}</span>
      </span>
      <UsageBar share={share} />
      <span className={cn("text-xs", share >= 0.9 ? "text-destructive" : share >= 0.7 ? "text-warning" : "text-subtle")}>
        {share >= 0.9 ? "almost used up — uploads and renders can start failing" : `${Math.round(share * 100)}% used${usage.plan ? ` · ${usage.plan} plan` : ""}`}
      </span>
    </Card>
  );
}

export function BackupCard({ health }: { health: BackupHealth }) {
  return (
    <Card label="Database backup">
      <span
        className={cn(
          "text-[15px] font-semibold",
          health.tone === "ok" && "text-primary",
          health.tone === "warn" && "text-warning",
          health.tone === "danger" && "text-destructive",
          health.tone === "muted" && "text-subtle",
        )}
      >
        {health.headline}
      </span>
      {health.detail && <span className="text-xs wrap-break-word text-subtle">{health.detail}</span>}
    </Card>
  );
}
