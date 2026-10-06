import type { Metadata } from "next";
import Link from "next/link";

import { Empty, NativeSelect, PageHeader, Pagination, Panel, Tag } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listUsersForAdmin, userListQuerySchema } from "@/lib/admin/users-service";
import { ADMIN_PAGE_SIZE } from "@/lib/admin/videos-service";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { formatUtc, fromNow } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { getSettings } from "@/shared";

export const metadata: Metadata = { title: "Users · Admin" };

/** All accounts with this month's usage; filters live in the URL. */
export default async function AdminUsersPage({ searchParams }: PageProps<"/admin/users">) {
  await requireAdminPage();
  const raw = await searchParams;
  const query = userListQuerySchema.parse(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])));
  const [{ rows, total }, limits] = await Promise.all([listUsersForAdmin(query), getSettings("limits")]);
  const params = { q: query.q, plan: query.plan, status: query.status, role: query.role, sort: query.sort === "newest" ? undefined : query.sort };

  return (
    <div className="flex max-w-7xl flex-col gap-6">
      <PageHeader title="Users" note="Open a user to change their plan or limits, reset usage, suspend, or manage admin access." />

      <form className="flex flex-wrap items-end gap-2.5" action={ROUTES.adminUsers}>
        <Input name="q" defaultValue={query.q} placeholder="Email or name" className="w-64" />
        <NativeSelect name="plan" defaultValue={query.plan ?? ""} aria-label="Plan">
          <option value="">Any plan</option>
          {Object.keys(limits.plans).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="status" defaultValue={query.status ?? ""} aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </NativeSelect>
        <NativeSelect name="role" defaultValue={query.role ?? ""} aria-label="Role">
          <option value="">Any role</option>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </NativeSelect>
        <NativeSelect name="sort" defaultValue={query.sort} aria-label="Sort">
          <option value="newest">Newest first</option>
          <option value="usage">Most minutes used</option>
          <option value="seen">Recently seen</option>
        </NativeSelect>
        <Button type="submit" size="sm">
          Apply
        </Button>
        <Link href={ROUTES.adminUsers} className="px-2 text-sm text-subtle hover:text-foreground">
          Clear
        </Link>
      </form>

      <Panel title="Accounts">
        {rows.length === 0 ? (
          <Empty>No users match these filters.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4.5">User</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>This month</TableHead>
                <TableHead>Videos</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="max-w-72 px-4.5">
                    <Link href={`${ROUTES.adminUsers}/${u.id}`} className="block truncate font-medium hover:underline">
                      {u.email}
                    </Link>
                    {u.name && <span className="block truncate text-xs text-subtle">{u.name}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{u.plan}</TableCell>
                  <TableCell className="font-mono text-xs">
                    <span className={u.minutesUsed >= u.monthlyMinutes ? "text-destructive" : undefined}>{u.minutesUsed}</span>
                    <span className="text-subtle"> / {u.monthlyMinutes} min</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{u.videos}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      {u.role === "admin" && <Tag tone="info">Admin</Tag>}
                      {u.deleted ? <Tag tone="danger">Deleted</Tag> : u.status === "suspended" ? <Tag tone="danger">Suspended</Tag> : <Tag>Active</Tag>}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">{formatUtc(u.createdAt)}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{u.lastSeenAt ? fromNow(u.lastSeenAt) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination basePath={ROUTES.adminUsers} params={params} page={query.page} pageSize={ADMIN_PAGE_SIZE} total={total} />
      </Panel>
    </div>
  );
}
