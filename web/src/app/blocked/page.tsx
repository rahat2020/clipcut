import { SignOutButton } from "@clerk/nextjs";
import type { Metadata } from "next";

import { AuthShell } from "@/components/brand/auth-shell";
import { Button } from "@/components/ui/button";

import { BLOCKED_CODES, type BlockedCode } from "@/lib/auth/page-guards";
import { connectDb } from "@/lib/db";
import { ERROR_SPECS, getSettings } from "@/shared";

export const metadata: Metadata = { title: "Access unavailable" };

/**
 * Where page guards send an account that can't use the app. Public on purpose: it only
 * shows fixed messages chosen by `code`, never anything about the account.
 */
export default async function BlockedPage({ searchParams }: PageProps<"/blocked">) {
  const { code } = await searchParams;
  const known = (BLOCKED_CODES as readonly string[]).includes(String(code));
  const blocked: BlockedCode | null = known ? (code as BlockedCode) : null;

  let message = blocked ? ERROR_SPECS[blocked].message : "You can't use the app right now.";
  if (blocked === "MAINTENANCE") {
    await connectDb();
    const system = await getSettings("system");
    if (system.maintenanceMessage) message = system.maintenanceMessage;
  }

  return (
    <AuthShell>
      <div className="flex max-w-md flex-col items-center gap-5 rounded-2xl border bg-card px-8 py-10 text-center">
        <h1 className="font-heading text-2xl font-bold tracking-tight">
          {blocked === "MAINTENANCE" ? "We’ll be right back" : "Access unavailable"}
        </h1>
        <p className="leading-relaxed text-muted-foreground">{message}</p>
        <SignOutButton>
          <Button variant="outline">Sign out</Button>
        </SignOutButton>
      </div>
    </AuthShell>
  );
}
