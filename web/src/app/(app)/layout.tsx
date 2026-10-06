import { cookies } from "next/headers";

import { AppSidebar, MobileHeader } from "@/components/app/app-sidebar";
import { requireUserPage } from "@/lib/auth/page-guards";
import { formatDay } from "@/lib/format";
import { SIDEBAR_COOKIE } from "@/lib/ui-prefs";
import { effectivePlanLimits, getSettings, minutesUsedThisPeriod, quotaResetsAt } from "@/shared";

/**
 * Shell for signed-in app pages: sidebar on desktop (full or collapsed, the user's choice),
 * top bar on phones. Pages inside still call requireUserPage() themselves (a layout doesn't
 * re-run on client navigation); both calls share one cached lookup per request.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUserPage();
  const limits = effectivePlanLimits(user, await getSettings("limits"));
  const isAdmin = user.role === "admin";
  const resetsAt = quotaResetsAt(user);
  const sidebarCollapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";

  return (
    <div className="flex min-h-dvh">
      <AppSidebar
        initialCollapsed={sidebarCollapsed}
        isAdmin={isAdmin}
        user={{ name: user.name ?? null, email: user.email }}
        usage={{
          minutesUsed: minutesUsedThisPeriod(user),
          monthlyMinutes: limits.monthlyMinutes,
          plan: user.plan,
          resetsOn: resetsAt ? formatDay(resetsAt) : null,
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileHeader isAdmin={isAdmin} />
        {children}
      </div>
    </div>
  );
}
