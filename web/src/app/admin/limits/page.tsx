import type { Metadata } from "next";

import { saveLimitsAction } from "@/app/admin/settings/actions";
import { LimitsForm } from "@/components/admin/limits-form";
import { PageHeader } from "@/components/admin/ui";
import { usersPerPlan } from "@/lib/admin/settings-service";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { formatUtc } from "@/lib/format";
import { getSettingsSnapshot } from "@/shared";

export const metadata: Metadata = { title: "Limits & plans · Admin" };

/** Limits per plan (docs/ADMIN.md — Limits and plans). A user's own override still wins. */
export default async function AdminLimitsPage() {
  await requireAdminPage();
  const [snapshot, userCounts] = await Promise.all([getSettingsSnapshot("limits", { fresh: true }), usersPerPlan()]);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Limits & plans"
        note={
          snapshot.version === 0
            ? "Running on defaults — nothing saved yet."
            : `Version ${snapshot.version} · saved ${formatUtc(snapshot.updatedAt)} by ${snapshot.updatedByEmail ?? "?"}${snapshot.invalid ? " · stored value was invalid, defaults in use" : ""}`
        }
      />
      <LimitsForm initial={snapshot.value} version={snapshot.version} userCounts={userCounts} save={saveLimitsAction} />
    </div>
  );
}
