"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { ROUTES } from "@/lib/routes";

/**
 * What a signed-in page shows when something in it threw (Next's `error.tsx`): a plain
 * message and two ways out, never the error itself. `digest` is Next's short id of the
 * server-side log line, safe to show: quote it and the exact failure can be found.
 */
export function ErrorCard({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div role="alert" className="flex max-w-md flex-col items-center gap-4 rounded-2xl border bg-card px-8 py-10 text-center">
        <h1 className="font-heading text-2xl font-bold tracking-tight">Something went wrong</h1>
        <p className="leading-relaxed text-muted-foreground">
          This page hit a problem on our side. Your videos and clips are safe. Try again, and if it keeps happening, wait a few minutes.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={reset}>Try again</Button>
          <Link href={ROUTES.dashboard} className={buttonVariants({ variant: "outline" })}>
            Go to Home
          </Link>
        </div>
        {error.digest && <p className="text-xs text-subtle">Reference: {error.digest}</p>}
      </div>
    </div>
  );
}
