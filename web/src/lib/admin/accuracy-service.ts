/**
 * Admin → Accuracy (docs/ADMIN.md "the differentiator"): how well the AI's picks hold up,
 * per prompt version × model, so a prompt or model change can be judged by numbers.
 *
 * What exists today: how many proposals survived (length/overlap checks), where the cuts
 * landed (Step 10 snap rules), fallbacks, failures, and which engine wrote transcripts.
 * User signals (approved / rejected / downloaded, rejection reasons) are counted already
 * and fill in once Step 13 adds those buttons; eval-set scores come with Steps 8 and 11.
 *
 * Read-only aggregations. No `server-only` / env imports, so scripts can call it.
 */
import { z } from "zod";

import { AnalysisRun, Clip, Transcript } from "@/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `?days=7|30|all` — default 30. */
export const accuracyQuerySchema = z.object({
  days: z.enum(["7", "30", "all"]).catch("30").default("30"),
});
export type AccuracyQuery = z.infer<typeof accuracyQuerySchema>;

/** Start rules that mean "the clip starts at a clean boundary" (snap.ts, D41). */
const CLEAN_RULES = ["clean", "earlier", "later"];

export type ModelRow = {
  promptVersion: string;
  provider: string;
  model: string;
  runs: number;
  done: number;
  failed: number;
  regenerate: number;
  proposed: number;
  kept: number;
  avgLatencyMs: number | null;
  clips: number;
  snapped: number;
  cleanStarts: number;
  cleanEnds: number;
  avgScore: number | null;
  approved: number;
  rejected: number;
  downloaded: number;
};

export type RuleCount = { rule: string; count: number };

export type AccuracyReport = {
  since: Date | null;
  models: ModelRow[];
  snap: { starts: RuleCount[]; ends: RuleCount[]; bases: RuleCount[]; total: number };
  failures: { code: string; count: number }[];
  transcripts: { language: string; provider: string; model: string; wordTiming: string; count: number }[];
  rejections: { reason: string; count: number }[];
};

type RunGroup = { _id: { promptVersion?: string; provider?: string; model?: string } } & Omit<ModelRow, "promptVersion" | "provider" | "model" | "clips" | "snapped" | "cleanStarts" | "cleanEnds" | "avgScore" | "approved" | "rejected" | "downloaded">;
type ClipGroup = { _id: { promptVersion?: string; provider?: string; model?: string } } & Pick<ModelRow, "clips" | "snapped" | "cleanStarts" | "cleanEnds" | "avgScore" | "approved" | "rejected" | "downloaded">;

const key = (id: { promptVersion?: string; provider?: string; model?: string }) => `${id.promptVersion}|${id.provider}|${id.model}`;
const count = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });

export async function loadAccuracy(query: AccuracyQuery, now = new Date()): Promise<AccuracyReport> {
  const since = query.days === "all" ? null : new Date(now.getTime() - Number(query.days) * DAY_MS);
  const created = since ? { createdAt: { $gte: since } } : {};
  const aiClips = { ...created, origin: "ai", analysisRunId: { $ne: null } };
  const snapped = { ...aiClips, "snap.version": "snap@1" };
  const byModel = { promptVersion: "$ai.promptVersion", provider: "$ai.provider", model: "$ai.model" };

  const [runGroups, clipGroups, starts, ends, bases, failures, transcripts, rejections] = await Promise.all([
    AnalysisRun.aggregate<RunGroup>([
      { $match: created },
      {
        $group: {
          _id: byModel,
          runs: { $sum: 1 },
          done: count({ $eq: ["$status", "done"] }),
          failed: count({ $eq: ["$status", "failed"] }),
          regenerate: count({ $eq: ["$kind", "regenerate"] }),
          proposed: { $sum: { $ifNull: ["$result.candidates", 0] } },
          kept: { $sum: { $ifNull: ["$result.accepted", 0] } },
          avgLatencyMs: { $avg: "$usage.latencyMs" },
        },
      },
      { $sort: { runs: -1 } },
    ]),
    Clip.aggregate<ClipGroup>([
      { $match: aiClips },
      { $lookup: { from: AnalysisRun.collection.name, localField: "analysisRunId", foreignField: "_id", as: "run", pipeline: [{ $project: { ai: 1 } }] } },
      { $unwind: "$run" },
      {
        $group: {
          _id: { promptVersion: "$run.ai.promptVersion", provider: "$run.ai.provider", model: "$run.ai.model" },
          clips: { $sum: 1 },
          snapped: count({ $eq: ["$snap.version", "snap@1"] }),
          cleanStarts: count({ $and: [{ $eq: ["$snap.version", "snap@1"] }, { $in: ["$snap.startRule", CLEAN_RULES] }] }),
          cleanEnds: count({ $and: [{ $eq: ["$snap.version", "snap@1"] }, { $in: ["$snap.endRule", CLEAN_RULES] }] }),
          avgScore: { $avg: "$ai.score" },
          approved: count({ $eq: ["$status", "approved"] }),
          rejected: count({ $eq: ["$status", "rejected"] }),
          downloaded: count({ $eq: ["$signals.downloaded", true] }),
        },
      },
    ]),
    ruleCounts(snapped, "$snap.startRule"),
    ruleCounts(snapped, "$snap.endRule"),
    ruleCounts(snapped, "$snap.basis"),
    AnalysisRun.aggregate<{ _id: string | null; count: number }>([
      { $match: { ...created, status: "failed" } },
      { $group: { _id: "$error.code", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Transcript.aggregate<{ _id: { language: string; provider?: string; model?: string; wordTiming?: string }; count: number }>([
      { $match: { ...created, kind: "asr" } },
      { $group: { _id: { language: "$language", provider: "$provider", model: "$model", wordTiming: "$wordTiming" }, count: { $sum: 1 } } },
      { $sort: { "_id.language": 1, count: -1 } },
    ]),
    Clip.aggregate<{ _id: string; count: number }>([
      { $match: { ...created, status: "rejected", "feedback.reason": { $type: "string", $ne: "" } } },
      { $group: { _id: { $toLower: { $trim: { input: "$feedback.reason" } } }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const clipsByKey = new Map(clipGroups.map((g) => [key(g._id), g]));
  const models: ModelRow[] = runGroups.map((r) => {
    const c = clipsByKey.get(key(r._id));
    return {
      promptVersion: r._id.promptVersion ?? "—",
      provider: r._id.provider ?? "—",
      model: r._id.model ?? "—",
      runs: r.runs,
      done: r.done,
      failed: r.failed,
      regenerate: r.regenerate,
      proposed: r.proposed,
      kept: r.kept,
      avgLatencyMs: r.avgLatencyMs ?? null,
      clips: c?.clips ?? 0,
      snapped: c?.snapped ?? 0,
      cleanStarts: c?.cleanStarts ?? 0,
      cleanEnds: c?.cleanEnds ?? 0,
      avgScore: c?.avgScore ?? null,
      approved: c?.approved ?? 0,
      rejected: c?.rejected ?? 0,
      downloaded: c?.downloaded ?? 0,
    };
  });

  return {
    since,
    models,
    snap: { starts, ends, bases, total: starts.reduce((sum, r) => sum + r.count, 0) },
    failures: failures.map((f) => ({ code: f._id ?? "unknown", count: f.count })),
    transcripts: transcripts.map((t) => ({
      language: t._id.language,
      provider: t._id.provider ?? "—",
      model: t._id.model ?? "—",
      // Transcripts from before wordTiming existed are Whisper's (asr).
      wordTiming: t._id.wordTiming ?? "asr",
      count: t.count,
    })),
    rejections: rejections.map((r) => ({ reason: r._id, count: r.count })),
  };
}

async function ruleCounts(match: Record<string, unknown>, field: string): Promise<RuleCount[]> {
  const rows = await Clip.aggregate<{ _id: string | null; count: number }>([
    { $match: match },
    { $group: { _id: field, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  return rows.map((r) => ({ rule: r._id ?? "—", count: r.count }));
}
