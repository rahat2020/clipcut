#!/usr/bin/env node
/**
 * Copies shared/src into web/src/shared and worker/src/shared.
 *
 *   node scripts/sync-shared.mjs          write copies (only files that changed)
 *   node scripts/sync-shared.mjs --check  exit 1 if any copy differs from shared/src
 *
 * Why copy instead of an npm link: a linked package resolves `mongoose` from its own
 * folder, so an app can end up with two Mongoose instances and queries hang silently.
 * Copied files resolve `mongoose` from the app that imports them (docs/SCHEMA.md §9).
 *
 * The copies are committed, so web/ and worker/ each build on their own.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "shared", "src");
const TARGETS = [path.join(ROOT, "web", "src", "shared"), path.join(ROOT, "worker", "src", "shared")];
const CHECK = process.argv.includes("--check");

const header = (rel) =>
  `// GENERATED — do not edit. Source: shared/src/${rel}\n` +
  `// Edit the source, then run: node scripts/sync-shared.mjs\n\n`;

/** Relative paths (forward slashes) of every .ts file under dir. */
async function listTs(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTs(full, base)));
    else if (entry.name.endsWith(".ts")) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

const normalizeEol = (s) => s.replace(/\r\n/g, "\n");

async function removeEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name));
  }
  if ((await readdir(dir)).length === 0 && !TARGETS.includes(dir)) await rmdir(dir);
}

async function main() {
  const sources = await listTs(SOURCE);
  if (sources.length === 0) throw new Error(`no .ts files found in ${SOURCE}`);

  const expected = new Map();
  for (const rel of sources) {
    expected.set(rel, header(rel) + normalizeEol(await readFile(path.join(SOURCE, rel), "utf8")));
  }

  const problems = [];
  let written = 0;
  let removed = 0;

  for (const target of TARGETS) {
    const label = path.relative(ROOT, target).split(path.sep).join("/");

    for (const [rel, content] of expected) {
      const dest = path.join(target, ...rel.split("/"));
      const current = existsSync(dest) ? normalizeEol(await readFile(dest, "utf8")) : null;
      if (current === content) continue;
      if (CHECK) {
        problems.push(`${label}/${rel}: ${current === null ? "missing" : "differs from shared/src (edited by hand?)"}`);
        continue;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content, "utf8");
      written++;
    }

    for (const rel of await listTs(target)) {
      if (expected.has(rel)) continue;
      if (CHECK) {
        problems.push(`${label}/${rel}: not in shared/src (stale copy)`);
        continue;
      }
      await rm(path.join(target, ...rel.split("/")));
      removed++;
    }
    if (!CHECK) await removeEmptyDirs(target);
  }

  if (CHECK) {
    if (problems.length > 0) {
      console.error(`✗ shared copies are out of sync:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
      console.error(`\nFix: edit shared/src only, then run  node scripts/sync-shared.mjs`);
      process.exit(1);
    }
    console.log(`✓ shared copies in sync (${sources.length} files × ${TARGETS.length} targets)`);
    return;
  }

  const summary = written || removed ? `${written} written, ${removed} removed` : "already up to date";
  console.log(`✓ shared synced → web, worker (${sources.length} files; ${summary})`);
}

main().catch((err) => {
  console.error(`sync-shared failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
