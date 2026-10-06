"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** Sections from docs/ADMIN.md §2. `step` = roadmap step that builds a section not built yet. */
const SECTIONS: { label: string; href?: string; step?: number }[] = [
  { label: "Overview", href: ROUTES.admin },
  { label: "Users", href: ROUTES.adminUsers },
  { label: "Videos & jobs", href: ROUTES.adminVideos },
  { label: "AI models", href: ROUTES.adminAi },
  { label: "Accuracy", href: ROUTES.adminAccuracy },
  { label: "Limits & plans", step: 16 },
  { label: "Retention", step: 16 },
  { label: "System", step: 16 },
  { label: "Audit log", step: 16 },
];

function isActive(pathname: string, href: string): boolean {
  return href === ROUTES.admin ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** Sidebar list on large screens; a scrollable row of built sections on small ones. */
export function AdminNav({ variant }: { variant: "sidebar" | "bar" }) {
  const pathname = usePathname();

  if (variant === "bar") {
    return (
      <nav aria-label="Admin sections" className="flex gap-1 overflow-x-auto border-b px-4 py-2 text-sm lg:hidden">
        {SECTIONS.filter((s) => s.href).map((s) => {
          const active = isActive(pathname, s.href!);
          return (
            <Link
              key={s.label}
              href={s.href!}
              aria-current={active ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-lg px-3 py-1.5 whitespace-nowrap",
                active ? "bg-raised text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label="Admin sections" className="flex flex-col gap-0.5 text-sm">
      {SECTIONS.map((s) => {
        if (!s.href) {
          return (
            <span key={s.label} className="flex h-9.5 items-center justify-between rounded-lg px-3 text-subtle">
              {s.label}
              <span className="font-mono text-[10px]">step {s.step}</span>
            </span>
          );
        }
        const active = isActive(pathname, s.href);
        return (
          <Link
            key={s.label}
            href={s.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-9.5 items-center rounded-lg px-3",
              active ? "bg-raised text-foreground" : "text-muted-foreground hover:bg-raised/60 hover:text-foreground",
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
