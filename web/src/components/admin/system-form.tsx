"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";

import { FormSection, NumberField, SaveBar, SwitchField } from "@/components/admin/form-parts";
import { NativeSelect } from "@/components/admin/ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/admin/action";
import type { SystemSettings } from "@/shared";

const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"] as const;

/**
 * The `system` group: the switches that stop things in an emergency, plus processing and render
 * tuning. Reaches web and worker within 60 s. Admins are never locked out by maintenance mode.
 */
export function SystemForm({
  initial,
  version,
  save,
}: {
  initial: SystemSettings;
  version: number;
  save: (value: SystemSettings, expectedVersion: number) => Promise<ActionResult<{ version: number }>>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<SystemSettings>(initial);
  const [ver, setVer] = useState(version);
  const [pending, start] = useTransition();
  const messageId = useId();
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = (patch: Partial<SystemSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const setRender = (patch: Partial<SystemSettings["render"]>) => setDraft((d) => ({ ...d, render: { ...d.render, ...patch } }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    start(async () => {
      const result = await save(draft, ver);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      setVer(result.data.version);
      toast.success("System settings saved. They reach everything within a minute.");
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      {draft.maintenanceMode && (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          Maintenance mode is on: every signed-in user except admins sees the maintenance page instead of the app.
        </p>
      )}

      <FormSection title="Access" note="What users can do right now.">
        <SwitchField
          label="Maintenance mode"
          hint="Locks everyone except admins out of the app and shows the message below."
          checked={draft.maintenanceMode}
          onChange={(maintenanceMode) => set({ maintenanceMode })}
          danger
        />
        <div className="flex max-w-xl flex-col gap-1.5">
          <Label htmlFor={messageId}>Message shown to users</Label>
          <Input id={messageId} value={draft.maintenanceMessage} maxLength={500} placeholder="We’re making improvements and will be back shortly." onChange={(e) => set({ maintenanceMessage: e.target.value })} />
        </div>
        <SwitchField label="New uploads" hint="Off: nobody can add a video (file or YouTube link). Videos already processing finish." checked={draft.uploadsEnabled} onChange={(uploadsEnabled) => set({ uploadsEnabled })} danger={false} />
        <SwitchField label="YouTube links" hint="Off if YouTube starts blocking our downloads. Uploading files still works." checked={draft.youtubeEnabled} onChange={(youtubeEnabled) => set({ youtubeEnabled })} />
        <SwitchField label="New sign-ups" hint="Off: people who already have an account can sign in; new ones see a “closed” page." checked={draft.signupsEnabled} onChange={(signupsEnabled) => set({ signupsEnabled })} />
      </FormSection>

      <FormSection title="Processing" note="The worker that turns videos into clips.">
        <SwitchField
          label="Processing"
          hint="Off: queued videos wait (nothing is lost) and running ones finish. Turn it off when something is broken, then back on."
          checked={draft.processingEnabled}
          onChange={(processingEnabled) => set({ processingEnabled })}
          danger
        />
        <NumberField label="Videos at once (per worker)" value={draft.workerConcurrency} min={1} max={4} onChange={(workerConcurrency) => set({ workerConcurrency })} className="flex w-52 flex-col gap-1.5" />
        <p className="-mt-2 text-xs text-subtle">Read when the worker starts — restart it after changing this.</p>
      </FormSection>

      <FormSection title="Background jobs" note="Run by the worker on their own; switch off if one misbehaves.">
        <SwitchField label="Cleanup" hint="Deletes expired, abandoned and deleted videos’ files (every 30 minutes). Off: nothing is deleted by the worker." checked={draft.cleanupEnabled} onChange={(cleanupEnabled) => set({ cleanupEnabled })} />
        <SwitchField label="Daily database backup" hint="Saves the whole database to Cloudinary once a day and keeps the newest 7." checked={draft.backupEnabled} onChange={(backupEnabled) => set({ backupEnabled })} />
      </FormSection>

      <FormSection title="Rendering" note="How clips are made into videos.">
        <div className="flex flex-wrap gap-x-5 gap-y-4">
          <NumberField label="Rendered automatically" value={draft.render.autoRenderTop} min={0} max={10} unit="best clips" onChange={(autoRenderTop) => setRender({ autoRenderTop })} className="flex w-44 flex-col gap-1.5" />
          <NumberField label="Quality (CRF)" value={draft.render.crf} min={16} max={30} unit="lower = better, bigger" onChange={(crf) => setRender({ crf })} className="flex w-52 flex-col gap-1.5" />
          <div className="flex w-44 flex-col gap-1.5">
            <Label htmlFor="render-height">YouTube download</Label>
            <NativeSelect id="render-height" value={draft.render.youtubeMaxHeight} onChange={(e) => setRender({ youtubeMaxHeight: e.target.value === "720" ? 720 : 1080 })}>
              <option value={1080}>Up to 1080p (sharper)</option>
              <option value={720}>Up to 720p (faster)</option>
            </NativeSelect>
          </div>
          <div className="flex w-44 flex-col gap-1.5">
            <Label htmlFor="render-preset">Encoder speed</Label>
            <NativeSelect id="render-preset" value={draft.render.preset} onChange={(e) => setRender({ preset: PRESETS.find((p) => p === e.target.value) ?? "veryfast" })} className="font-mono">
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      </FormSection>

      <SaveBar label="Save system settings" dirty={dirty} pending={pending} version={ver} onDiscard={() => setDraft(initial)} />
    </form>
  );
}
