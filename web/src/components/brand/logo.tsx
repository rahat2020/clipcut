import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * The mark: a 9:16 clip with a play button, its lower part cut off on a slant — "clip cut".
 * Same drawing as app/icon.svg (the favicon), which needs hex colors; keep the two in step.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-7 shrink-0", className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M10 23.31 L22 20.69 V24.5 A3 3 0 0 1 19 27.5 H13 A3 3 0 0 1 10 24.5 Z" className="fill-primary-foreground" />
      <path d="M11 20.31 V6.5 A3 3 0 0 1 14 3.5 H20 A3 3 0 0 1 23 6.5 V17.69 Z" className="fill-primary-foreground" />
      <path d="M15.2 8.6 L20.6 12 L15.2 15.4 Z" className="fill-primary" />
    </svg>
  );
}

export function Logo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className="font-heading text-[19px] font-bold tracking-tight">
        Clip<span className="text-primary">Cut</span>
      </span>
    </Link>
  );
}
