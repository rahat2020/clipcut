import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Building blocks shared by the admin pages (same look as the Overview cards). */

export function PageHeader({ title, note, back, actions }: { title: ReactNode; note?: ReactNode; back?: { href: string; label: string }; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {back && (
        <Link href={back.href} className="w-fit text-sm text-subtle hover:text-foreground">
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="min-w-0 font-heading text-3xl font-bold tracking-tight break-words">{title}</h1>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {note && <p className="text-sm text-subtle">{note}</p>}
    </div>
  );
}

export function Panel({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-[14px] border bg-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4.5 py-3.5">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {aside && <div className="text-sm text-subtle">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** Label/value pairs in a responsive grid. */
export function Facts({ items }: { items: [label: string, value: ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4.5 py-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-subtle">{label}</dt>
          <dd className="min-w-0 text-sm break-words">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4.5 py-6 text-sm text-subtle">{children}</p>;
}

/** Native <select> styled like the Input component — for filter forms that work without JS. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 [&>option]:bg-popover",
        className,
      )}
      {...props}
    />
  );
}

/** Previous / next links that keep the current filters. */
export function Pagination({
  basePath,
  params,
  page,
  pageSize,
  total,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  pageSize: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const q = new URLSearchParams(Object.entries({ ...params, page: String(p) }).filter((e): e is [string, string] => !!e[1]));
    return `${basePath}?${q.toString()}`;
  };
  return (
    <div className="flex items-center justify-between gap-3 border-t px-4.5 py-3 text-sm text-subtle">
      <span>
        {total.toLocaleString("en-US")} total · page {page} of {pages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Previous
          </Link>
        ) : null}
        {page < pages ? (
          <Link href={href(page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** Small coloured word for user/role states. */
export function Tag({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "info" | "warning" | "danger"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
        tone === "neutral" && "bg-accent text-muted-foreground",
        tone === "accent" && "bg-primary/15 text-primary",
        tone === "info" && "bg-info/15 text-info",
        tone === "warning" && "bg-warning/15 text-warning",
        tone === "danger" && "bg-destructive/15 text-destructive",
      )}
    >
      {children}
    </span>
  );
}
