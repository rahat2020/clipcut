import type { Metadata } from "next";
import Link from "next/link";

import { Empty, NativeSelect, PageHeader, Pagination, Panel } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { auditListQuerySchema, listAudit, type AuditRow } from "@/lib/admin/audit-service";
import { ADMIN_PAGE_SIZE } from "@/lib/admin/videos-service";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { formatUtc } from "@/lib/format";
import { ROUTES } from "@/lib/routes";

export const metadata: Metadata = { title: "Audit log · Admin" };

/** Where a record's own admin page is, when it has one. */
function targetHref(t: AuditRow["target"]): string | null {
  if (t.type === "video") return `${ROUTES.adminVideos}/${t.id}`;
  if (t.type === "user") return `${ROUTES.adminUsers}/${t.id}`;
  if (t.type === "settings") return { ai: ROUTES.adminAi, limits: ROUTES.adminLimits, retention: ROUTES.adminRetention, system: ROUTES.adminSystem }[t.id] ?? null;
  return null;
}

/** Every admin action — who, what, on which record and what changed (docs/ADMIN.md). Entries are kept one year. */
export default async function AdminAuditPage({ searchParams }: PageProps<"/admin/audit">) {
  await requireAdminPage();
  const raw = await searchParams;
  const query = auditListQuerySchema.parse(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])));
  const { rows, total, actions, targets } = await listAudit(query);
  const params = { who: query.who, action: query.action, target: query.target, id: query.id };

  return (
    <div className="flex max-w-7xl flex-col gap-6">
      <PageHeader title="Audit log" note="Every change an admin makes is recorded here for a year. Open “Show change” to see the values before and after." />

      <form className="flex flex-wrap items-end gap-2.5" action={ROUTES.adminAudit}>
        <Input name="who" defaultValue={query.who} placeholder="Admin email" className="w-56" />
        <NativeSelect name="action" defaultValue={query.action ?? ""} aria-label="Action">
          <option value="">Any action</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="target" defaultValue={query.target ?? ""} aria-label="Record type">
          <option value="">Any record</option>
          {targets.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </NativeSelect>
        <Input name="id" defaultValue={query.id} placeholder="Record id" className="w-60 font-mono" />
        <Button type="submit" size="sm">
          Apply
        </Button>
        <Link href={ROUTES.adminAudit} className="px-2 text-sm text-subtle hover:text-foreground">
          Clear
        </Link>
      </form>

      <Panel title="Actions" aside={`${total.toLocaleString("en-US")} entr${total === 1 ? "y" : "ies"}`}>
        {rows.length === 0 ? (
          <Empty>Nothing matches these filters.</Empty>
        ) : (
          <ul className="flex flex-col divide-y">
            {rows.map((a) => {
              const href = targetHref(a.target);
              return (
                <li key={a.id} className="flex flex-col gap-1.5 px-4.5 py-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">{formatUtc(a.at)}</span>
                    <span className="font-mono font-medium">{a.action}</span>
                    <span className="text-muted-foreground">{a.who}</span>
                    <span className="font-mono text-xs text-subtle">
                      {href ? (
                        <Link href={href} className="hover:text-foreground hover:underline">
                          {a.target.type}:{a.target.id}
                        </Link>
                      ) : (
                        `${a.target.type}:${a.target.id}`
                      )}
                    </span>
                    {a.ip && <span className="font-mono text-xs text-subtle">{a.ip}</span>}
                  </div>
                  {a.diff && (
                    <details className="text-xs">
                      <summary className="w-fit cursor-pointer text-subtle hover:text-foreground">Show change</summary>
                      <pre className="mt-2 max-h-80 overflow-auto rounded-lg border bg-background p-3 font-mono leading-relaxed whitespace-pre-wrap">{a.diff}</pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Pagination basePath={ROUTES.adminAudit} params={params} page={query.page} pageSize={ADMIN_PAGE_SIZE} total={total} />
      </Panel>
    </div>
  );
}
