import type { Metadata } from "next";
import Link from "next/link";

import { Empty, NativeSelect, PageHeader, Pagination, Panel, Tag } from "@/components/admin/ui";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ADMIN_PAGE_SIZE, listVideosForAdmin, videoListQuerySchema } from "@/lib/admin/videos-service";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { formatDuration, formatUtc } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { STATUS_DISPLAY } from "@/lib/video-labels";
import { LANGUAGES, SOURCE_TYPES, VIDEO_STATUSES, type VideoStatus } from "@/shared";

export const metadata: Metadata = { title: "Videos & jobs · Admin" };

/** Every user's videos, newest first, with filters in the URL (so a view can be shared). */
export default async function AdminVideosPage({ searchParams }: PageProps<"/admin/videos">) {
  await requireAdminPage();
  const raw = await searchParams;
  const query = videoListQuerySchema.parse(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])));
  const { rows, total } = await listVideosForAdmin(query);
  const params = { status: query.status, source: query.source, language: query.language, q: query.q, user: query.user, deleted: query.deleted === "hide" ? undefined : query.deleted };

  return (
    <div className="flex max-w-7xl flex-col gap-6">
      <PageHeader title="Videos & jobs" note="Every user's videos. Open one to see its pipeline, transcript, clip runs and actions." />

      <form className="flex flex-wrap items-end gap-2.5" action={ROUTES.adminVideos}>
        <Input name="q" defaultValue={query.q} placeholder="Title or owner email" className="w-64" />
        <NativeSelect name="status" defaultValue={query.status ?? ""} aria-label="Status">
          <option value="">Any status</option>
          {VIDEO_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_DISPLAY[s].label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="source" defaultValue={query.source ?? ""} aria-label="Source">
          <option value="">Any source</option>
          {SOURCE_TYPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="language" defaultValue={query.language ?? ""} aria-label="Language">
          <option value="">Any language</option>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l === "bn" ? "Bangla" : "English"}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="deleted" defaultValue={query.deleted} aria-label="Deleted videos">
          <option value="hide">Hide deleted</option>
          <option value="only">Deleted only</option>
          <option value="all">Include deleted</option>
        </NativeSelect>
        {query.user && <input type="hidden" name="user" value={query.user} />}
        <Button type="submit" size="sm">
          Apply
        </Button>
        <Link href={ROUTES.adminVideos} className="px-2 text-sm text-subtle hover:text-foreground">
          Clear
        </Link>
      </form>

      <Panel title="Videos" aside={query.user ? "Filtered to one user" : undefined}>
        {rows.length === 0 ? (
          <Empty>No videos match these filters.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4.5">Video</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Stopped at</TableHead>
                <TableHead>Length</TableHead>
                <TableHead>Clips</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="max-w-80 px-4.5">
                    <Link href={`${ROUTES.adminVideos}/${v.id}`} lang={v.language} className="line-clamp-1 font-medium hover:underline">
                      {v.title}
                    </Link>
                    <span className="text-xs text-subtle">
                      {v.sourceType} · {v.language === "bn" ? "Bangla" : "English"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      <StatusBadge status={v.status as VideoStatus} />
                      {v.deletedAt && <Tag tone="danger">Deleted</Tag>}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {v.errorCode ? `${v.errorStage ?? "?"} · ${v.errorCode}` : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">{formatDuration(v.durationMs)}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">{v.clips}</TableCell>
                  <TableCell className="max-w-56 truncate text-muted-foreground">
                    {v.user ? (
                      <Link href={`${ROUTES.adminUsers}/${v.user.id}`} className="hover:underline">
                        {v.user.email}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">{formatUtc(v.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination basePath={ROUTES.adminVideos} params={params} page={query.page} pageSize={ADMIN_PAGE_SIZE} total={total} />
      </Panel>
    </div>
  );
}
