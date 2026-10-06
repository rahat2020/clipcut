import type { Metadata } from "next";

import { saveSystemAction } from "@/app/admin/settings/actions";
import { BackupCard, MongoCard } from "@/components/admin/health-cards";
import { PageHeader, Panel, Tag } from "@/components/admin/ui";
import { SystemForm } from "@/components/admin/system-form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { backupHealth, readDatabaseInfo, type DatabaseInfo } from "@/lib/admin/system-info";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { formatBytes, formatUtc } from "@/lib/format";
import { readLastBackup } from "@/lib/redis";
import { getSettingsSnapshot } from "@/shared";

export const metadata: Metadata = { title: "System · Admin" };

async function load() {
  const now = new Date();
  const [snapshot, backup, db] = await Promise.all([
    getSettingsSnapshot("system", { fresh: true }),
    readLastBackup(),
    readDatabaseInfo({ collections: true }).catch((err: unknown) => {
      console.error("[admin] database info unavailable", err);
      return null as DatabaseInfo | null;
    }),
  ]);
  return { snapshot, db, health: backupHealth({ ...backup, enabled: snapshot.value.backupEnabled }, now) };
}

/**
 * System (docs/ADMIN.md): the emergency switches and processing/render tuning, then read-only facts
 * about the database — size, collections, migrations — and the last backup. Migrations are never run
 * from here (`npm run migrate` in worker/).
 */
export default async function AdminSystemPage() {
  await requireAdminPage();
  const { snapshot, db, health } = await load();

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="System"
        note={
          snapshot.version === 0
            ? "Running on defaults — nothing saved yet."
            : `Version ${snapshot.version} · saved ${formatUtc(snapshot.updatedAt)} by ${snapshot.updatedByEmail ?? "?"}${snapshot.invalid ? " · stored value was invalid, defaults in use" : ""}`
        }
      />
      <SystemForm initial={snapshot.value} version={snapshot.version} save={saveSystemAction} />

      <Panel title="Database" aside={db ? db.name : undefined}>
        {db ? (
          <>
            <div className="grid grid-cols-1 gap-px border-b bg-border sm:grid-cols-2">
              <MongoCard usedBytes={db.usedBytes} />
              <BackupCard health={health} />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4.5">Collection</TableHead>
                  <TableHead className="text-right">Documents</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Indexes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {db.collections.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell className="px-4.5 font-mono">{c.name}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{c.docs.toLocaleString("en-US")}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground tabular-nums">{c.bytes === null ? "—" : formatBytes(c.bytes)}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground tabular-nums">{c.indexes}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        ) : (
          <p className="px-4.5 py-6 text-sm text-subtle">Couldn’t read the database facts right now.</p>
        )}
      </Panel>

      {db && (
        <Panel title="Migrations" aside={db.migrations.pending.length === 0 && db.migrations.unknown.length === 0 ? <Tag tone="accent">Up to date</Tag> : <Tag tone="warning">Needs attention</Tag>}>
          <ul className="flex flex-col divide-y text-sm">
            {db.migrations.applied.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4.5 py-2.5">
                <span className="font-mono">{m.id}</span>
                <span className="text-subtle">applied {formatUtc(m.appliedAt)}</span>
              </li>
            ))}
            {db.migrations.pending.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4.5 py-2.5">
                <span className="font-mono text-warning">{m.id}</span>
                <span className="text-subtle">pending — run npm run migrate in worker/</span>
              </li>
            ))}
            {db.migrations.unknown.map((id) => (
              <li key={id} className="px-4.5 py-2.5 text-destructive">
                <span className="font-mono">{id}</span> is in the database but missing from the code.
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <p className="text-sm text-subtle">
        For a rare manual fix, use{" "}
        <a href="https://cloud.mongodb.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
          MongoDB Atlas → Browse collections
        </a>
        . The panel has no raw editor on purpose (docs/ADMIN.md §3).
      </p>
    </div>
  );
}
