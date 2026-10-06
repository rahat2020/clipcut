import type { Metadata } from "next";
import Link from "next/link";

import { Empty, PageHeader, Panel, Tag } from "@/components/admin/ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { accuracyQuerySchema, loadAccuracy, type RuleCount } from "@/lib/admin/accuracy-service";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { formatUtc } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { LANGUAGE_NAMES } from "@/lib/video-labels";

export const metadata: Metadata = { title: "Accuracy · Admin" };

const RANGES = [
  { days: "7", label: "7 days" },
  { days: "30", label: "30 days" },
  { days: "all", label: "All time" },
] as const;

/** What each snap rule means (worker/src/services/clips/snap.ts, D41). */
const RULE_NOTES: Record<string, string> = {
  clean: "already at a sentence end or pause",
  earlier: "moved earlier to a clean boundary",
  later: "moved later to a clean boundary",
  soft: "only a weak boundary within reach",
  none: "no boundary within 6 s — cut mid-phrase",
  max_cut: "cut short by the maximum length",
};

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

/**
 * How well the AI's picks hold up, per prompt version × model (docs/ADMIN.md). The numbers
 * that decide whether a prompt or model change helped.
 */
export default async function AdminAccuracyPage({ searchParams }: PageProps<"/admin/accuracy">) {
  await requireAdminPage();
  const raw = await searchParams;
  const query = accuracyQuerySchema.parse({ days: Array.isArray(raw.days) ? raw.days[0] : raw.days });
  const report = await loadAccuracy(query);
  const fallbackRuns = report.models.filter((m) => m.model !== report.models[0]?.model).reduce((s, m) => s + m.runs, 0);

  return (
    <div className="flex max-w-7xl flex-col gap-6">
      <PageHeader
        title="Accuracy"
        note={
          <>
            How well the AI&apos;s clip picks hold up. User signals (approve, reject, download) fill in with Step 13; eval-set
            scores come with Steps 8 and 11. {report.since ? `Since ${formatUtc(report.since)}.` : "All time."}
          </>
        }
        actions={RANGES.map((r) => (
          <Link
            key={r.days}
            href={`${ROUTES.adminAccuracy}?days=${r.days}`}
            aria-current={query.days === r.days ? "page" : undefined}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-sm",
              query.days === r.days ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {r.label}
          </Link>
        ))}
      />

      <Panel
        title="Clip selection by prompt and model"
        aside={report.models.length > 1 ? `${fallbackRuns} run${fallbackRuns === 1 ? "" : "s"} not on the most-used model (fallbacks or re-picks)` : undefined}
      >
        {report.models.length === 0 ? (
          <Empty>No clip-selection runs in this period.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4.5">Prompt · model</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right" title="Moments the AI proposed that survived the length and overlap checks">
                    Proposed → kept
                  </TableHead>
                  <TableHead className="text-right">Avg score</TableHead>
                  <TableHead className="text-right" title="Snapped clips (Step 10) whose start / end sit at a sentence end or pause">
                    Clean start / end
                  </TableHead>
                  <TableHead className="text-right">Approved</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead className="text-right">Downloaded</TableHead>
                  <TableHead className="pr-4.5 text-right">Avg time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.models.map((m) => (
                  <TableRow key={`${m.promptVersion}|${m.provider}|${m.model}`}>
                    <TableCell className="px-4.5">
                      <span className="font-mono text-xs">{m.promptVersion}</span>
                      <span className="block font-mono text-sm">
                        {m.provider} · {m.model}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {m.runs}
                      <span className="block text-xs text-subtle">
                        {m.failed > 0 ? <span className="text-destructive">{m.failed} failed</span> : "0 failed"}
                        {m.regenerate > 0 ? ` · ${m.regenerate} re-pick` : ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {m.proposed} → {m.kept}
                      <span className="block text-xs text-subtle">{pct(m.kept, m.proposed)} kept</span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{m.avgScore != null ? Math.round(m.avgScore * 100) : "—"}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {pct(m.cleanStarts, m.snapped)} / {pct(m.cleanEnds, m.snapped)}
                      <span className="block text-xs text-subtle">
                        {m.snapped} of {m.clips} snapped
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{signal(m.approved, m.clips)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{signal(m.rejected, m.clips)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{signal(m.downloaded, m.clips)}</TableCell>
                    <TableCell className="pr-4.5 text-right font-mono text-sm">
                      {m.avgLatencyMs != null ? `${Math.round(m.avgLatencyMs / 1000)} s` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Where the cuts landed (Step 10)" aside={`${report.snap.total} snapped clips`}>
          {report.snap.total === 0 ? (
            <Empty>No snapped clips in this period — clips picked before Step 10 keep whole-line cuts.</Empty>
          ) : (
            <div className="flex flex-col gap-5 px-4.5 py-4">
              <RuleBars title="Start" rows={report.snap.starts} total={report.snap.total} />
              <RuleBars title="End" rows={report.snap.ends} total={report.snap.total} />
              <p className="text-xs text-subtle">
                Timing from: {report.snap.bases.map((b) => `${b.rule} ${pct(b.count, report.snap.total)}`).join(" · ")}. “+audio” = cuts
                placed in real quiet; without it, from timestamps only.
              </p>
            </div>
          )}
        </Panel>

        <Panel title="Transcription engines" aside="Bangla should be Gemini (D42)">
          {report.transcripts.length === 0 ? (
            <Empty>No transcripts in this period.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4.5">Language</TableHead>
                  <TableHead>Engine</TableHead>
                  <TableHead>Word times</TableHead>
                  <TableHead className="pr-4.5 text-right">Videos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.transcripts.map((t) => (
                  <TableRow key={`${t.language}|${t.provider}|${t.model}|${t.wordTiming}`}>
                    <TableCell className="px-4.5 text-sm">{LANGUAGE_NAMES[t.language as keyof typeof LANGUAGE_NAMES] ?? t.language}</TableCell>
                    <TableCell className="text-sm">
                      <span className="font-mono">
                        {t.provider} · {t.model}
                      </span>
                      {t.language === "bn" && t.provider === "groq" && (
                        <span className="ml-2">
                          <Tag tone="warning">Whisper</Tag>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{t.wordTiming}</TableCell>
                    <TableCell className="pr-4.5 text-right font-mono text-sm">{t.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>

        <Panel title="Failed clip-selection runs">
          {report.failures.length === 0 ? (
            <Empty>No failed runs in this period.</Empty>
          ) : (
            <ul className="flex flex-col divide-y">
              {report.failures.map((f) => (
                <li key={f.code} className="flex justify-between px-4.5 py-2.5 text-sm">
                  <span className="font-mono">{f.code}</span>
                  <span className="font-mono">{f.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Top rejection reasons">
          {report.rejections.length === 0 ? (
            <Empty>No rejected clips yet — users can reject clips from Step 13.</Empty>
          ) : (
            <ul className="flex flex-col divide-y">
              {report.rejections.map((r) => (
                <li key={r.reason} className="flex justify-between gap-4 px-4.5 py-2.5 text-sm">
                  <span className="min-w-0 break-words">{r.reason}</span>
                  <span className="font-mono">{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Eval set">
        <Empty>Not measured yet. Steps 8 and 11 add hand-labelled videos and score each prompt and model against them.</Empty>
      </Panel>
    </div>
  );
}

/** A count that only means something once users act on clips (Step 13). */
function signal(n: number, clips: number) {
  return n > 0 ? `${n} (${pct(n, clips)})` : <span className="text-subtle">—</span>;
}

function RuleBars({ title, rows, total }: { title: string; rows: RuleCount[]; total: number }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{title}</span>
      {rows.map((r) => {
        const clean = r.rule === "clean" || r.rule === "earlier" || r.rule === "later";
        return (
          <div key={r.rule} className="flex flex-col gap-1">
            <div className="flex justify-between gap-3 text-xs">
              <span>
                <span className="font-mono">{r.rule}</span>
                <span className="text-subtle"> — {RULE_NOTES[r.rule] ?? "older rule"}</span>
              </span>
              <span className="font-mono">
                {r.count} · {pct(r.count, total)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-border">
              <div className={cn("h-full rounded-full", clean ? "bg-primary" : "bg-warning")} style={{ width: `${(r.count / total) * 100}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
