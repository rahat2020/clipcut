/**
 * Step 13 (clip review), the web side of Step 12 (render requests) and Step 14 ("Find new
 * clips" requests, kept clips) against a throwaway
 * MongoDB database "<MONGODB_DB>_reviewtest" (dropped at the end). No Cloudinary uploads:
 * signed URLs are only built, never fetched.
 *
 *   npm run review:smoke
 */
import { loadEnvConfig } from "@next/env";
import mongoose, { Types } from "mongoose";

import { formatEnvIssues, serverEnvSchema } from "../src/lib/env.schema";
import type { CloudinaryConfig } from "../src/lib/uploads/cloudinary-core";
import { clipUpdateSchema, updateClip } from "../src/lib/videos/clip-edit";
import { requestNewClips } from "../src/lib/videos/clip-request";
import { requestCopy, setCaptionScript } from "../src/lib/videos/copy-request";
import { downloadRender, loadRenderViews, requestRender } from "../src/lib/videos/renders";
import { clipRequestSchema } from "../src/lib/videos/schemas";
import {
  AnalysisRun,
  Clip,
  configureMongoose,
  isAppError,
  planLimitsSchema,
  Render,
  renderSpecForClip,
  renderSpecHash,
  Transcript,
  User,
  Video,
} from "../src/shared";

loadEnvConfig(process.cwd());

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}
function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
async function codeOf(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return isAppError(err) ? err.code : `non-AppError: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main() {
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("web/.env.local is invalid:\n" + formatEnvIssues(parsed.error).map((l) => `  - ${l}`).join("\n"));
    process.exit(1);
  }
  const env = parsed.data;
  const cfg: CloudinaryConfig = { cloudName: env.CLOUDINARY_CLOUD_NAME, apiKey: env.CLOUDINARY_API_KEY, apiSecret: env.CLOUDINARY_API_SECRET, baseFolder: "smoketest" };
  const dbName = `${env.MONGODB_DB}_reviewtest`;
  configureMongoose();
  await mongoose.connect(env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 15_000 });
  console.log(`\nClip review smoke test · database "${dbName}"\n`);

  try {
    await mongoose.connection.dropDatabase();
    await Render.createIndexes();
    const user = await User.create({ clerkId: "user_review", email: "review@example.com" });
    const other = await User.create({ clerkId: "user_other", email: "other@example.com" });
    const ctx = { user: { _id: user._id, plan: user.plan } };

    const videoId = new Types.ObjectId();
    const transcript = await Transcript.create({ videoId, userId: user._id, version: 1, kind: "asr", language: "bn", script: "Beng", segments: [] });
    const run = await AnalysisRun.create({
      videoId,
      userId: user._id,
      transcriptId: transcript._id,
      kind: "initial",
      input: { intent: "best", targetClipCount: 2, minClipMs: 15_000, maxClipMs: 90_000 },
      ai: { provider: "gemini", model: "x", promptVersion: "clip-select@1" },
      status: "done",
    });
    const oldRun = await AnalysisRun.create({ ...run.toObject(), _id: new Types.ObjectId(), status: "done" });
    const [clip, stale] = await Clip.insertMany([
      { videoId, userId: user._id, analysisRunId: run._id, origin: "ai", rank: 1, startMs: 10_000, endMs: 40_000, durationMs: 30_000 },
      { videoId, userId: user._id, analysisRunId: oldRun._id, origin: "ai", rank: 1, startMs: 0, endMs: 20_000, durationMs: 20_000 },
    ]);
    await Video.create({
      _id: videoId,
      userId: user._id,
      title: "Review test",
      language: "bn",
      source: { type: "upload" },
      permission: { confirmedAt: new Date(), termsVersion: "2026-09-28" },
      media: { durationMs: 120_000, hasAudio: true },
      currentTranscriptId: transcript._id,
      currentAnalysisRunId: run._id,
      status: "ready",
      retention: { finishedAt: new Date() },
    });
    const id = String(clip!._id);
    const read = () => Clip.findById(clip!._id).lean().orFail();

    await test("verdict: approve, reject with a reason, undo clears the reason", async () => {
      await updateClip(ctx, id, { status: "approved" });
      expect((await read()).status === "approved", "not approved");
      await updateClip(ctx, id, { status: "rejected", reason: "Cut off mid-sentence" });
      const r = await read();
      expect(r.status === "rejected" && r.feedback?.reason === "Cut off mid-sentence" && r.feedback.at, JSON.stringify(r.feedback));
      await updateClip(ctx, id, { status: "suggested" });
      const u = await read();
      expect(u.status === "suggested" && !u.feedback, `after undo ${u.status} ${JSON.stringify(u.feedback)}`);
    });

    await test("trim: range saved, the AI's cut remembered once, back to it = not trimmed", async () => {
      await updateClip(ctx, id, { startMs: 9_500, endMs: 41_000 });
      let c = await read();
      expect(c.startMs === 9_500 && c.endMs === 41_000 && c.durationMs === 31_500, `range ${c.startMs}-${c.endMs}`);
      expect(c.edit?.aiStartMs === 10_000 && c.edit.aiEndMs === 40_000, `ai ${c.edit?.aiStartMs}-${c.edit?.aiEndMs}`);
      await updateClip(ctx, id, { startMs: 11_000, endMs: 41_000 });
      c = await read();
      expect(c.edit?.aiStartMs === 10_000, "second trim overwrote the AI's cut");
      await updateClip(ctx, id, { startMs: 10_000, endMs: 40_000 });
      c = await read();
      expect(c.edit?.aiStartMs == null && c.edit?.aiEndMs == null && c.durationMs === 30_000, "reset didn't clear the trim");
    });

    await test("trim: too short, past the video's end, or one edge alone are refused", async () => {
      expect((await codeOf(() => updateClip(ctx, id, { startMs: 10_000, endMs: 12_000 }))) === "VALIDATION_FAILED", "2 s clip accepted");
      expect((await codeOf(() => updateClip(ctx, id, { startMs: 100_000, endMs: 130_000 }))) === "VALIDATION_FAILED", "past the end accepted");
      expect(!clipUpdateSchema.safeParse({ startMs: 1_000 }).success, "start without end accepted");
      expect(!clipUpdateSchema.safeParse({}).success, "empty change accepted");
      expect(!clipUpdateSchema.safeParse({ captionStyleId: "preset:nope" }).success, "unknown caption style accepted");
      expect(!clipUpdateSchema.safeParse({ cropOffsetX: 1.5 }).success, "offset outside -1…1 accepted");
    });

    await test("framing + caption style saved (offset rounded to 0.01)", async () => {
      await updateClip(ctx, id, { cropOffsetX: 0.337, captionStyleId: "preset:clean" });
      const c = await read();
      expect(c.edit?.cropOffsetX === 0.34 && c.edit.captionStyleId === "preset:clean", JSON.stringify(c.edit));
    });

    await test("ownership: another user's request and a clip from an older run are NOT_FOUND", async () => {
      expect((await codeOf(() => updateClip({ user: { _id: other._id } }, id, { status: "approved" }))) === "NOT_FOUND", "other user could edit");
      expect((await codeOf(() => updateClip(ctx, String(stale!._id), { status: "approved" }))) === "NOT_FOUND", "stale clip editable");
      expect((await codeOf(() => requestRender({ cfg, user: { _id: other._id, plan: "free" } }, id))) === "NOT_FOUND", "other user could render");
    });

    await test("render request: queued once, same render on a second click; while processing → CONFLICT", async () => {
      const a = await requestRender({ cfg, ...ctx }, id);
      const b = await requestRender({ cfg, ...ctx }, id);
      expect(a.status === "queued" && a.id === b.id && !a.outdated, JSON.stringify(a));
      expect((await Render.countDocuments({ clipId: clip!._id })) === 1, "two renders for one spec");
      expect(String((await read()).latestRenderId) === a.id, "latestRenderId not set");
      await Video.updateOne({ _id: videoId }, { $set: { status: "processing" } });
      expect((await codeOf(() => requestRender({ cfg, ...ctx }, id))) === "CONFLICT", "render allowed while processing");
      await Video.updateOne({ _id: videoId }, { $set: { status: "ready" } });
    });

    await test("outdated: a ready render goes out of date after a trim; rendering again makes a new one", async () => {
      const current = await read();
      const spec = renderSpecForClip(current, { language: "bn" }, 1);
      await Render.updateOne(
        { clipId: clip!._id, specHash: renderSpecHash(spec) },
        { $set: { status: "ready", output: { publicId: "smoketest/renders/x", secureUrl: "https://example.com/x.mp4", bytes: 1234 } } },
      );
      const videoDoc = await Video.findById(videoId).lean().orFail();
      let views = await loadRenderViews(cfg, videoDoc);
      expect(views.length === 1 && views[0]!.status === "ready" && !views[0]!.outdated && views[0]!.previewUrl?.includes("/authenticated/"), JSON.stringify(views));
      await updateClip(ctx, id, { startMs: 12_000, endMs: 40_000 });
      views = await loadRenderViews(cfg, videoDoc);
      expect(views[0]!.outdated, "not outdated after a trim");
      const again = await requestRender({ cfg, ...ctx }, id);
      expect(again.status === "queued" && again.id !== views[0]!.id && (await Render.countDocuments({ clipId: clip!._id })) === 2, "no new render");
    });

    await test("download: signed attachment URL named clip-1; the 'downloaded' signal is recorded", async () => {
      const ready = await Render.findOne({ clipId: clip!._id, status: "ready" }).lean().orFail();
      const url = await downloadRender({ cfg, ...ctx }, String(ready._id));
      expect(url.includes("fl_attachment:clip-1") && url.includes("/s--"), url);
      expect((await read()).signals?.downloaded === true, "signal not set");
      expect((await codeOf(() => downloadRender({ cfg, user: { _id: other._id, plan: "free" } }, String(ready._id)))) === "NOT_FOUND", "other user could download");
    });

    await test("kept clips (Step 14): approved in an older set → still editable and renderable; other old clips aren't", async () => {
      await Clip.updateOne({ _id: stale!._id }, { $set: { status: "approved", keptAt: new Date() } });
      expect((await codeOf(() => updateClip(ctx, String(stale!._id), { cropOffsetX: 0.2 }))) === null, "kept clip not editable");
      const r = await requestRender({ cfg, ...ctx }, String(stale!._id));
      expect(r.status === "queued", `render ${r.status}`);
      const views = await loadRenderViews(cfg, await Video.findById(videoId).lean().orFail());
      expect(views.some((v) => v.clipId === String(stale!._id)), "kept clip's render not listed");
      await Clip.updateOne({ _id: stale!._id }, { $unset: { keptAt: 1 } });
      expect((await codeOf(() => updateClip(ctx, String(stale!._id), { status: "rejected" }))) === "NOT_FOUND", "old clip editable without keptAt");
    });

    const limits = planLimitsSchema.parse({});
    const reqCtx = { user: { _id: user._id, plan: "free" }, limits };
    const finished = (await Video.findById(videoId).lean().orFail()).retention?.finishedAt;
    await Video.updateOne(
      { _id: videoId },
      { $set: { "pipeline.runId": "r0", "pipeline.stages.transcribe.status": "done", "pipeline.stages.analyze.status": "done", "pipeline.stages.copy.status": "skipped", "pipeline.stages.render.status": "done" } },
    );

    await test("find new clips: a description is required for 'custom'; another user's video is NOT_FOUND", async () => {
      expect(!clipRequestSchema.safeParse({ intent: "custom" }).success && !clipRequestSchema.safeParse({ intent: "custom", query: "ab" }).success, "custom without a description accepted");
      expect(clipRequestSchema.parse({ intent: "funny", query: "ignored" }).query === null, "query kept for a non-custom focus");
      expect(!clipRequestSchema.safeParse({ intent: "nope" }).success, "unknown focus accepted");
      expect((await codeOf(() => requestNewClips({ user: { _id: other._id, plan: "free" }, limits }, String(videoId), { intent: "best" }))) === "NOT_FOUND", "other user's video");
    });

    await test("find new clips: back to the queue from Finding moments, request + old stage states recorded; retention clock untouched", async () => {
      await requestNewClips(reqCtx, String(videoId), { intent: "custom", query: "  where they talk about the final  " });
      const v = await Video.findById(videoId).lean().orFail();
      expect(v.status === "queued" && v.pipeline?.runId !== "r0" && v.pipeline?.stages?.analyze?.status === "pending" && v.pipeline.stages.render?.status === "pending", `status ${v.status}`);
      expect(v.options?.intent === "custom" && v.options.customQuery === "where they talk about the final", JSON.stringify(v.options));
      const r = v.clipRequest;
      expect(r?.status === "pending" && r.query === "where they talk about the final" && r.previousStages?.copy === "skipped" && r.previousStages.analyze === "done", JSON.stringify(r));
      expect(v.counts?.clipRequests === 1 && v.pipeline?.stages?.transcribe?.status === "done", `counts ${v.counts?.clipRequests}`);
      expect(v.retention?.finishedAt?.getTime() === finished?.getTime(), "retention clock changed");
      expect((await codeOf(() => requestNewClips(reqCtx, String(videoId), { intent: "best" }))) === "CONFLICT", "second request while queued");
    });

    await test("find new clips: plan limit, one video at a time, no transcript", async () => {
      await Video.updateOne({ _id: videoId }, { $set: { status: "ready", "counts.clipRequests": limits.clipRequestsPerVideo } });
      expect((await codeOf(() => requestNewClips(reqCtx, String(videoId), { intent: "best" }))) === "CLIP_REQUEST_LIMIT", "limit not enforced");
      await Video.updateOne({ _id: videoId }, { $set: { "counts.clipRequests": 0 } });
      const busy = await Video.create({
        userId: user._id,
        title: "Busy",
        language: "bn",
        source: { type: "upload" },
        permission: { confirmedAt: new Date(), termsVersion: "2026-09-28" },
        status: "processing",
      });
      expect((await codeOf(() => requestNewClips(reqCtx, String(videoId), { intent: "best" }))) === "CONCURRENCY_LIMIT", "two at once");
      await Video.deleteOne({ _id: busy._id });
      await Video.updateOne({ _id: videoId }, { $set: { "pipeline.stages.transcribe.status": "failed" } });
      expect((await codeOf(() => requestNewClips(reqCtx, String(videoId), { intent: "best" }))) === "CONFLICT", "no transcript accepted");
      await Video.updateOne({ _id: videoId }, { $set: { "pipeline.stages.transcribe.status": "done" } });
    });

    await test("post text (Step 15): edited by hand — cleaned, hashtags normalised, stamped edited + current letters", async () => {
      await updateClip(ctx, id, { copy: { title: "  নতুন   শিরোনাম ", hook: "হুক", description: "বর্ণনা", hashtags: ["বাংলাদেশ ফুটবল", "#SAFF", "#saff"] } });
      const c = await read();
      expect(c.copy?.title === "নতুন শিরোনাম" && c.copy.hashtags.join(" ") === "#বাংলাদেশফুটবল #SAFF", JSON.stringify(c.copy));
      expect(c.copy?.editedAt && c.copy.script === "Beng" && c.copy.language === "bn", "not stamped");
      expect(!clipUpdateSchema.safeParse({ copy: { title: " ", hook: "", description: "", hashtags: [] } }).success, "empty title accepted");
    });

    await test("write again / suggest words / Banglish: copy stage only, clip marked, plan limit, Bangla videos only; a failed request unmarks the clip", async () => {
      await Video.updateOne({ _id: videoId }, { $set: { status: "ready", "counts.copyRequests": 0, "pipeline.stages.render.status": "done" } });
      await requestCopy(reqCtx, String(videoId), { clipId: id });
      let v = await Video.findById(videoId).lean().orFail();
      expect(v.status === "queued" && v.pipeline?.stages?.copy?.status === "pending" && v.pipeline.stages.render?.status === "done", `status ${v.status} copy ${v.pipeline?.stages?.copy?.status}`);
      expect(v.counts?.copyRequests === 1 && (await read()).copyRedoAt, "not counted / clip not marked");
      expect((await codeOf(() => requestCopy(reqCtx, String(videoId), {}))) === "CONFLICT", "second request while queued");

      // "Suggest words" (Step 15.6): marks the cover only, needs a clip, counts like any rewrite.
      await Video.updateOne({ _id: videoId }, { $set: { status: "ready" } });
      await Clip.updateOne({ _id: clip!._id }, { $unset: { copyRedoAt: 1 } });
      expect((await codeOf(() => requestCopy(reqCtx, String(videoId), { part: "cover" })))?.includes("Cover words are asked for one clip"), "cover words without a clip"); // ZodError → VALIDATION_FAILED in apiRoute
      await requestCopy(reqCtx, String(videoId), { clipId: id, part: "cover" });
      const marked = await read();
      v = await Video.findById(videoId).lean().orFail();
      expect(marked.coverRedoAt && !marked.copyRedoAt && v.counts?.copyRequests === 2 && v.status === "queued", "cover request not marked / counted");

      await Video.updateOne({ _id: videoId }, { $set: { status: "ready", "counts.copyRequests": 1 } });
      await Clip.updateOne({ _id: clip!._id }, { $unset: { copyRedoAt: 1, coverRedoAt: 1 } });
      await setCaptionScript(reqCtx, String(videoId), { script: "Latn" });
      v = await Video.findById(videoId).lean().orFail();
      expect(v.options?.captionScript === "Latn" && v.status === "queued" && v.counts?.copyRequests === 2, `script ${v.options?.captionScript}`);
      await Video.updateOne({ _id: videoId }, { $set: { status: "ready" } });
      await setCaptionScript(reqCtx, String(videoId), { script: "Latn" }); // already Banglish: nothing to do
      expect((await Video.findById(videoId).lean().orFail()).status === "ready", "same letters re-queued");

      await Video.updateOne({ _id: videoId }, { $set: { "counts.copyRequests": limits.copyRequestsPerVideo } });
      expect((await codeOf(() => requestCopy(reqCtx, String(videoId), { clipId: id }))) === "COPY_REQUEST_LIMIT", "limit not enforced");
      expect(!(await read()).copyRedoAt, "clip left marked after a refused request");
      await Video.updateOne({ _id: videoId }, { $set: { "counts.copyRequests": 0, language: "en" } });
      expect((await codeOf(() => setCaptionScript(reqCtx, String(videoId), { script: "Beng" }))) === "VALIDATION_FAILED", "Banglish on an English video");
      await Video.updateOne({ _id: videoId }, { $set: { language: "bn" }, $unset: { "options.captionScript": 1 } });
    });

    await test("expired files: verdicts still work, trims / framing / renders / new clips don't", async () => {
      await Video.updateOne({ _id: videoId }, { $set: { "retention.assetsDeletedAt": new Date() } });
      expect((await codeOf(() => updateClip(ctx, id, { status: "approved" }))) === null, "verdict blocked");
      expect((await codeOf(() => updateClip(ctx, id, { cropOffsetX: 0 }))) === "MEDIA_EXPIRED", "framing allowed");
      expect((await codeOf(() => requestRender({ cfg, ...ctx }, id))) === "MEDIA_EXPIRED", "render allowed");
      expect((await codeOf(() => requestNewClips(reqCtx, String(videoId), { intent: "best" }))) === "MEDIA_EXPIRED", "new clips allowed");
    });
  } finally {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }

  const failed = results.filter((r) => !r.ok).length;
  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    → ${r.detail}`}`);
  console.log(`\n${results.length - failed}/${results.length} passed · database "${dbName}" dropped\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
