/**
 * Proves the database backup (Step 17, D53).
 *
 *   npm run backup:smoke
 *
 * Throwaway databases <MONGODB_DB>_backuptest and <MONGODB_DB>_backuptest_restored (dropped), a
 * temp folder under worker/.scratch, and one real round trip through Cloudinary in the
 * `smoketest/backups/` folder (cleaned afterwards).
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";

import mongoose, { Types } from "mongoose";

import { env } from "../src/config/env";
import { deleteBackup, downloadBackup, listBackups, uploadBackup } from "../src/backup/storage";
import { backupFileName, backupsToDelete, readBackup, restoreBackup, writeBackup } from "../src/lib/backup";
import { connectDb, disconnectDb } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { runShutdownHooks } from "../src/lib/shutdown";

logger.level = "silent";

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function rejects(p: Promise<unknown>, match: RegExp, what: string) {
  try {
    await p;
  } catch (err) {
    assert(match.test(err instanceof Error ? err.message : String(err)), `${what}: unexpected error ${err instanceof Error ? err.message : err}`);
    return;
  }
  throw new Error(`${what}: expected an error`);
}

const SRC = `${env.MONGODB_DB}_backuptest`;
const DST = `${SRC}_restored`;
const DIR = path.join(env.SCRATCH_DIR, "backup-smoke");
const CLOUD_FOLDER = "smoketest";

async function main() {
  console.log(`\nBackup smoke test → "${SRC}" and "${DST}" (dropped), Cloudinary "${CLOUD_FOLDER}/backups/" (cleaned)\n`);
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  await connectDb({ dbName: SRC, autoIndex: false });
  const src = mongoose.connection.db!;
  const dst = mongoose.connection.useDb(DST, { useCache: false }).db!;
  for (const db of [src, dst]) for (const c of await db.listCollections().toArray()) await db.dropCollection(c.name);

  const userId = new Types.ObjectId();
  const videoId = new Types.ObjectId();
  const when = new Date("2026-10-06T08:30:00.123Z");
  await src.collection("videos").insertMany([
    { _id: videoId, userId, title: "সাফে ভালো করবে বাংলাদেশ", createdAt: when, media: { durationMs: 115264, hasAudio: true }, tags: ["a", "b"], nothing: null },
    { _id: new Types.ObjectId(), userId, title: "second", createdAt: when },
  ]);
  await src.collection("transcripts").insertOne({ videoId, latnWords: { "100_200": "ami", "300_400": "valo" }, big: 12345678901234n as unknown as number, n: 1.5 });
  await src.collection("empty_one").insertOne({ x: 1 });
  await src.collection("empty_one").deleteMany({});

  const file = path.join(DIR, backupFileName(SRC, when));

  await test("backup + restore: every collection and document comes back with its exact types (ObjectId, Date, nested objects, Bangla, null, numbers); an empty collection too", async () => {
    const summary = await writeBackup(src, file, when);
    assert(summary.docs === 3 && summary.counts.videos === 2 && summary.counts.transcripts === 1 && summary.counts.empty_one === 0, JSON.stringify(summary));
    const restored = await restoreBackup(file, dst);
    assert(restored.docs === 3 && restored.db === SRC && restored.at === when.toISOString(), JSON.stringify(restored));
    const back = await dst.collection("videos").findOne({ _id: videoId });
    assert(back && back.userId instanceof Types.ObjectId && String(back.userId) === String(userId), "ObjectId lost its type");
    assert(back.createdAt instanceof Date && back.createdAt.getTime() === when.getTime(), "Date lost its type or its milliseconds");
    assert(back.title === "সাফে ভালো করবে বাংলাদেশ" && back.media.durationMs === 115264 && back.nothing === null && back.tags.join() === "a,b", "values changed");
    const tr = await dst.collection("transcripts").findOne({ videoId });
    assert(tr?.latnWords["100_200"] === "ami" && tr.n === 1.5, "nested map or number changed");
    assert((await dst.listCollections({ name: "empty_one" }).toArray()).length === 0 || (await dst.collection("empty_one").countDocuments()) === 0, "empty collection got documents");
  });

  await test("restore safety: refuses a database that already has documents (unless --drop); with drop it replaces them", async () => {
    await rejects(restoreBackup(file, dst), /already has documents/, "second restore into a full database");
    await dst.collection("videos").insertOne({ stray: true });
    await restoreBackup(file, dst, { drop: true });
    assert((await dst.collection("videos").countDocuments()) === 2 && (await dst.collection("videos").countDocuments({ stray: true })) === 0, "drop didn't replace");
  });

  await test("a damaged backup is refused before anything is written: cut short, wrong counts, not a backup", async () => {
    const lines = (await readGz(file)).trimEnd().split("\n");
    const target = mongoose.connection.useDb(`${SRC}_x`, { useCache: false }).db!;
    const cut = path.join(DIR, "cut.ejson.gz");
    await writeGz(cut, lines.slice(0, -1).join("\n") + "\n"); // without the closing line
    await rejects(restoreBackup(cut, target), /cut short/, "cut file");
    const wrong = path.join(DIR, "wrong.ejson.gz");
    await writeGz(wrong, lines.slice(0, 3).concat(lines.slice(-1)).join("\n") + "\n"); // a document missing
    await rejects(restoreBackup(wrong, target), /damaged/, "missing documents");
    const junk = path.join(DIR, "junk.ejson.gz");
    await writeGz(junk, '{"c":"videos","d":{"a":1}}\n');
    await rejects(restoreBackup(junk, target), /no header/, "no header");
    assert((await target.listCollections().toArray()).length === 0, "something was written from a damaged file");
    await target.dropDatabase().catch(() => {});
    void readBackup;
  });

  await test("file names sort by time, and only the newest N are kept", async () => {
    const names = [new Date("2026-10-01T10:00:00Z"), new Date("2026-10-03T23:59:00Z"), new Date("2026-10-02T00:05:00Z"), new Date("2026-09-30T12:00:00Z")].map((d) => backupFileName("db", d));
    assert(names[1] === "clipcut-db-2026-10-03-2359.ejson.gz", names[1]!);
    assert(backupsToDelete(names, 2).sort().join() === [names[0]!, names[3]!].sort().join(), "wrong ones deleted");
    assert(backupsToDelete(names, 10).length === 0 && backupsToDelete(names, 0).length === 4, "bounds");
  });

  await test("Cloudinary round trip: upload → listed → download is byte-identical and restorable → deleted; an oversized backup is refused with a clear message", async () => {
    const name = backupFileName(SRC, new Date());
    const up = await uploadBackup(file, name, SRC, CLOUD_FOLDER);
    try {
      assert(up.publicId.startsWith(`${CLOUD_FOLDER}/backups/${SRC}/`) && up.bytes > 0, JSON.stringify(up));
      const listed = await listBackups(SRC, CLOUD_FOLDER);
      assert(listed.includes(up.publicId), `not listed: ${listed}`);
      const back = path.join(DIR, "downloaded.ejson.gz");
      await downloadBackup(up.publicId, back);
      assert(Buffer.compare(await readFile(back), await readFile(file)) === 0, "downloaded file differs");
      const other = mongoose.connection.useDb(`${SRC}_c`, { useCache: false }).db!;
      assert((await restoreBackup(back, other)).docs === 3, "downloaded backup didn't restore");
      await other.dropDatabase().catch(() => {});
    } finally {
      await deleteBackup(up.publicId);
    }
    assert(!(await listBackups(SRC, CLOUD_FOLDER)).includes(up.publicId), "not deleted");

    const big = path.join(DIR, "big.bin");
    await writeFile(big, Buffer.alloc(10 * 1024 * 1024, 7));
    assert((await stat(big)).size > 9 * 1024 * 1024, "setup");
    await rejects(uploadBackup(big, "big.ejson.gz", SRC, CLOUD_FOLDER), /free plan/, "oversized backup");
  });

  for (const name of [DST, `${SRC}_x`, `${SRC}_c`]) await mongoose.connection.useDb(name, { useCache: false }).dropDatabase().catch(() => {});
  await src.dropDatabase().catch(() => {});
  await rm(DIR, { recursive: true, force: true });
}

async function readGz(file: string): Promise<string> {
  const { gunzipSync } = await import("node:zlib");
  return gunzipSync(await readFile(file)).toString("utf8");
}
async function writeGz(file: string, text: string): Promise<void> {
  await pipeline(Readable.from([text]), createGzip(), createWriteStream(file));
}

main()
  .catch((err: unknown) => results.push({ name: "test run", ok: false, detail: err instanceof Error ? err.message : String(err) }))
  .finally(async () => {
    await disconnectDb().catch(() => {});
    await runShutdownHooks(() => {});
    for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? `\n      → ${r.detail}` : ""}`);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed · test databases removed\n`);
    process.exit(passed === results.length ? 0 : 1);
  });
