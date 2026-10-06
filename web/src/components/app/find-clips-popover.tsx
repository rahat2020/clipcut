"use client";

import { Popover } from "@base-ui/react/popover";
import { SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { INTENT_LABELS } from "@/lib/video-labels";
import { REQUEST_INTENTS } from "@/lib/videos/schemas";
import { CLIP_REQUEST } from "@/shared/clip-sets";
import type { ClipIntent, Language } from "@/shared/enums";

type Intent = (typeof REQUEST_INTENTS)[number];

const ITEMS = Object.fromEntries(REQUEST_INTENTS.map((i) => [i, INTENT_LABELS[i]])) as Record<Intent, string>;

/**
 * "Find new clips" (Step 14): pick another focus, or describe what to find, and the AI picks a
 * new set from the same transcript. Approved clips stay; no minutes are used. The video goes
 * back to processing for a minute or so (the page polls as usual).
 */
export function FindClipsPopover({
  videoId,
  language,
  current,
  left,
  limit,
  blocked,
  initialOpen = false,
}: {
  videoId: string;
  language: Language;
  /** Focus of the set on screen, pre-selected. */
  current: { intent: ClipIntent; query: string | null } | null;
  /** Requests left for this video (plan limit). */
  left: number;
  limit: number;
  /** Why it can't be used right now (processing, expired …), or null. */
  blocked: string | null;
  /** The dev preview opens it for screenshots. */
  initialOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(initialOpen);
  const [intent, setIntent] = useState<Intent>(current?.intent ?? "best");
  const [query, setQuery] = useState(current?.query ?? "");
  const [pending, setPending] = useState(false);

  const custom = intent === "custom";
  const queryOk = !custom || query.trim().length >= CLIP_REQUEST.queryMinChars;
  const same = !!current && current.intent === intent && (!custom || (current.query ?? "") === query.trim());
  const canSubmit = !blocked && left > 0 && queryOk && !pending;

  async function submit() {
    setPending(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/clip-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, ...(custom ? { query: query.trim() } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "Couldn’t start. Please try again.");
      }
      toast.success("Finding new clips… this takes about a minute.");
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t start. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={buttonVariants({ variant: "outline", size: "sm" })}>
        <SparklesIcon />
        Find new clips
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-xl border bg-card p-4 shadow-xl outline-none">
            <div>
              <Popover.Title className="text-sm font-medium">Find new clips</Popover.Title>
              <Popover.Description className="mt-1 text-[13px] text-subtle">
                The AI reads the transcript again and picks a new set. Clips you approved stay; the others are replaced. No minutes used.
              </Popover.Description>
            </div>

            <div className="flex flex-col gap-2">
              <Label id="find-focus-label" className="text-[13px] font-normal text-muted-foreground">
                Focus on
              </Label>
              <Select items={ITEMS} value={intent} onValueChange={(v) => v && setIntent(v as Intent)} disabled={pending}>
                <SelectTrigger aria-labelledby="find-focus-label" className="h-10! w-full rounded-[10px] bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REQUEST_INTENTS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {INTENT_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {custom && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="find-query" className="text-[13px] font-normal text-muted-foreground">
                  What should the clips show?
                </Label>
                <Input
                  id="find-query"
                  lang={language}
                  value={query}
                  maxLength={CLIP_REQUEST.queryMaxChars}
                  disabled={pending}
                  placeholder="e.g. where they talk about the final goal"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && canSubmit && void submit()}
                  className="h-10"
                />
                <p className="text-xs text-subtle">Any language. Describe the moment, not the exact words.</p>
              </div>
            )}

            {same && !blocked && <p className="text-xs text-subtle">Same focus as now — you’ll get different moments from the ones on screen.</p>}

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-subtle">
                {blocked ?? (left > 0 ? `${left} of ${limit} left for this video` : `You’ve used all ${limit} for this video`)}
              </span>
              <Button size="sm" onClick={submit} disabled={!canSubmit}>
                <SparklesIcon />
                {pending ? "Starting…" : "Find clips"}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
