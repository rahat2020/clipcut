"use client";

import { SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";

import { NativeSelect } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/admin/action";
import type { AiProvider } from "@/shared";

type Choice = { provider: AiProvider; model: string; promptVersion: string };

/**
 * "Pick clips again with …": choose provider, model (live list, or type any name) and
 * prompt version. The worker makes a new run with exactly that model; old runs stay so
 * the results can be compared.
 */
export function RerunClipsForm({
  action,
  defaults,
  models,
  promptVersions,
  disabledReason,
}: {
  action: (input: Choice) => Promise<ActionResult<unknown>>;
  defaults: Choice;
  models: Record<AiProvider, string[]>;
  promptVersions: readonly string[];
  disabledReason: string | null;
}) {
  const router = useRouter();
  const id = useId();
  const [choice, setChoice] = useState<Choice>(defaults);
  const [pending, start] = useTransition();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    start(async () => {
      const result = await action({ ...choice, model: choice.model.trim() });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success("Queued — the worker will pick clips again in a few seconds.");
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 px-4.5 py-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-provider`}>Provider</Label>
          <NativeSelect
            id={`${id}-provider`}
            value={choice.provider}
            onChange={(e) => {
              const provider = e.target.value as AiProvider;
              setChoice((c) => ({ ...c, provider, model: models[provider][0] ?? "" }));
            }}
          >
            <option value="gemini">Gemini</option>
            <option value="groq">Groq</option>
          </NativeSelect>
        </div>
        <div className="flex min-w-60 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-model`}>Model</Label>
          <Input
            id={`${id}-model`}
            list={`${id}-models`}
            value={choice.model}
            onChange={(e) => setChoice((c) => ({ ...c, model: e.target.value }))}
            className="font-mono"
          />
          <datalist id={`${id}-models`}>
            {models[choice.provider].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-prompt`}>Prompt</Label>
          <NativeSelect
            id={`${id}-prompt`}
            value={choice.promptVersion}
            onChange={(e) => setChoice((c) => ({ ...c, promptVersion: e.target.value }))}
            className="font-mono"
          >
            {promptVersions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" size="sm" disabled={pending || !!disabledReason || !choice.model.trim()}>
          <SparklesIcon />
          {pending ? "Queuing…" : "Pick clips again"}
        </Button>
      </div>
      <p className="text-xs text-subtle">
        {disabledReason ??
          "Makes a new clip run with exactly this model (no fallback). The transcript is reused, so no minutes are charged; the user sees the new clips."}
      </p>
    </form>
  );
}
