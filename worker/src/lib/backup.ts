import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";

import mongoose from "mongoose";

/**
 * MongoDB backup and restore (Step 17, D53). Atlas M0 has no backups of its own, so the whole
 * database is written to ONE gzip file: JSON lines in MongoDB's Extended JSON, which keeps
 * ObjectIds, Dates and every other type exactly (plain JSON would turn them into strings).
 *
 *   line 1   {"backup": {"version": 1, "db": "...", "at": "ISO"}}
 *   then     {"c": "<collection>", "d": <document>}      one line per document
 *   last     {"end": {"counts": {"<collection>": n, ...}}}
 *
 * A file without its last line was cut short (disk full, killed mid-write) and restore refuses it.
 * Restore never writes into the database named in `.env.local` unless told to — a backup is
 * restored into a NEW database, checked, and only then switched to.
 */

const { EJSON } = mongoose.mongo.BSON;
const FORMAT_VERSION = 1;
const RESTORE_BATCH = 500;

export type BackupSummary = { db: string; at: string; counts: Record<string, number>; docs: number };

/** Writes every collection of `db` to `file` (a .gz path). Returns what went in. */
export async function writeBackup(db: mongoose.mongo.Db, file: string, now = new Date()): Promise<BackupSummary> {
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(file);
  gzip.pipe(out);
  const done = once(out, "close");
  const failed = new Promise<never>((_, reject) => {
    gzip.on("error", reject);
    out.on("error", reject);
  });
  failed.catch(() => {}); // surfaced through Promise.race below

  const write = async (line: string) => {
    if (!gzip.write(`${line}\n`)) await Promise.race([once(gzip, "drain"), failed]);
  };

  const counts: Record<string, number> = {};
  let docs = 0;
  const run = (async () => {
    await write(JSON.stringify({ backup: { version: FORMAT_VERSION, db: db.databaseName, at: now.toISOString() } }));
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();
    for (const name of names) {
      counts[name] = 0;
      for await (const doc of db.collection(name).find({})) {
        await write(EJSON.stringify({ c: name, d: doc }, { relaxed: false }));
        counts[name]!++;
        docs++;
      }
    }
    await write(JSON.stringify({ end: { counts } }));
    gzip.end();
    await done;
  })();
  await Promise.race([run, failed]);
  return { db: db.databaseName, at: now.toISOString(), counts, docs };
}

export type BackupEntry = { c: string; d: Record<string, unknown> };

/** Reads a backup file; throws if its header or its closing line is missing. */
export async function* readBackup(file: string): AsyncGenerator<BackupEntry, BackupSummary> {
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let header: { db: string; at: string } | null = null;
  const seen: Record<string, number> = {};
  let docs = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    // The first and last lines are plain JSON written by us; only the documents need Extended JSON
    // (which would turn their plain numbers into BSON wrappers).
    const plain = line.startsWith('{"backup"') || line.startsWith('{"end"');
    const row = (plain ? JSON.parse(line) : EJSON.parse(line, { relaxed: false })) as {
      backup?: { version: number; db: string; at: string };
      c?: string;
      d?: Record<string, unknown>;
      end?: { counts: Record<string, number> };
    };
    if (row.backup) {
      if (row.backup.version !== FORMAT_VERSION) throw new Error(`unknown backup format version ${row.backup.version}`);
      header = row.backup;
    } else if (row.c !== undefined && row.d) {
      if (!header) throw new Error("not a backup file (no header)");
      seen[row.c] = (seen[row.c] ?? 0) + 1;
      docs++;
      yield { c: row.c, d: row.d };
    } else if (row.end) {
      if (!header) throw new Error("not a backup file (no header)");
      const same = Object.keys({ ...row.end.counts, ...seen }).every((k) => (row.end!.counts[k] ?? 0) === (seen[k] ?? 0));
      if (!same) throw new Error("the document counts at the end of the backup don't match what was read — the file is damaged");
      return { db: header.db, at: header.at, counts: seen, docs };
    }
  }
  throw new Error("the backup file ends too early (no closing line) — it was cut short and can't be restored");
}

/**
 * Restores a backup into `target`. By default every collection must be empty (or missing);
 * `drop` replaces them. The caller decides which database is allowed (see the restore script).
 */
export async function restoreBackup(file: string, target: mongoose.mongo.Db, options: { drop?: boolean } = {}): Promise<BackupSummary> {
  // First pass: validate the whole file before anything is written.
  const reader = readBackup(file);
  for (let r = await reader.next(); !r.done; r = await reader.next());

  const batches = new Map<string, Record<string, unknown>[]>();
  const prepared = new Set<string>();
  const flush = async (name: string) => {
    const batch = batches.get(name);
    if (batch?.length) await target.collection(name).insertMany(batch, { ordered: true });
    batches.set(name, []);
  };

  const existing = new Set((await target.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const reader2 = readBackup(file);
  let summary: BackupSummary | undefined;
  for (let r = await reader2.next(); ; r = await reader2.next()) {
    if (r.done) {
      summary = r.value;
      break;
    }
    const { c, d } = r.value;
    if (!prepared.has(c)) {
      prepared.add(c);
      if (existing.has(c)) {
        if (options.drop) await target.collection(c).drop();
        else if ((await target.collection(c).estimatedDocumentCount()) > 0 || (await target.collection(c).findOne({}))) {
          throw new Error(`collection "${c}" in "${target.databaseName}" already has documents — restore into an empty database, or pass --drop`);
        }
      }
    }
    const batch = batches.get(c) ?? [];
    batch.push(d);
    batches.set(c, batch);
    if (batch.length >= RESTORE_BATCH) await flush(c);
  }
  for (const name of batches.keys()) await flush(name);
  return summary!;
}

/** `clipcut-<db>-2026-10-06-1530.ejson.gz` — sorts by time as text. */
export function backupFileName(db: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}`;
  return `clipcut-${db}-${stamp}.ejson.gz`;
}

/** Of these backup names (any order), the ones beyond the newest `keep` — to delete. */
export function backupsToDelete(names: readonly string[], keep: number): string[] {
  return [...names].sort().reverse().slice(Math.max(0, keep));
}
