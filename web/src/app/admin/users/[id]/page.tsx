import { BanIcon, CircleCheckIcon, RotateCcwIcon, ShieldCheckIcon, ShieldOffIcon, Trash2Icon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  deleteUserDataAction,
  resetUsageAction,
  setLimitsAction,
  setPlanAction,
  setRoleAction,
  suspendAction,
  unsuspendAction,
} from "@/app/admin/users/actions";
import { ActionButton } from "@/components/admin/action-button";
import { Empty, Facts, PageHeader, Panel, Tag } from "@/components/admin/ui";
import { LimitsForm, PlanForm } from "@/components/admin/user-forms";
import { StatusBadge } from "@/components/app/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getUserForAdmin } from "@/lib/admin/users-service";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { env } from "@/lib/env";
import { formatDuration, formatUtc, fromNow } from "@/lib/format";
import { ROUTES } from "@/lib/routes";

export const metadata: Metadata = { title: "User · Admin" };

/** One account: profile, limits, this month's usage, videos, charges, admin history, actions. */
export default async function AdminUserPage({ params }: PageProps<"/admin/users/[id]">) {
  const admin = await requireAdminPage();
  const { id } = await params;
  const data = await getUserForAdmin(id);
  if (!data) notFound();
  const { user, plans, planLimits, effective, minutesUsed, periodStart, periodEnd, videos, videoCount, usage, audit } = data;

  const self = user._id.equals(admin._id);
  const owner = env.ADMIN_EMAILS.includes(user.email.toLowerCase());
  const deleted = !!user.deletedAt;
  const locked = self ? "This is your own account." : owner ? "Owner listed in ADMIN_EMAILS — protected." : null;

  return (
    <div className="flex max-w-7xl flex-col gap-6">
      <PageHeader
        back={{ href: ROUTES.adminUsers, label: "Users" }}
        title={user.email}
        note={
          <span className="flex flex-wrap items-center gap-2">
            {user.name && <span>{user.name}</span>}
            {user.role === "admin" && <Tag tone="info">Admin</Tag>}
            {owner && <Tag tone="info">Owner</Tag>}
            {deleted ? <Tag tone="danger">Deleted</Tag> : user.status === "suspended" ? <Tag tone="danger">Suspended</Tag> : <Tag>Active</Tag>}
            {locked && <span className="text-xs">{locked}</span>}
          </span>
        }
        actions={
          deleted ? undefined : (
            <>
              <ActionButton
                label="Reset this month's usage"
                icon={<RotateCcwIcon />}
                action={resetUsageAction.bind(null, id)}
                success="Usage reset to 0."
                confirm={{ title: "Reset this month's usage?", description: `Minutes used goes from ${minutesUsed} back to 0. The billing period keeps its dates.`, confirmLabel: "Reset usage" }}
              />
              {!self &&
                (user.role === "admin" ? (
                  !owner && (
                    <ActionButton
                      label="Remove admin"
                      icon={<ShieldOffIcon />}
                      action={setRoleAction.bind(null, id, "user")}
                      success="Admin access removed."
                      confirm={{ title: "Remove admin access?", description: "They lose access to /admin at once.", confirmLabel: "Remove admin", destructive: true }}
                    />
                  )
                ) : (
                  <ActionButton
                    label="Make admin"
                    icon={<ShieldCheckIcon />}
                    action={setRoleAction.bind(null, id, "admin")}
                    success="Admin access granted."
                    confirm={{
                      title: "Give this user admin access?",
                      description: "They can see every user and video and change settings. Only do this for people you trust.",
                      confirmLabel: "Make admin",
                    }}
                  />
                ))}
              {!locked &&
                (user.status === "suspended" ? (
                  <ActionButton label="Unsuspend" icon={<CircleCheckIcon />} action={unsuspendAction.bind(null, id)} success="Account active again." />
                ) : (
                  <ActionButton
                    label="Suspend"
                    icon={<BanIcon />}
                    variant="destructive"
                    action={suspendAction.bind(null, id)}
                    success="Account suspended."
                    confirm={{
                      title: "Suspend this account?",
                      description: "They're blocked at once and see the reason you give. Their videos are kept.",
                      confirmLabel: "Suspend",
                      destructive: true,
                      input: { label: "Reason (shown to the user)", placeholder: "e.g. Uploading content you don't own" },
                    }}
                  />
                ))}
            </>
          )
        }
      />

      <Panel title="Account">
        <Facts
          items={[
            ["Plan", user.plan],
            ["This month", `${minutesUsed} of ${effective.monthlyMinutes} min`],
            ["Period", periodStart && periodEnd ? `${formatUtc(periodStart)} → ${formatUtc(periodEnd)}` : "—"],
            ["Videos", String(videoCount)],
            ["Joined", formatUtc(user.createdAt)],
            ["Last seen", user.lastSeenAt ? fromNow(user.lastSeenAt) : "—"],
            ["Effective limits", `${effective.maxFileMB} MB · ${effective.maxDurationMin} min videos · ${effective.concurrentJobs} at once · ${effective.maxClipsPerVideo} clips · ${effective.clipRequestsPerVideo} new-clip searches · ${effective.copyRequestsPerVideo} rewrites · YouTube ${effective.allowYoutube ? "on" : "off"}`],
            ["Suspension", user.suspension ? `${user.suspension.reason} (${formatUtc(user.suspension.at)})` : "—"],
            ["Clerk id", <span key="c" className="font-mono text-xs">{user.clerkId}</span>],
          ]}
        />
      </Panel>

      {!deleted && (
        <div className="grid gap-6 xl:grid-cols-[1fr_2fr]">
          <Panel title="Plan">
            <PlanForm action={setPlanAction.bind(null, id)} plans={plans} current={user.plan} />
          </Panel>
          <Panel title="Limit override" aside={user.limitsOverride ? "Override active" : "Using plan limits"}>
            <LimitsForm
              action={setLimitsAction.bind(null, id)}
              override={(user.limitsOverride ?? {}) as Record<string, number | boolean | null>}
              planLimits={planLimits as Record<string, number | boolean> | null}
            />
          </Panel>
        </div>
      )}

      <Panel title="Videos" aside={<Link href={`${ROUTES.adminVideos}?user=${id}&deleted=all`} className="hover:text-foreground">All videos →</Link>}>
        {videos.length === 0 ? (
          <Empty>No videos.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4.5">Video</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Length</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {videos.map((v) => (
                <TableRow key={String(v._id)}>
                  <TableCell className="max-w-96 px-4.5">
                    <Link href={`${ROUTES.adminVideos}/${String(v._id)}`} lang={v.language} className="line-clamp-1 hover:underline">
                      {v.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={v.status} />
                      {v.deletedAt && <Tag tone="danger">Deleted</Tag>}
                      {v.error?.code && <span className="font-mono text-xs text-subtle">{v.error.code}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{formatDuration(v.media?.durationMs)}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">{formatUtc(v.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Charges">
          {usage.length === 0 ? (
            <Empty>Nothing charged yet.</Empty>
          ) : (
            <ul className="divide-y text-sm">
              {usage.map((u) => (
                <li key={String(u._id)} className="flex justify-between gap-3 px-4.5 py-2.5">
                  <span>
                    {u.quantity} {u.unit} · {u.type}
                    {u.videoId && (
                      <Link href={`${ROUTES.adminVideos}/${String(u.videoId)}`} className="ml-2 text-subtle hover:text-foreground">
                        video →
                      </Link>
                    )}
                  </span>
                  <span className="font-mono text-xs text-subtle">{formatUtc(u.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Admin history">
          {audit.length === 0 ? (
            <Empty>No admin actions on this account.</Empty>
          ) : (
            <ul className="divide-y text-sm">
              {audit.map((a) => (
                <li key={String(a._id)} className="flex justify-between gap-3 px-4.5 py-2.5">
                  <span>
                    <span className="font-mono">{a.action}</span> <span className="text-subtle">by {a.actorEmail}</span>
                  </span>
                  <span className="font-mono text-xs text-subtle">{formatUtc(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {!deleted && !locked && (
        <Panel title="Danger zone" className="border-destructive/40">
          <div className="flex flex-wrap items-center justify-between gap-4 px-4.5 py-4">
            <p className="max-w-2xl text-sm text-muted-foreground">
              Delete everything this user made — videos, files, transcripts, clips — and their sign-in. The account is blocked at once. Only the
              billing ledger and this audit trail are kept. This can&apos;t be undone.
            </p>
            <ActionButton
              label="Delete user data"
              icon={<Trash2Icon />}
              variant="destructive"
              action={deleteUserDataAction.bind(null, id)}
              success="User data deleted."
              confirm={{
                title: "Delete all of this user's data?",
                description: "Videos, Cloudinary files, transcripts, clips and the Clerk sign-in are removed. This can't be undone.",
                confirmLabel: "Delete everything",
                destructive: true,
                input: { label: `Type ${user.email} to confirm`, mustEqual: user.email },
              }}
            />
          </div>
        </Panel>
      )}
    </div>
  );
}
