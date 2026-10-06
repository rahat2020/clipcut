import type { Metadata } from "next";
import Link from "next/link";

import { AuthShell } from "@/components/brand/auth-shell";
import { buttonVariants } from "@/components/ui/button";
import { ROUTES } from "@/lib/routes";

export const metadata: Metadata = { title: "Page not found" };

/** Unknown address, or a video / clip that isn't the visitor's (the API answers those with 404 too). */
export default function NotFound() {
  return (
    <AuthShell>
      <div className="flex max-w-md flex-col items-center gap-5 rounded-2xl border bg-card px-8 py-10 text-center">
        <h1 className="font-heading text-2xl font-bold tracking-tight">We can’t find that page</h1>
        <p className="leading-relaxed text-muted-foreground">
          The link may be old, or the video may have been deleted. Your other videos are on your Home page.
        </p>
        <Link href={ROUTES.dashboard} className={buttonVariants()}>
          Go to Home
        </Link>
      </div>
    </AuthShell>
  );
}
