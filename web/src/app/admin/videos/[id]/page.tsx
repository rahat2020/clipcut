import { BanIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { cancelVideoAction, deleteVideoAction, rerunClipsAction, retryVideoAction } from "@/app/admin/videos/actions";
import { setVideoExpiryAction } from "@/app/admin/settings/actions";
import { ActionButton } from "@/components/admin/action-button";
import { ExpiryForm } from "@/components/admin/expiry-form";
import { RerunClipsForm } from "@/components/admin/rerun-clips-form";
import { Empty, Facts, PageHeader, Panel, Tag } from "@/components/admin/ui";
import { StatusBadge } from "@/components/app/status-badge";
import { TranscriptPanel } from "@/components/app/transcript-panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listModels } from "@/lib/admin/ai-service";
import { getVideoForAdmin } from "@/lib/admin/videos-service";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { env } from "@/lib/env";
import { formatDuration, formatUtc, fromNow } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { LANGUAGE_NAMES, MOMENT_LABELS, STAGE_LABELS } from "@/lib/video-labels";
import { ACTIVE_VIDEO_STATUSES, DEFAULT_PLAN, effectiveExpiry, getSettings, PROMPT_VERSIONS, STAGE_NAMES, type MomentType } from "@/shared";

export const metadata: Metadata = { title: "Video · Admin" };


function took(start?: Date | null, end?: Date | null): string {
  return start && end ? formatDuration(new Date(end).getTime() - new Date(start).getTime()) : "—";
}

/** Signed seconds, e.g. "+1.4 s", for how far code moved the AI's cut. */
function shift(ms: number): string {
  if (ms === 0) return "0";
  return `${ms > 0 ? "+" : "−"}${(Math.abs(ms) / 1000).toFixed(1)} s`;
}

/**
 * One video, everything about it (docs/ADMIN.md — Videos and jobs): pipeline timeline,
 * error, transcript, every clip run with its model/prompt/tokens, the clips of a run
 * with AI-proposed vs final cuts, charges and admin history — plus the actions.
 */
export default async function AdminVideoPage({ params, searchParams }: PageProps<"/admin/videos/[id]">) {
  await requireAdminPage();
  const { id } = await params;
  const run = (await searchParams).run;
  const data = await getVideoForAdmin(id, typeof run === "string" ? run : null);
  if (!data) notFound();
  const { video, owner, transcript, runs, clips, selectedRunId, usage, audit } = data;

  const [ai, retention] = await Promise.all([getSettings("ai"), getSettings("retention")]);
  const filesExpiry = effectiveExpiry(video, owner?.plan ?? DEFAULT_PLAN, retention);
  const keys = { gemini: env.GEMINI_API_KEY, groq: env.GROQ_API_KEY };
  const [gemini, groq] = await Promise.all([listModels("gemini", "text", keys), listModels("groq", "text", keys)]);

  const active = (ACTIVE_VIDEO_STATUSES as readonly string[]).includes(video.status);
  const deleted = !!video.deletedAt;
  const canRetry = !deleted && (video.status === "failed" || video.status === "canceled");
  const rerunBlocked = deleted
    ? "This video was deleted."
    : active
      ? "Wait until this video stops processing."
      : video.pipeline?.stages?.transcribe?.status !== "done"
        ? "No transcript yet — clips can only be picked again after transcription."
        : null;
  const pending = video.pipeline?.analyzeWith;

  return (
    <div className="flex max-w-7xl flex-col gap-6">
      <PageHeader
        back={{ href: ROUTES.adminVideos, label: "Videos & jobs" }}
        title={<span lang={video.language}>{video.title}</span>}
        actions={
          <>
            {canRetry && (
              <ActionButton
                label="Retry"
                icon={<RotateCwIcon />}
                action={retryVideoAction.bind(null, id)}
                success="Queued again."
                confirm={{
                  title: "Retry this video?",
                  description: "It goes back to the queue. Finished stages are kept; the user's quota and one-at-a-time rules are skipped.",
                  confirmLabel: "Retry",
                }}
              />
            )}
            {active && !deleted && (
              <ActionButton
                label="Cancel"
                icon={<BanIcon />}
                action={cancelVideoAction.bind(null, id)}
                success="Canceled."
                confirm={{ title: "Cancel processing?", description: "The worker stops at its next step. The user can't retry a canceled video; you can.", confirmLabel: "Cancel video", destructive: true }}
              />
            )}
            {!deleted && (
              <ActionButton
                label="Delete"
                icon={<Trash2Icon />}
                variant="destructive"
                action={deleteVideoAction.bind(null, id)}
                success="Video deleted."
                redirectTo={ROUTES.adminVideos}
                confirm={{
                  title: "Delete this video for its owner?",
                  description: "It disappears from the user's account and its files are removed from Cloudinary. This can't be undone.",
                  confirmLabel: "Delete video",
                  destructive: true,
                  input: { label: 'Type "delete" to confirm', mustEqual: "delete" },
                }}
              />
            )}
          </>
        }
      />

      <Panel
        title="Video"
        aside={
          <span className="flex items-center gap-2">
            <StatusBadge status={video.status} />
            {deleted && <Tag tone="danger">Deleted {fromNow(video.deletedAt!)}</Tag>}
          </span>
        }
      >
        <Facts
          items={[
            ["Owner", owner ? <Link href={`${ROUTES.adminUsers}/${String(owner._id)}`} className="hover:underline">{owner.email}</Link> : "—"],
            ["Language", <>{LANGUAGE_NAMES[video.language]}{video.languageCheck?.switched ? ` (picked ${LANGUAGE_NAMES[video.languageCheck.requested]}, switched)` : ""}</>],
            [
              "Source",
              video.source.type === "youtube" && video.source.externalId ? (
                <a href={`https://www.youtube.com/watch?v=${video.source.externalId}`} target="_blank" rel="noreferrer" className="hover:underline">
                  YouTube · {video.source.externalId}
                </a>
              ) : (
                `${video.source.type}${video.source.originalFilename ? ` · ${video.source.originalFilename}` : ""}`
              ),
            ],
            ["Length", video.media?.durationMs != null ? `${formatDuration(video.media.durationMs)} · ${video.media.width ?? "?"}×${video.media.height ?? "?"}` : "—"],
            ["Added", formatUtc(video.createdAt)],
            ["Finished", formatUtc(video.retention?.finishedAt)],
            ["Run id", <span key="r" className="font-mono text-xs">{video.pipeline?.runId ?? "—"}</span>],
            ["Stuck-run restarts", String(video.pipeline?.recoveries ?? 0)],
            ["Clip options", `${video.options?.intent ?? "best"} · ${video.options?.targetClipCount ?? 10} clips · ${Math.round((video.options?.minClipMs ?? 0) / 1000)}–${Math.round((video.options?.maxClipMs ?? 0) / 1000)} s`],
          ]}
        />
        {video.error && (
          <div className="mx-4.5 mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
            <p className="font-mono text-destructive">
              {video.error.stage ?? "?"} · {video.error.code} {video.error.retryable ? "(retryable)" : "(not retryable)"}
            </p>
            <p className="mt-1 text-foreground/90">{video.error.message}</p>
            <p className="mt-1 text-xs text-subtle">{formatUtc(video.error.at)}</p>
          </div>
        )}
        {pending && (
          <p className="mx-4.5 mb-4 text-sm text-info">
            Clip re-pick requested by {pending.requestedBy} {fromNow(pending.at)}: {pending.provider} · {pending.model} · {pending.promptVersion}
          </p>
        )}
      </Panel>

      <Panel
        title="Files"
        aside={
          video.retention?.assetsDeletedAt ? (
            <Tag tone="danger">Deleted {fromNow(video.retention.assetsDeletedAt)}</Tag>
          ) : filesExpiry ? (
            <span>
              Kept until {formatUtc(filesExpiry)} · {fromNow(filesExpiry)}
              {video.retention?.expireOverrideAt ? " · custom date" : ""}
            </span>
          ) : (
            "Clock starts when processing ends"
          )
        }
      >
        {!deleted && !video.retention?.assetsDeletedAt ? (
          <ExpiryForm hasOverride={!!video.retention?.expireOverrideAt} action={setVideoExpiryAction.bind(null, id)} />
        ) : (
          <p className="px-4.5 py-4 text-sm text-subtle">The files are gone, so there is nothing to keep.</p>
        )}
      </Panel>

      <Panel title="Pipeline">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4.5">Stage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Took</TableHead>
              <TableHead>Attempts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {STAGE_NAMES.map((name) => {
              const s = video.pipeline?.stages?.[name];
              const status = s?.status ?? "pending";
              return (
                <TableRow key={name}>
                  <TableCell className="px-4.5">{STAGE_LABELS[name]}</TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "font-mono text-xs",
                        status === "done" && "text-primary",
                        status === "running" && "text-info",
                        status === "failed" && "text-destructive",
                        (status === "pending" || status === "skipped") && "text-subtle",
                      )}
                    >
                      {status}
                      {status === "running" && s?.progress ? ` ${Math.round(s.progress * 100)}%` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{formatUtc(s?.startedAt)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{took(s?.startedAt, s?.finishedAt)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{s?.attempts ?? 0}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Panel>

      <Panel title="Pick clips again">
        <RerunClipsForm
          action={rerunClipsAction.bind(null, id)}
          defaults={{ provider: ai.clipSelection.provider, model: ai.clipSelection.model, promptVersion: ai.clipSelection.promptVersion }}
          models={{ gemini: gemini.ok ? gemini.models : [], groq: groq.ok ? groq.models : [] }}
          promptVersions={PROMPT_VERSIONS.clipSelection}
          disabledReason={rerunBlocked}
        />
      </Panel>

      <Panel title="Clip runs" aside={`${runs.length} run${runs.length === 1 ? "" : "s"}`}>
        {runs.length === 0 ? (
          <Empty>No clip-selection run yet.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4.5">When</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Tokens in / out</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Kept</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => {
                const rid = String(r._id);
                const current = rid === String(video.currentAnalysisRunId ?? "");
                const selected = rid === selectedRunId;
                return (
                  <TableRow key={rid} className={cn(selected && "bg-raised")}>
                    <TableCell className="px-4.5 font-mono text-xs whitespace-nowrap">
                      <Link href={`?run=${rid}`} scroll={false} className="hover:underline">
                        {formatUtc(r.createdAt)}
                      </Link>
                      {current && <span className="ml-2 text-primary">current</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.kind}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.ai?.provider} · {r.ai?.model}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{r.ai?.promptVersion}</TableCell>
                    <TableCell className={cn("font-mono text-xs", r.status === "done" ? "text-primary" : r.status === "failed" ? "text-destructive" : "text-info")}>
                      {r.status}
                      {r.error?.code ? ` · ${r.error.code}` : ""}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.usage?.inputTokens?.toLocaleString("en-US") ?? "—"} / {r.usage?.outputTokens?.toLocaleString("en-US") ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.usage?.latencyMs != null ? `${(r.usage.latencyMs / 1000).toFixed(1)} s` : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.result?.accepted ?? "—"} of {r.result?.candidates ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Panel title="Clips" aside={selectedRunId ? "AI-proposed vs final cut — shift is how far code moved the AI's boundary" : undefined}>
        {clips.length === 0 ? (
          <Empty>{selectedRunId ? "This run kept no clips." : "No clips yet."}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4.5">#</TableHead>
                <TableHead>AI proposed</TableHead>
                <TableHead>Final</TableHead>
                <TableHead>Shift start / end</TableHead>
                <TableHead>Rules</TableHead>
                <TableHead>Score</TableHead>
                <TableHead className="min-w-80">Reason and words</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clips.map((c) => (
                <TableRow key={String(c._id)} className="align-top">
                  <TableCell className="px-4.5 font-mono">{c.rank ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">
                    {c.ai ? `${formatDuration(c.ai.rawStartMs)}–${formatDuration(c.ai.rawEndMs)}` : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    {formatDuration(c.startMs)}–{formatDuration(c.endMs)}
                    <span className="block text-subtle">{Math.round(c.durationMs / 1000)} s</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">
                    {c.ai ? `${shift(c.startMs - c.ai.rawStartMs)} / ${shift(c.endMs - c.ai.rawEndMs)}` : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {c.snap?.startRule ? `start ${c.snap.startRule}` : "—"}
                    {c.snap?.endRule && <span className="block">end {c.snap.endRule}</span>}
                    {c.snap?.basis && <span className="block text-subtle">{c.snap.basis}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {c.ai?.score != null ? Math.round(c.ai.score * 100) : "—"}
                    <span className="block text-subtle">{MOMENT_LABELS[(c.ai?.momentType ?? "other") as MomentType]}</span>
                  </TableCell>
                  <TableCell className="text-sm whitespace-normal">
                    <p className="text-muted-foreground">{c.ai?.reason}</p>
                    <p lang={video.language} className="mt-1 line-clamp-3 text-foreground/90">
                      {c.transcriptText}
                    </p>
                    {c.status !== "suggested" && <Tag tone={c.status === "rejected" ? "danger" : "accent"}>{c.status}</Tag>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {transcript && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-subtle">
            Transcript · {transcript.provider} {transcript.model} · word times {transcript.wordTiming ?? "asr"} · {transcript.stats?.segmentCount ?? 0} segments ·{" "}
            {transcript.stats?.droppedSegments ?? 0} dropped as noise · avg logprob {transcript.stats?.avgLogprob ?? "—"}
          </p>
          <TranscriptPanel
            transcript={{
              language: transcript.language,
              model: transcript.model ?? null,
              wordCount: transcript.stats?.wordCount ?? 0,
              segments: transcript.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text })),
            }}
            pendingNote=""
          />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Charges">
          {usage.length === 0 ? (
            <Empty>Nothing charged for this video.</Empty>
          ) : (
            <ul className="divide-y text-sm">
              {usage.map((u) => (
                <li key={String(u._id)} className="flex justify-between gap-3 px-4.5 py-2.5">
                  <span>
                    {u.quantity} {u.unit} · {u.type}
                  </span>
                  <span className="font-mono text-xs text-subtle">{formatUtc(u.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Admin history">
          {audit.length === 0 ? (
            <Empty>No admin actions on this video.</Empty>
          ) : (
            <ul className="divide-y text-sm">
              {audit.map((a) => (
                <li key={String(a._id)} className="flex justify-between gap-3 px-4.5 py-2.5">
                  <span>
                    <span className="font-mono">{a.action}</span> <span className="text-subtle">by {a.actorEmail}</span>
                  </span>
                  <span className="font-mono text-xs text-subtle">{formatUtc(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
