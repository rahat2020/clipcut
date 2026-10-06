import Link from "next/link";

import { requireAdminPage } from "@/lib/auth/page-guards";
import { formatUtc, fromNow } from "@/lib/format";
import { readAiUsageToday, readWorkerStatus } from "@/lib/redis";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { AuditLog, getSettings, getSettingsSnapshot, SETTINGS_GROUPS, User, Video, type AiCapMetric } from "@/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Admin overview. A first slice of the dashboard (docs/ADMIN.md §2); the storage card
 * arrives in Step 16. Loads on open only — no polling.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything the overview shows, read once per page load. */
async function loadOverview() {
  const now = new Date();
  const [users, admins, suspended, videos, processing, failed, settings, recentAudit, worker, aiUsage, ai] = await Promise.all([
    User.estimatedDocumentCount(),
    User.countDocuments({ role: "admin" }),
    User.countDocuments({ status: "suspended" }),
    Video.estimatedDocumentCount(),
    Video.countDocuments({ status: { $in: ["queued", "processing"] } }),
    Video.countDocuments({ status: "failed", updatedAt: { $gte: new Date(now.getTime() - DAY_MS) } }),
    Promise.all(SETTINGS_GROUPS.map(async (g) => ({ group: g, ...(await getSettingsSnapshot(g, { fresh: true })) }))),
    AuditLog.find().sort({ at: -1 }).limit(10).lean(),
    readWorkerStatus(),
    readAiUsageToday(now),
    getSettings("ai"),
  ]);
  return { now, users, admins, suspended, videos, processing, failed, settings, recentAudit, worker, aiUsage, ai };
}

export default async function AdminOverviewPage() {
  await requireAdminPage(); // don't rely on the layout alone
  const { now, users, admins, suspended, videos, processing, failed, settings, recentAudit, worker, aiUsage, ai } = await loadOverview();
  const system = settings.find((s) => s.group === "system")?.value as { processingEnabled?: boolean } | undefined;

  const kpis: { label: string; value: number; note: string; href: string; tone?: "info" | "danger" }[] = [
    { label: "Users", value: users, note: `${admins} admin${admins === 1 ? "" : "s"}`, href: ROUTES.adminUsers },
    { label: "Suspended", value: suspended, note: "accounts blocked", href: `${ROUTES.adminUsers}?status=suspended` },
    { label: "Videos", value: videos, note: "all time", href: `${ROUTES.adminVideos}?deleted=all` },
    { label: "Queued / processing", value: processing, note: "right now", tone: "info", href: `${ROUTES.adminVideos}?status=processing` },
    { label: "Failed", value: failed, note: "last 24 hours", tone: failed > 0 ? "danger" : undefined, href: `${ROUTES.adminVideos}?status=failed` },
  ];
  const caps: { label: string; metric: AiCapMetric; cap: number; perMinute?: boolean }[] = [
    { label: "Groq audio minutes", metric: "groq:audioSeconds", cap: ai.dailyCaps.groqAudioMinutes, perMinute: true },
    { label: "Groq requests", metric: "groq:requests", cap: ai.dailyCaps.groqRequests },
    { label: "Gemini requests", metric: "gemini:requests", cap: ai.dailyCaps.geminiRequests },
  ];

  return (
    <div className="flex max-w-6xl flex-col gap-7">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-3xl font-bold tracking-tight">Overview</h1>
        <p className="text-sm text-subtle">Loaded {formatUtc(now)} · reload the page to refresh</p>
      </div>

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-5">
        {kpis.map((k) => (
          <Link key={k.label} href={k.href} className="flex flex-col gap-1.5 rounded-[14px] border bg-card px-4.5 py-4 transition-colors hover:border-line-strong">
            <span className="text-[13px] text-subtle">{k.label}</span>
            <span className="font-heading text-3xl font-bold tracking-tight tabular-nums">{k.value}</span>
            <span className={cn("text-xs text-subtle", k.tone === "info" && "text-info", k.tone === "danger" && "text-destructive")}>
              {k.note}
            </span>
          </Link>
        ))}
      </section>

      <WorkerCard status={worker} processingEnabled={system?.processingEnabled !== false} />

      <section aria-labelledby="ai-usage-title" className="overflow-hidden rounded-[14px] border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4.5 py-3.5">
          <h2 id="ai-usage-title" className="text-[15px] font-semibold">
            AI today (UTC)
          </h2>
          <Link href={ROUTES.adminAi} className="text-sm text-subtle hover:text-foreground">
            {ai.clipSelection.model} · change →
          </Link>
        </div>
        {aiUsage ? (
          <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
            {caps.map((c) => {
              const used = c.perMinute ? Math.ceil(aiUsage[c.metric] / 60) : aiUsage[c.metric];
              const share = c.cap > 0 ? used / c.cap : 0;
              return (
                <div key={c.metric} className="flex flex-col gap-1 bg-card px-4.5 py-3.5">
                  <span className="text-[13px] text-subtle">{c.label}</span>
                  <span className="font-heading text-2xl font-bold tabular-nums">
                    {used.toLocaleString("en-US")}
                    <span className="text-sm font-normal text-subtle"> / {c.cap.toLocaleString("en-US")}</span>
                  </span>
                  <span className={cn("text-xs", share >= 1 ? "text-destructive" : share >= 0.8 ? "text-warning" : "text-subtle")}>
                    {share >= 1 ? "cap reached — jobs wait until tomorrow" : `${Math.round(share * 100)}% of today's cap`}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="px-4.5 py-6 text-sm text-subtle">Can’t reach Redis, so today’s usage is unknown.</p>
        )}
      </section>

      <section aria-labelledby="settings-title" className="overflow-hidden rounded-[14px] border bg-card">
        <h2 id="settings-title" className="border-b px-4.5 py-3.5 text-[15px] font-semibold">
          Settings
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4.5">Group</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Last changed</TableHead>
              <TableHead>By</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {settings.map((s) => (
              <TableRow key={s.group}>
                <TableCell className="px-4.5 font-mono">{s.group}</TableCell>
                <TableCell className="font-mono text-muted-foreground">{s.version === 0 ? "defaults" : `v${s.version}`}</TableCell>
                <TableCell className="font-mono text-muted-foreground">{formatUtc(s.updatedAt)}</TableCell>
                <TableCell className="text-muted-foreground">{s.updatedByEmail ?? "—"}</TableCell>
                <TableCell>
                  {s.invalid ? (
                    <span className="text-destructive">Invalid — running on defaults</span>
                  ) : (
                    <span className="text-primary">OK</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section aria-labelledby="audit-title" className="overflow-hidden rounded-[14px] border bg-card">
        <h2 id="audit-title" className="border-b px-4.5 py-3.5 text-[15px] font-semibold">
          Recent admin activity
        </h2>
        {recentAudit.length === 0 ? (
          <p className="px-4.5 py-6 text-sm text-subtle">Nothing yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4.5">When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentAudit.map((a) => (
                <TableRow key={String(a._id)}>
                  <TableCell className="px-4.5 font-mono whitespace-nowrap text-muted-foreground">{formatUtc(a.at)}</TableCell>
                  <TableCell className="text-muted-foreground">{a.actorEmail}</TableCell>
                  <TableCell className="font-mono">{a.action}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {a.target?.type ?? "?"}:{a.target?.id ?? "?"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

function WorkerCard({
  status,
  processingEnabled,
}: {
  status: Awaited<ReturnType<typeof readWorkerStatus>>;
  processingEnabled: boolean;
}) {
  const workers = status.reachable ? status.workers : [];
  // Every worker reports the same shared queue; the freshest report is the best one.
  const latest = [...workers].sort((a, b) => b.at.localeCompare(a.at))[0];
  const tone = !status.reachable || workers.length === 0 ? "danger" : processingEnabled ? "ok" : "warn";
  const headline = !status.reachable
    ? "Can’t reach Redis"
    : workers.length === 0
      ? "No worker running — queued videos will wait"
      : `${workers.length} worker${workers.length === 1 ? "" : "s"} online`;

  return (
    <section aria-labelledby="worker-title" className="overflow-hidden rounded-[14px] border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4.5 py-3.5">
        <h2 id="worker-title" className="text-[15px] font-semibold">
          Worker &amp; queue
        </h2>
        <span
          className={cn(
            "text-sm",
            tone === "ok" && "text-primary",
            tone === "warn" && "text-warning",
            tone === "danger" && "text-destructive",
          )}
        >
          {headline}
          {tone === "warn" && " · processing is switched off in settings"}
        </span>
      </div>
      {latest && (
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
          {(
            [
              ["Waiting", latest.queue.waiting],
              ["Active", latest.queue.active],
              ["Retrying", latest.queue.delayed],
              ["Failed (7 days)", latest.queue.failed],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 bg-card px-4.5 py-3.5">
              <span className="text-[13px] text-subtle">{label}</span>
              <span className="font-heading text-2xl font-bold tabular-nums">{value}</span>
            </div>
          ))}
        </div>
      )}
      {workers.length > 0 && (
        <ul className="flex flex-col divide-y border-t">
          {workers.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4.5 py-3 text-sm">
              <span className="font-mono text-muted-foreground">{w.id}</span>
              <span className="text-subtle">
                {w.activeJobs}/{w.concurrency} busy · up since {fromNow(w.startedAt)} · seen {fromNow(w.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
