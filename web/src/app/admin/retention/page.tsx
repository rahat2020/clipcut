import type { Metadata } from "next";
import Link from "next/link";

import { previewRetentionAction, saveRetentionAction } from "@/app/admin/settings/actions";
import { PageHeader, Panel, Empty, Tag } from "@/components/admin/ui";
import { RetentionForm } from "@/components/admin/retention-form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { expiringSoon } from "@/lib/admin/settings-service";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { formatUtc, fromNow } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { getSettingsSnapshot } from "@/shared";

export const metadata: Metadata = { title: "Retention · Admin" };

const SOON_HOURS = 24;
const SHOWN = 25;

/**
 * Retention (docs/ADMIN.md): how long each plan's files are kept, the safety delays, and the
 * videos whose files go in the next 24 hours. Cleanup itself runs in the worker every 30 minutes.
 */
async function load() {
  const now = new Date();
  const [snapshot, limits, soon] = await Promise.all([
    getSettingsSnapshot("retention", { fresh: true }),
    getSettingsSnapshot("limits"),
    expiringSoon(SOON_HOURS, SHOWN, now),
  ]);
  return { snapshot, limits, soon: { total: soon.total, rows: soon.rows.map((v) => ({ ...v, due: v.expiresAt.getTime() <= now.getTime() })) } };
}

export default async function AdminRetentionPage() {
  await requireAdminPage();
  const { snapshot, limits, soon } = await load();

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Retention"
        note={
          snapshot.version === 0
            ? "Running on defaults — nothing saved yet."
            : `Version ${snapshot.version} · saved ${formatUtc(snapshot.updatedAt)} by ${snapshot.updatedByEmail ?? "?"}${snapshot.invalid ? " · stored value was invalid, defaults in use" : ""}`
        }
      />
      <RetentionForm
        initial={snapshot.value}
        version={snapshot.version}
        plans={Object.keys(limits.value.plans)}
        preview={previewRetentionAction}
        save={saveRetentionAction}
      />

      <Panel title={`Files deleted in the next ${SOON_HOURS} hours`} aside={`${soon.total} video${soon.total === 1 ? "" : "s"}`}>
        {soon.rows.length === 0 ? (
          <Empty>Nothing is due. To keep one video longer, open it from Videos &amp; jobs and set “Keep files longer”.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4.5">Video</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Files go</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {soon.rows.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="max-w-80 px-4.5">
                    <Link href={`${ROUTES.adminVideos}/${v.id}`} lang={v.language} className="block truncate hover:underline">
                      {v.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{v.owner}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {v.due ? <Tag tone="warning">Due now · next cleanup run</Tag> : <span className="text-muted-foreground">{fromNow(v.expiresAt)}</span>}
                    {v.overridden && <span className="ml-2 text-xs text-subtle">custom date</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {soon.total > soon.rows.length && <p className="border-t px-4.5 py-3 text-xs text-subtle">Showing the first {soon.rows.length} of {soon.total}.</p>}
      </Panel>
    </div>
  );
}
