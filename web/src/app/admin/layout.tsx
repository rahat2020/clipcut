import { UserButton } from "@clerk/nextjs";
import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AdminNav } from "@/components/admin/admin-nav";
import { LogoMark } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

/**
 * Every /admin page renders inside this layout, which 404s for non-admins. Pages and
 * server actions under /admin must STILL call requireAdmin()/requireAdminPage() themselves:
 * a layout doesn't re-run on client navigation, and server actions skip it entirely.
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const admin = await requireAdminPage();
  const env = process.env.NODE_ENV === "production" ? "prod" : "dev";

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-58 shrink-0 flex-col gap-5 border-r bg-sidebar px-3.5 py-5 lg:flex">
        <div className="flex items-center justify-between px-2 py-1">
          <Link href={ROUTES.admin} className="flex items-center gap-2.5">
            <LogoMark className="size-6.5 rounded-[7px]" />
            <span className="font-heading text-base font-bold">Admin</span>
          </Link>
          <span className="rounded-md bg-warning/15 px-2 py-0.5 font-mono text-[11px] text-warning">{env}</span>
        </div>

        <AdminNav variant="sidebar" />

        <div className="flex-1" />
        <Link href={ROUTES.dashboard} className={cn(buttonVariants({ variant: "outline" }), "justify-start text-muted-foreground")}>
          <ChevronLeftIcon />
          Back to app
        </Link>
        <div className="flex items-center gap-3 px-1">
          <UserButton />
          <span className="truncate text-xs text-subtle">{admin.email}</span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b px-4 lg:hidden">
          <Link href={ROUTES.admin} className="flex items-center gap-2.5">
            <LogoMark className="size-6.5 rounded-[7px]" />
            <span className="font-heading font-bold">Admin</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link href={ROUTES.dashboard} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Back to app
            </Link>
            <UserButton />
          </div>
        </header>
        <AdminNav variant="bar" />
        <main className="min-w-0 flex-1 px-4 py-7 sm:px-9">{children}</main>
      </div>
    </div>
  );
}
