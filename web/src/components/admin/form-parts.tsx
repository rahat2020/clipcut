"use client";

import { useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Pieces shared by the settings forms (limits, retention, system) — same look as the AI models form. */

export function FormSection({ title, note, aside, children }: { title: string; note?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[14px] border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4.5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {note && <p className="mt-0.5 text-xs text-subtle">{note}</p>}
        </div>
        {aside && <div className="flex items-center gap-2">{aside}</div>}
      </div>
      <div className="flex flex-col gap-4 px-4.5 py-4">{children}</div>
    </section>
  );
}

/** A tick box with a one-line explanation under it. */
export function SwitchField({ label, hint, checked, onChange, danger }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; danger?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id} className={danger && checked ? "text-warning" : undefined}>
          {label}
        </Label>
        {hint && <span className="text-xs text-subtle">{hint}</span>}
      </div>
    </div>
  );
}

/** Whole-number input: digits only, with the allowed range shown under it. */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  unit,
  className,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  unit?: string;
  className?: string;
}) {
  const id = useId();
  const out = value < min || value > max;
  return (
    <div className={className ?? "flex w-40 flex-col gap-1.5"}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        value={String(value)}
        aria-invalid={out || undefined}
        onChange={(e) => onChange(Number(e.target.value.replace(/[^\d]/g, "")) || 0)}
        className="font-mono"
      />
      <span className={out ? "text-xs text-destructive" : "text-xs text-subtle"}>
        {min}–{max}
        {unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
}

/** Sticky bottom bar of a settings form. */
export function SaveBar({
  label,
  dirty,
  pending,
  version,
  onDiscard,
  saveType = "submit",
  onSave,
}: {
  label: string;
  dirty: boolean;
  pending: boolean;
  version: number;
  onDiscard: () => void;
  saveType?: "submit" | "button";
  onSave?: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 flex items-center gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-9 sm:px-9">
      <Button type={saveType} onClick={onSave} disabled={pending || !dirty}>
        {pending ? "Working…" : label}
      </Button>
      <Button type="button" variant="ghost" disabled={pending || !dirty} onClick={onDiscard}>
        Discard changes
      </Button>
      <span className="text-xs text-subtle">{dirty ? "Unsaved changes" : `Saved · version ${version}`}</span>
    </div>
  );
}
