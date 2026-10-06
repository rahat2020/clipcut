"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/admin/action";

/**
 * One video's files-kept-until date (docs/ADMIN.md — Retention). "Keep for N more days" sets a
 * custom date counted from today; "Use the plan’s rule" removes it. Only while the files exist.
 */
export function ExpiryForm({
  hasOverride,
  action,
}: {
  hasOverride: boolean;
  /** Bound to the video id on the server: days from now, or null for the plan's rule. */
  action: (days: number | null) => Promise<ActionResult<unknown>>;
}) {
  const router = useRouter();
  const [days, setDays] = useState("30");
  const [pending, start] = useTransition();
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 365;

  const run = (value: number | null, message: string) =>
    start(async () => {
      const r = await action(value);
      if (!r.ok) {
        toast.error(r.error.message);
        return;
      }
      toast.success(message);
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-end gap-3 px-4.5 py-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="keep-days">Keep files for</Label>
        <div className="flex items-center gap-2">
          <Input id="keep-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} className="w-20 font-mono" />
          <span className="text-sm whitespace-nowrap text-subtle">more days</span>
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" disabled={pending || !valid} onClick={() => run(n, `Files are kept for ${n} more days.`)}>
        {pending ? "Working…" : "Keep files longer"}
      </Button>
      {hasOverride && (
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(null, "Back to the plan’s rule.")}>
          Use the plan’s rule
        </Button>
      )}
    </div>
  );
}
