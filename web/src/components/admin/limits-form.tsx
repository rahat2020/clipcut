"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";

import { FormSection, NumberField, SaveBar, SwitchField } from "@/components/admin/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/admin/action";
import type { LimitsSettings, PlanLimits } from "@/shared";
import { DEFAULT_PLAN } from "@/shared/enums";
import { MAX_FILE_MB_HARD_CAP } from "@/shared/settings/schemas";

type NumericKey = Exclude<keyof PlanLimits, "allowYoutube">;

/** Bounds mirror `planLimitsSchema` (shared/settings/schemas.ts); the server checks them again. */
const FIELDS: { key: NumericKey; label: string; min: number; max: number; unit?: string }[] = [
  { key: "monthlyMinutes", label: "Minutes per month", min: 0, max: 100_000, unit: "min" },
  { key: "maxFileMB", label: "Largest upload", min: 1, max: MAX_FILE_MB_HARD_CAP, unit: "MB" },
  { key: "maxDurationMin", label: "Longest video", min: 1, max: 180, unit: "min" },
  { key: "concurrentJobs", label: "Videos at once", min: 1, max: 10 },
  { key: "maxClipsPerVideo", label: "Clips per video", min: 1, max: 50 },
  { key: "clipRequestsPerVideo", label: "Find new clips", min: 0, max: 50, unit: "per video" },
  { key: "copyRequestsPerVideo", label: "Write again", min: 0, max: 100, unit: "per video" },
];

/**
 * The `limits` group: what each plan allows. Saving sends the whole group with the version it
 * was loaded at; a plan with users on it can't be removed. Applies to the next upload or request
 * (≤ 60 s). A user's own override (Users → user page) still wins over the plan.
 */
export function LimitsForm({
  initial,
  version,
  userCounts,
  save,
}: {
  initial: LimitsSettings;
  version: number;
  userCounts: Record<string, number>;
  save: (value: LimitsSettings, expectedVersion: number) => Promise<ActionResult<{ version: number }>>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<LimitsSettings>(initial);
  const [ver, setVer] = useState(version);
  const [newPlan, setNewPlan] = useState("");
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const setPlan = (plan: string, patch: Partial<PlanLimits>) => setDraft((d) => ({ plans: { ...d.plans, [plan]: { ...d.plans[plan]!, ...patch } } }));
  const removePlan = (plan: string) =>
    setDraft((d) => ({ plans: Object.fromEntries(Object.entries(d.plans).filter(([p]) => p !== plan)) }));
  const addPlan = () => {
    const name = newPlan.trim().toLowerCase();
    if (!name || name in draft.plans) return;
    setDraft((d) => ({ plans: { ...d.plans, [name]: { ...d.plans[DEFAULT_PLAN]! } } }));
    setNewPlan("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    start(async () => {
      const result = await save(draft, ver);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      setVer(result.data.version);
      toast.success("Limits saved. They apply to the next upload or request.");
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      {Object.entries(draft.plans).map(([plan, limits]) => {
        const users = userCounts[plan] ?? 0;
        const locked = plan === DEFAULT_PLAN || users > 0;
        return (
          <FormSection
            key={plan}
            title={plan}
            note={plan === DEFAULT_PLAN ? "The default plan: every new account starts here, and it can't be removed." : undefined}
            aside={
              <>
                <span className="text-sm text-subtle">
                  {users} user{users === 1 ? "" : "s"}
                </span>
                <Button type="button" variant="ghost" size="sm" disabled={locked} title={locked ? "Plans with users (and the default plan) can't be removed" : undefined} onClick={() => removePlan(plan)}>
                  Remove plan
                </Button>
              </>
            }
          >
            <div className="flex flex-wrap gap-x-5 gap-y-4">
              {FIELDS.map((f) => (
                <NumberField key={f.key} label={f.label} value={limits[f.key]} min={f.min} max={f.max} unit={f.unit} onChange={(v) => setPlan(plan, { [f.key]: v })} />
              ))}
            </div>
            <SwitchField label="YouTube links allowed" hint="Also needs the YouTube switch on the System page." checked={limits.allowYoutube} onChange={(allowYoutube) => setPlan(plan, { allowYoutube })} />
          </FormSection>
        );
      })}

      <FormSection title="Add a plan" note="Starts as a copy of the default plan. Move users to it from their user page. Retention for a new plan follows the default plan until you set its own days.">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex w-56 flex-col gap-1.5">
            <Label htmlFor="new-plan">Plan name</Label>
            <Input
              id="new-plan"
              value={newPlan}
              placeholder="e.g. pro"
              autoComplete="off"
              onChange={(e) => setNewPlan(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPlan();
                }
              }}
              className="font-mono"
            />
          </div>
          <Button type="button" variant="outline" disabled={newPlan.length < 2 || newPlan in draft.plans} onClick={addPlan}>
            Add plan
          </Button>
        </div>
      </FormSection>

      <SaveBar label="Save limits" dirty={dirty} pending={pending} version={ver} onDiscard={() => setDraft(initial)} />
    </form>
  );
}
