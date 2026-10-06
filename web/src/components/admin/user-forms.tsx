"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";

import { NativeSelect } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/admin/action";
import type { LimitsOverrideInput } from "@/lib/admin/users-service";

function useSubmit() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const submit = (call: () => Promise<ActionResult<unknown>>, success: string) =>
    start(async () => {
      const result = await call();
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(success);
      router.refresh();
    });
  return { pending, submit };
}

/** Change the user's plan (plans come from the limits settings). */
export function PlanForm({ action, plans, current }: { action: (plan: string) => Promise<ActionResult<unknown>>; plans: string[]; current: string }) {
  const id = useId();
  const [plan, setPlan] = useState(current);
  const { pending, submit } = useSubmit();
  return (
    <form
      className="flex flex-wrap items-end gap-2.5 px-4.5 py-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit(() => action(plan), `Plan changed to ${plan}.`);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>Plan</Label>
        <NativeSelect id={id} value={plan} onChange={(e) => setPlan(e.target.value)} className="min-w-40">
          {plans.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button type="submit" size="sm" disabled={pending || plan === current}>
        {pending ? "Saving…" : "Change plan"}
      </Button>
    </form>
  );
}

type NumberField = Exclude<keyof LimitsOverrideInput, "allowYoutube">;
const FIELDS: { key: NumberField; label: string; unit: string }[] = [
  { key: "monthlyMinutes", label: "Monthly minutes", unit: "min" },
  { key: "maxFileMB", label: "Max file size", unit: "MB (≤100)" },
  { key: "maxDurationMin", label: "Max video length", unit: "min" },
  { key: "concurrentJobs", label: "Videos at once", unit: "" },
  { key: "maxClipsPerVideo", label: "Clips per video", unit: "" },
  { key: "clipRequestsPerVideo", label: "New clip searches per video", unit: "" },
  { key: "copyRequestsPerVideo", label: "Post text rewrites per video", unit: "" },
];

/**
 * Per-user exceptions to the plan. A blank field means "use the plan's value" — the
 * placeholder shows what that is. Saving with every field blank removes the override.
 */
export function LimitsForm({
  action,
  override,
  planLimits,
}: {
  action: (input: LimitsOverrideInput) => Promise<ActionResult<unknown>>;
  override: Partial<Record<keyof LimitsOverrideInput, number | boolean | null>>;
  planLimits: Record<string, number | boolean> | null;
}) {
  const id = useId();
  const [values, setValues] = useState<Record<NumberField, string>>(
    () => Object.fromEntries(FIELDS.map((f) => [f.key, override[f.key] != null ? String(override[f.key]) : ""])) as Record<NumberField, string>,
  );
  const [youtube, setYoutube] = useState<"" | "yes" | "no">(override.allowYoutube == null ? "" : override.allowYoutube ? "yes" : "no");
  const { pending, submit } = useSubmit();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const input: LimitsOverrideInput = { allowYoutube: youtube === "" ? null : youtube === "yes" };
    for (const f of FIELDS) {
      const v = values[f.key].trim();
      input[f.key] = v === "" ? null : Number(v);
    }
    submit(() => action(input), "Limits saved.");
  };

  return (
    <form className="flex flex-col gap-4 px-4.5 py-4" onSubmit={onSubmit}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-${f.key}`}>
              {f.label} {f.unit && <span className="text-subtle">({f.unit})</span>}
            </Label>
            <Input
              id={`${id}-${f.key}`}
              inputMode="numeric"
              value={values[f.key]}
              placeholder={planLimits ? `plan: ${String(planLimits[f.key])}` : "plan value"}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value.replace(/[^\d]/g, "") }))}
            />
          </div>
        ))}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-yt`}>YouTube links</Label>
          <NativeSelect id={`${id}-yt`} value={youtube} onChange={(e) => setYoutube(e.target.value as "" | "yes" | "no")}>
            <option value="">plan: {planLimits ? (planLimits.allowYoutube ? "allowed" : "not allowed") : "—"}</option>
            <option value="yes">Allowed</option>
            <option value="no">Not allowed</option>
          </NativeSelect>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save limits"}
        </Button>
        <span className="text-xs text-subtle">Blank = use the plan&apos;s value. Applies to the next upload.</span>
      </div>
    </form>
  );
}
