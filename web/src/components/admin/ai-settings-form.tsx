"use client";

import { FlaskConicalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { NativeSelect } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/admin/action";
import type { ModelTestResult, ModelUse } from "@/lib/admin/ai-service";
import { cn } from "@/lib/utils";
import { LANGUAGE_NAMES } from "@/lib/video-labels";
import type { AiCapMetric, AiProvider, AiSettings } from "@/shared";
// Client component: values only from "@/shared/enums" — the "@/shared" index pulls in Mongoose.
import { LANGUAGES, type Language } from "@/shared/enums";

type TaskKey = "clipSelection" | "copyWriting";
type Models = { gemini: string[]; groq: string[]; whisper: string[] };

/**
 * The `ai` settings group as a form. Saving sends the whole group with the version it was
 * loaded at; if someone saved in between, the server refuses (reload and redo).
 * Changes reach the worker within 60 s and apply to jobs that START after that.
 */
export function AiSettingsForm({
  initial,
  version,
  models,
  listErrors,
  usage,
  promptVersions,
  save,
  test,
}: {
  initial: AiSettings;
  version: number;
  models: Models;
  listErrors: string[];
  usage: Record<AiCapMetric, number> | null;
  promptVersions: { clipSelection: readonly string[]; copyWriting: readonly string[] };
  save: (value: AiSettings, expectedVersion: number) => Promise<ActionResult<{ version: number }>>;
  test: (provider: AiProvider, model: string, use: ModelUse) => Promise<ActionResult<ModelTestResult>>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<AiSettings>(initial);
  const [ver, setVer] = useState(version);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const setTask = <K extends TaskKey>(key: K, patch: Partial<AiSettings[K]>) => setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    start(async () => {
      const result = await save(draft, ver);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      setVer(result.data.version);
      toast.success("AI settings saved. The worker picks them up within a minute.");
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      {listErrors.length > 0 && (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          Model lists unavailable: {listErrors.join(" · ")}. You can still type a model name.
        </p>
      )}

      <Section
        title="Transcription"
        note="Speech to text. Gemini writes the text for the languages ticked below (piece by piece, D42); Whisper does the rest and steps in when every Gemini model fails. Whisper: whisper-large-v3 (turbo is unusable for Bangla — D37)."
      >
        <div className="flex flex-wrap items-end gap-3">
          <ModelInput label="Whisper model" value={draft.transcription.model} options={models.whisper} onChange={(model) => setDraft((d) => ({ ...d, transcription: { ...d.transcription, model } }))} />
          <TestButton test={test} provider="groq" model={draft.transcription.model} use="transcription" />
          <Toggle
            label="Enabled"
            checked={draft.transcription.enabled}
            onChange={(enabled) => setDraft((d) => ({ ...d, transcription: { ...d.transcription, enabled } }))}
          />
        </div>
        <GeminiTranscription
          value={draft.transcription.gemini}
          options={models.gemini}
          onChange={(gemini) => setDraft((d) => ({ ...d, transcription: { ...d.transcription, gemini } }))}
        />
      </Section>

      <TaskSection
        title="Clip selection"
        note="Reads the whole transcript and picks the moments. Used by “Finding moments”."
        task={draft.clipSelection}
        models={models}
        prompts={promptVersions.clipSelection}
        test={test}
        onChange={(patch) => setTask("clipSelection", patch)}
      />

      <TaskSection
        title="Copy writing"
        note="Titles, hooks, descriptions and hashtags for each clip, and Banglish captions. One request per video."
        task={draft.copyWriting}
        models={models}
        prompts={promptVersions.copyWriting}
        test={test}
        onChange={(patch) => setTask("copyWriting", patch)}
      />

      <Section title="Daily caps" note="Our own ceilings below the free tiers (UTC day). A job that hits one waits until tomorrow.">
        <div className="grid gap-3 sm:grid-cols-3">
          <CapInput
            label="Groq audio minutes"
            value={draft.dailyCaps.groqAudioMinutes}
            used={usage ? Math.ceil(usage["groq:audioSeconds"] / 60) : null}
            onChange={(v) => setDraft((d) => ({ ...d, dailyCaps: { ...d.dailyCaps, groqAudioMinutes: v } }))}
          />
          <CapInput
            label="Groq requests"
            value={draft.dailyCaps.groqRequests}
            used={usage?.["groq:requests"] ?? null}
            onChange={(v) => setDraft((d) => ({ ...d, dailyCaps: { ...d.dailyCaps, groqRequests: v } }))}
          />
          <CapInput
            label="Gemini requests"
            value={draft.dailyCaps.geminiRequests}
            used={usage?.["gemini:requests"] ?? null}
            onChange={(v) => setDraft((d) => ({ ...d, dailyCaps: { ...d.dailyCaps, geminiRequests: v } }))}
          />
        </div>
      </Section>

      <div className="sticky bottom-0 -mx-4 flex items-center gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-9 sm:px-9">
        <Button type="submit" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save AI settings"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending || !dirty} onClick={() => setDraft(initial)}>
          Discard changes
        </Button>
        <span className="text-xs text-subtle">{dirty ? "Unsaved changes" : `Saved · version ${ver}`}</span>
      </div>
    </form>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[14px] border bg-card">
      <div className="border-b px-4.5 py-3.5">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-subtle">{note}</p>
      </div>
      <div className="flex flex-col gap-4 px-4.5 py-4">{children}</div>
    </section>
  );
}

type Task = AiSettings["clipSelection"];

function TaskSection({
  title,
  note,
  task,
  models,
  prompts,
  test,
  onChange,
}: {
  title: string;
  note: string;
  task: Task;
  models: Models;
  prompts: readonly string[];
  test: (provider: AiProvider, model: string, use: ModelUse) => Promise<ActionResult<ModelTestResult>>;
  onChange: (patch: Partial<Task>) => void;
}) {
  const id = useId();
  const fallbacks = task.fallbacks;
  const setFallback = (i: number, next: Task["fallbacks"][number] | null) =>
    onChange({ fallbacks: next ? fallbacks.map((f, k) => (k === i ? next : f)) : fallbacks.filter((_, k) => k !== i) });
  return (
    <Section title={title} note={note}>
      <div className="flex flex-wrap items-end gap-3">
        <ProviderSelect value={task.provider} onChange={(provider) => onChange({ provider, model: models[provider][0] ?? task.model })} />
        <ModelInput label="Model" value={task.model} options={models[task.provider]} onChange={(model) => onChange({ model })} />
        <TestButton test={test} provider={task.provider} model={task.model} use="text" />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-temp`}>Temperature</Label>
          <Input
            id={`${id}-temp`}
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={task.temperature}
            onChange={(e) => onChange({ temperature: Math.min(2, Math.max(0, Number(e.target.value) || 0)) })}
            className="w-24 font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-prompt`}>Prompt version</Label>
          <NativeSelect id={`${id}-prompt`} value={task.promptVersion} onChange={(e) => onChange({ promptVersion: e.target.value })} className="font-mono">
            {!prompts.includes(task.promptVersion) && <option value={task.promptVersion}>{task.promptVersion} (unknown)</option>}
            {prompts.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Toggle label="Enabled" checked={task.enabled} onChange={(enabled) => onChange({ enabled })} />
      </div>
      <div className="flex flex-col gap-3 border-t pt-4">
        <span className="text-xs text-subtle">
          Fallbacks, tried in order when the model before is busy, over its daily quota, or gives an unusable answer. Each Gemini
          model has its own free daily quota, so more models = more videos a day.
        </span>
        {fallbacks.map((f, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <span className="w-6 pb-2 font-mono text-xs text-subtle">{i + 1}.</span>
            <ProviderSelect value={f.provider} onChange={(p) => setFallback(i, { provider: p, model: models[p][0] ?? f.model })} />
            <ModelInput label="Model" value={f.model} options={models[f.provider]} onChange={(model) => setFallback(i, { ...f, model })} />
            <TestButton test={test} provider={f.provider} model={f.model} use="text" />
            <Button type="button" variant="ghost" size="sm" onClick={() => setFallback(i, null)}>
              Remove
            </Button>
          </div>
        ))}
        {fallbacks.length < 5 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => onChange({ fallbacks: [...fallbacks, { provider: "gemini", model: models.gemini[0] ?? "gemini-3.1-flash-lite" }] })}
          >
            Add fallback
          </Button>
        )}
      </div>
    </Section>
  );
}

function ProviderSelect({ value, onChange }: { value: AiProvider; onChange: (p: AiProvider) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Provider</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value as AiProvider)}>
        <option value="gemini">Gemini</option>
        <option value="groq">Groq</option>
      </NativeSelect>
    </div>
  );
}

/** Free text with the live list as suggestions — a brand-new model name can be typed. */
type GeminiText = AiSettings["transcription"]["gemini"];

/** Which languages Gemini transcribes, with which models (first, then fallback), in how big batches. */
function GeminiTranscription({ value, options, onChange }: { value: GeminiText; options: string[]; onChange: (v: GeminiText) => void }) {
  const batchId = useId();
  const setModel = (i: number, model: string) => {
    const next = [...value.models];
    next[i] = model;
    // Empty fallback = none; the first model is required (the server refuses an empty list).
    onChange({ ...value, models: next.filter((m, k) => k === 0 || m) });
  };
  const toggleLanguage = (lang: Language, on: boolean) =>
    onChange({ ...value, languages: LANGUAGES.filter((l) => (l === lang ? on : value.languages.includes(l))) });
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm font-medium">Gemini text for</span>
        {LANGUAGES.map((lang) => (
          <Toggle key={lang} label={LANGUAGE_NAMES[lang]} checked={value.languages.includes(lang)} onChange={(on) => toggleLanguage(lang, on)} />
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <ModelInput label="Gemini model" value={value.models[0] ?? ""} options={options} onChange={(m) => setModel(0, m)} />
        <ModelInput label="Then (optional)" value={value.models[1] ?? ""} options={options} onChange={(m) => setModel(1, m)} />
        <ModelInput label="Then (optional)" value={value.models[2] ?? ""} options={options} onChange={(m) => setModel(2, m)} />
        <div className="flex w-36 flex-col gap-1.5">
          <Label htmlFor={batchId}>Minutes per request</Label>
          <Input
            id={batchId}
            inputMode="numeric"
            value={String(value.batchMinutes)}
            onChange={(e) => onChange({ ...value, batchMinutes: Number(e.target.value.replace(/[^\d]/g, "")) || 0 })}
            className="font-mono"
          />
        </div>
      </div>
    </div>
  );
}

function ModelInput({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="flex min-w-64 flex-1 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} list={`${id}-list`} value={value} onChange={(e) => onChange(e.target.value.trim())} className="font-mono" />
      <datalist id={`${id}-list`}>
        {options.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex h-8 items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

function TestButton({
  test,
  provider,
  model,
  use,
}: {
  test: (provider: AiProvider, model: string, use: ModelUse) => Promise<ActionResult<ModelTestResult>>;
  provider: AiProvider;
  model: string;
  use: ModelUse;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ModelTestResult | null>(null);
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending || !model}
        onClick={() =>
          start(async () => {
            setResult(null);
            const r = await test(provider, model, use);
            if (!r.ok) toast.error(r.error.message);
            else setResult(r.data);
          })
        }
      >
        <FlaskConicalIcon />
        {pending ? "Testing…" : "Test"}
      </Button>
      {result && (
        <span className={cn("max-w-72 text-xs", result.ok ? "text-primary" : "text-destructive")}>
          {result.ok ? "✓" : "✗"} {result.message} · {(result.latencyMs / 1000).toFixed(1)} s
        </span>
      )}
    </div>
  );
}

function CapInput({ label, value, used, onChange }: { label: string; value: number; used: number | null; onChange: (v: number) => void }) {
  const id = useId();
  const share = used != null && value > 0 ? used / value : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="numeric" value={String(value)} onChange={(e) => onChange(Number(e.target.value.replace(/[^\d]/g, "")) || 0)} className="font-mono" />
      <span className={cn("text-xs", share >= 1 ? "text-destructive" : share >= 0.8 ? "text-warning" : "text-subtle")}>
        {used == null ? "Today: unknown (Redis unreachable)" : `Today: ${used.toLocaleString("en-US")} used`}
      </span>
    </div>
  );
}
