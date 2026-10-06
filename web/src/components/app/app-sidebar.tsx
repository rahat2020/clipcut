"use client";

import { UserButton } from "@clerk/nextjs";
import { FilmIcon, HouseIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, ShieldCheckIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactElement } from "react";

import { Logo, LogoMark } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BRAND_NAME } from "@/lib/brand";
import { ROUTES } from "@/lib/routes";
import { SIDEBAR_COOKIE } from "@/lib/ui-prefs";
import { cn } from "@/lib/utils";

export type SidebarProps = {
  isAdmin: boolean;
  user: { name: string | null; email: string };
  /** `resetsOn`: "Oct 29", or null before the first video (nothing to reset yet). */
  usage: { minutesUsed: number; monthlyMinutes: number; plan: string; resetsOn: string | null };
  /** From the SIDEBAR_COOKIE cookie, so the server already renders the user's choice (no flash). */
  initialCollapsed: boolean;
};

type NavItem = { href: string; label: string; icon: LucideIcon };

/** Only pages that exist are listed; add an item when its page ships. */
function navItems(isAdmin: boolean): NavItem[] {
  const items: NavItem[] = [
    { href: ROUTES.dashboard, label: "Home", icon: HouseIcon },
    { href: ROUTES.videos, label: "My videos", icon: FilmIcon },
  ];
  if (isAdmin) items.push({ href: ROUTES.admin, label: "Admin", icon: ShieldCheckIcon });
  return items;
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

const BAR = { primary: "bg-primary", warning: "bg-warning", destructive: "bg-destructive" } as const;
const RING = { primary: "stroke-primary", warning: "stroke-warning", destructive: "stroke-destructive" } as const;

/** Desktop sidebar (lg and up): full, or a narrow icon rail — the user's choice, kept in a cookie. */
export function AppSidebar({ isAdmin, user, usage, initialCollapsed }: SidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const pct = usage.monthlyMinutes > 0 ? Math.min(100, (usage.minutesUsed / usage.monthlyMinutes) * 100) : 100;
  const tone = pct >= 85 ? "destructive" : pct >= 60 ? "warning" : "primary";
  const outOfMinutes = usage.minutesUsed >= usage.monthlyMinutes;
  const usageText = `${usage.minutesUsed} / ${usage.monthlyMinutes} min this month${usage.resetsOn ? ` · resets ${usage.resetsOn}` : ""}`;

  const toggle = useCallback(() => {
    setCollapsed((was) => {
      const next = !was;
      document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);

  // Ctrl/Cmd + B toggles it, unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-r bg-sidebar py-5 transition-[width] duration-200 lg:flex",
        collapsed ? "w-17 items-center gap-5 px-2.5" : "w-62 gap-6 px-4",
      )}
    >
      <div className={cn("flex items-center", collapsed ? "flex-col gap-3" : "justify-between gap-2")}>
        {collapsed ? (
          <Link href={ROUTES.dashboard} aria-label={`${BRAND_NAME} home`}>
            <LogoMark />
          </Link>
        ) : (
          <Logo href={ROUTES.dashboard} className="px-2 py-1" />
        )}
        <Hint label={collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"} show>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            className="flex size-9 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-raised hover:text-foreground"
          >
            {collapsed ? <PanelLeftOpenIcon className="size-4.5" strokeWidth={1.8} /> : <PanelLeftCloseIcon className="size-4.5" strokeWidth={1.8} />}
          </button>
        </Hint>
      </div>

      <Hint label="New video" show={collapsed}>
        <Link
          href={`${ROUTES.dashboard}#new-video`}
          aria-label={collapsed ? "New video" : undefined}
          className={cn(buttonVariants({ size: "lg" }), collapsed ? "size-11 p-0" : "h-11 w-full text-[15px]")}
        >
          <PlusIcon />
          {!collapsed && "New video"}
        </Link>
      </Hint>

      <nav aria-label="Main" className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
        {navItems(isAdmin).map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Hint key={href} label={label} show={collapsed}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                aria-label={collapsed ? label : undefined}
                className={cn(
                  "flex h-10 items-center rounded-lg text-[15px] transition-colors",
                  collapsed ? "w-10 justify-center" : "gap-3 px-3",
                  active ? "bg-raised text-foreground" : "text-muted-foreground hover:bg-raised/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4.5" strokeWidth={1.8} />
                {!collapsed && label}
              </Link>
            </Hint>
          );
        })}
      </nav>

      <div className="flex-1" />

      {collapsed ? (
        <Hint label={usageText} show>
          <span role="img" aria-label={usageText} className="flex">
            <UsageRing pct={pct} tone={tone} />
          </span>
        </Hint>
      ) : (
        <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
          <div className="flex justify-between text-[13px]">
            <span className="text-muted-foreground">This month</span>
            <span className="font-mono">
              {usage.minutesUsed} / {usage.monthlyMinutes} min
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Minutes used this month"
            aria-valuemin={0}
            aria-valuemax={usage.monthlyMinutes}
            aria-valuenow={usage.minutesUsed}
            className="h-1.5 overflow-hidden rounded-full bg-border"
          >
            <div className={cn("h-full rounded-full", BAR[tone])} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex justify-between gap-2 text-xs text-subtle">
            <span className="capitalize">{usage.plan} plan</span>
            {usage.resetsOn && <span>Resets {usage.resetsOn}</span>}
          </div>
          {outOfMinutes && <span className="text-xs text-destructive">No minutes left this month</span>}
        </div>
      )}

      <div className={cn("flex items-center gap-3", collapsed ? "justify-center" : "px-1")}>
        <UserButton />
        {!collapsed && (
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{user.name ?? "Your account"}</span>
            <span className="truncate text-xs text-subtle">{user.email}</span>
          </div>
        )}
      </div>
    </aside>
  );
}

/** Minutes used as a ring, for the collapsed rail. */
function UsageRing({ pct, tone }: { pct: number; tone: keyof typeof RING }) {
  const c = 2 * Math.PI * 15;
  return (
    <svg viewBox="0 0 36 36" className="size-9 -rotate-90" aria-hidden="true">
      <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" className="stroke-border" />
      <circle
        cx="18"
        cy="18"
        r="15"
        fill="none"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * c} ${c}`}
        className={RING[tone]}
      />
    </svg>
  );
}

/** A tooltip on the right when `show` (the collapsed rail has no visible labels); otherwise just the child. */
function Hint({ label, show, children }: { label: string; show: boolean; children: ReactElement }) {
  if (!show) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Compact top bar for phones and tablets, where the sidebar is hidden. */
export function MobileHeader({ isAdmin }: { isAdmin: boolean }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur lg:hidden">
      <Link href={ROUTES.dashboard} aria-label={`${BRAND_NAME} home`}>
        <LogoMark />
      </Link>
      <div className="flex-1" />
      {isAdmin && (
        <Link href={ROUTES.admin} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          Admin
        </Link>
      )}
      <Link href={`${ROUTES.dashboard}#new-video`} className={buttonVariants({ size: "sm" })}>
        <PlusIcon />
        New video
      </Link>
      <UserButton />
    </header>
  );
}
