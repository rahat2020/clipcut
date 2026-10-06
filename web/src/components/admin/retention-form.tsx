"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { RetentionPreviewView } from "@/app/admin/settings/actions";
import { FormSection, NumberField, SaveBar } from "@/components/admin/form-parts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/admin/action";
import { formatUtc } from "@/lib/format";
import type { RetentionSettings } from "@/shared";
import { DEFAULT_PLAN } from "@/shared/enums";

/** The settings the admin edits; `changedAt` is stamped by the server, never typed. */
type Draft = Omit<RetentionSettings, "changedAt">;

/**
 * The `retention` group. Changes apply to EVERY video, old and new (expiry is computed), so
 * "Review & save" first shows what the change does to existing videos; a change that deletes
 * sooner must be confirmed by typing the new value. No file is deleted sooner than the grace
 * period after the change.
 */
export function RetentionForm({
  initial,
  version,
  plans,
  preview,
  save,
}: {
  initial: RetentionSettings;
  version: number;
  /** Every plan that exists in the limits settings. */
  plans: string[];
  preview: (value: Draft) => Promise<ActionResult<RetentionPreviewView>>;
  save: (value: Draft, expectedVersion: number, confirm: string) => Promise<ActionResult<{ version: number }>>;
}) {
  const router = useRouter();
  const start0: Draft = { plans: initial.plans, graceHours: initial.graceHours, purgeSoftDeletedAfterDays: initial.purgeSoftDeletedAfterDays };
  const [draft, setDraft] = useState<Draft>(start0);
  const [ver, setVer] = useState(version);
  const [review, setReview] = useState<RetentionPreviewView | null>(null);
  const [typed, setTyped] = useState("");
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(draft) !== JSON.stringify(start0);

  const names = [...new Set([DEFAULT_PLAN, ...plans, ...Object.keys(draft.plans)])];
  const setDays = (plan: string, days: number) => setDraft((d) => ({ ...d, plans: { ...d.plans, [plan]: { days } } }));
  const dropPlan = (plan: string) => setDraft((d) => ({ ...d, plans: Object.fromEntries(Object.entries(d.plans).filter(([p]) => p !== plan)) }));

  const openReview = () =>
    start(async () => {
      const r = await preview(draft);
      if (!r.ok) {
        toast.error(r.error.message);
        return;
      }
      setTyped("");
      setReview(r.data);
    });

  const confirmSave = () =>
    start(async () => {
      const r = await save(draft, ver, typed.trim());
      if (!r.ok) {
        toast.error(r.error.message);
        return;
      }
      setVer(r.data.version);
      setReview(null);
      toast.success("Retention saved. The cleanup job follows it from now on.");
      router.refresh();
    });

  const typedOk = !review?.confirm || typed.trim() === review.confirm;

  return (
    <div className="flex flex-col gap-6">
      <FormSection title="How long files are kept" note="Counted from when a video finished processing. After that its source video, clips and covers are deleted; the user sees “expired”.">
        <div className="flex flex-wrap gap-x-5 gap-y-4">
          {names.map((plan) => {
            const own = draft.plans[plan];
            return (
              <div key={plan} className="flex flex-col gap-1.5">
                {own ? (
                  <>
                    <NumberField label={`${plan} plan`} value={own.days} min={1} max={365} unit="days" onChange={(days) => setDays(plan, days)} />
                    {plan !== DEFAULT_PLAN && (
                      <button type="button" className="w-fit text-xs text-subtle underline-offset-2 hover:text-foreground hover:underline" onClick={() => dropPlan(plan)}>
                        Use the {DEFAULT_PLAN} plan’s days
                      </button>
                    )}
                  </>
                ) : (
                  <div className="flex w-44 flex-col gap-1.5">
                    <Label>{plan} plan</Label>
                    <span className="flex h-8 items-center text-sm text-subtle">Same as {DEFAULT_PLAN}</span>
                    <button type="button" className="w-fit text-xs text-subtle underline-offset-2 hover:text-foreground hover:underline" onClick={() => setDays(plan, draft.plans[DEFAULT_PLAN]?.days ?? 7)}>
                      Set its own days
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </FormSection>

      <FormSection title="Safety" note="Two delays that protect users from a mistake here.">
        <div className="flex flex-wrap gap-x-5 gap-y-4">
          <NumberField label="Grace after a change" value={draft.graceHours} min={0} max={168} unit="hours — nothing is deleted sooner" onChange={(graceHours) => setDraft((d) => ({ ...d, graceHours }))} className="flex w-72 flex-col gap-1.5" />
          <NumberField label="Keep deleted videos’ records" value={draft.purgeSoftDeletedAfterDays} min={1} max={365} unit="days, then remove for good" onChange={(purgeSoftDeletedAfterDays) => setDraft((d) => ({ ...d, purgeSoftDeletedAfterDays }))} className="flex w-72 flex-col gap-1.5" />
        </div>
        <p className="text-xs text-subtle">
          {initial.changedAt ? `Retention days were last changed ${formatUtc(initial.changedAt)}.` : "Retention days were never changed from the defaults."}
        </p>
      </FormSection>

      <SaveBar label="Review & save" dirty={dirty} pending={pending} version={ver} onDiscard={() => setDraft(start0)} saveType="button" onSave={openReview} />

      <AlertDialog open={review !== null} onOpenChange={(o) => (pending ? null : !o && setReview(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{review?.confirm ? "This deletes files sooner" : "Save retention settings?"}</AlertDialogTitle>
            <AlertDialogDescription render={<div />}>{review && <ImpactText r={review} />}</AlertDialogDescription>
          </AlertDialogHeader>
          {review?.confirm && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="retention-confirm">Type {review.confirm} to confirm</Label>
              <Input id="retention-confirm" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button variant={review?.confirm ? "destructive" : "default"} onClick={confirmSave} disabled={pending || !typedOk}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ImpactText({ r }: { r: RetentionPreviewView }) {
  const i = r.impact;
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
      <li>
        {i.videos} video{i.videos === 1 ? "" : "s"} still ha{i.videos === 1 ? "s" : "ve"} files stored.
      </li>
      {i.changed === 0 && <li>No existing video’s deletion date changes.</li>}
      {i.shortened > 0 && (
        <li className="text-warning">
          {i.shortened} video{i.shortened === 1 ? "" : "s"} ({i.usersAffected} user{i.usersAffected === 1 ? "" : "s"}) will be deleted sooner, the earliest on {formatUtc(i.earliest)}.
          {i.dueAtOnce > 0 && ` ${i.dueAtOnce} ${i.dueAtOnce === 1 ? "is" : "are"} already past the new deadline and go at the next cleanup run${r.graceUntil ? ` after the grace period` : ""}.`}
        </li>
      )}
      {i.lengthened > 0 && (
        <li>
          {i.lengthened} video{i.lengthened === 1 ? "" : "s"} keep{i.lengthened === 1 ? "s" : ""} their files longer (files already deleted don’t come back).
        </li>
      )}
      {r.purgeDue > 0 && <li className="text-warning">{r.purgeDue} deleted-video record{r.purgeDue === 1 ? "" : "s"} will be removed for good at the next cleanup run.</li>}
      {r.graceUntil && <li>Grace period: nothing is deleted before {formatUtc(r.graceUntil)}.</li>}
    </ul>
  );
}
