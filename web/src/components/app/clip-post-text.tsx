"use client";

import { CheckIcon, CopyIcon, LoaderCircleIcon, PencilIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ClipCopyView, ClipView } from "@/lib/videos/clips";
import type { Language } from "@/shared/enums";
import { normalizeHashtags, POST_COPY } from "@/shared/post-copy";

type ApiError = { error?: { message?: string } };

async function post(url: string, body: unknown, method = "POST"): Promise<void> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(err?.error?.message ?? "Something went wrong. Please try again.");
  }
}

/** "Suggest words" in the cover editor (Step 15.6): new cover ideas for one clip; its other text stays. */
export function requestCoverWords(videoId: string, clipId: string): Promise<void> {
  return post(`/api/videos/${videoId}/copy-requests`, { clipId, part: "cover" });
}

/** Requests to write post text again (plan limit), or null when it can't be used. */
export type CopyRequests = { left: number; limit: number };

/**
 * A clip's post text (Step 15): title, hook (always labelled AI-written), description and
 * hashtags, each with a copy button; "Copy all" for pasting into a post. The user can edit it,
 * or ask the AI to write it again (the video goes back to "Writing titles & hooks" briefly).
 */
export function ClipPostText({
  clip,
  videoId,
  language,
  processing,
  requests,
}: {
  clip: ClipView;
  videoId: string;
  language: Language;
  processing: boolean;
  requests: CopyRequests | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const copy = clip.copy;
  const lang = copy?.script === "Latn" ? undefined : language;

  async function writeAgain(all: boolean) {
    setBusy(true);
    try {
      await post(`/api/videos/${videoId}/copy-requests`, all ? {} : { clipId: clip.id });
      toast.success("Writing… this takes a few seconds.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t start. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const canAsk = !processing && !!requests && requests.left > 0;
  const askTitle = !requests ? undefined : requests.left > 0 ? `${requests.left} of ${requests.limit} rewrites left for this video` : "No rewrites left for this video";

  if (!copy) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-dashed p-3">
        <span className="text-xs text-subtle">Post text</span>
        {processing ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            Title, hook and hashtags are being written…
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-muted-foreground">No title or hashtags yet.</p>
            <Button size="sm" variant="outline" disabled={!canAsk || busy} title={askTitle} onClick={() => writeAgain(true)}>
              <SparklesIcon />
              Write post text
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (editing) {
    return <PostTextEditor clipId={clip.id} copy={copy} lang={lang} onDone={() => setEditing(false)} />;
  }

  const all = [copy.title, "", [copy.hook, copy.description].filter(Boolean).join("\n"), "", copy.hashtags.join(" ")].join("\n").trim();
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border p-3">
      <div className="flex items-center gap-1">
        <span className="mr-auto text-xs text-subtle">
          Post text{copy.edited ? " · edited" : ""}
          {clip.copyPending && processing ? " · writing again…" : ""}
        </span>
        <CopyButton text={all} label="Copy all" />
        <Button variant="ghost" size="icon-sm" aria-label="Edit post text" title="Edit" disabled={processing} onClick={() => setEditing(true)}>
          <PencilIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Write again" title={askTitle ?? "Write again"} disabled={!canAsk || busy} onClick={() => writeAgain(false)}>
          <RefreshCwIcon className={cn(busy && "animate-spin")} />
        </Button>
      </div>
      <Field text={copy.title} lang={lang} className="font-heading text-[15px] font-semibold" />
      {copy.hook && <Field label="Hook · AI-written" text={copy.hook} lang={lang} />}
      {copy.description && <Field label="Description" text={copy.description} lang={lang} className="text-muted-foreground" />}
      {copy.hashtags.length > 0 && <Field text={copy.hashtags.join(" ")} lang={lang} className="text-info" />}
    </div>
  );
}

function Field({ label, text, lang, className }: { label?: string; text: string; lang?: string; className?: string }) {
  return (
    <div className="group flex items-start gap-2">
      <div className="min-w-0 flex-1">
        {label && <span className="block text-[11px] text-subtle">{label}</span>}
        <p lang={lang} className={cn("text-[13px] leading-snug break-words", className)}>
          {text}
        </p>
      </div>
      <CopyButton text={text} />
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("Couldn’t copy. Select the text and copy it instead.");
    }
  }
  const Icon = done ? CheckIcon : CopyIcon;
  return label ? (
    <Button variant="ghost" size="sm" onClick={copyText}>
      <Icon />
      {done ? "Copied" : label}
    </Button>
  ) : (
    <Button variant="ghost" size="icon-sm" aria-label="Copy" title="Copy" onClick={copyText} className="shrink-0 opacity-60 group-hover:opacity-100">
      <Icon />
    </Button>
  );
}

function PostTextEditor({ clipId, copy, lang, onDone }: { clipId: string; copy: ClipCopyView; lang?: string; onDone: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState(copy.title);
  const [hook, setHook] = useState(copy.hook);
  const [description, setDescription] = useState(copy.description);
  const [tags, setTags] = useState(copy.hashtags.join(" "));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const hashtags = normalizeHashtags(tags.split(/[\s,]+/));
      await post(`/api/clips/${clipId}`, { copy: { title, hook, description, hashtags } }, "PATCH");
      toast.success("Post text saved.");
      onDone();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const area = "w-full rounded-lg border bg-background px-3 py-2 text-[13px] leading-snug outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3">
      <span className="text-xs text-subtle">Edit post text</span>
      <Input aria-label="Title" lang={lang} value={title} maxLength={POST_COPY.titleMaxChars} onChange={(e) => setTitle(e.target.value)} className="h-9" />
      <textarea aria-label="Hook" lang={lang} value={hook} maxLength={POST_COPY.hookMaxChars} rows={2} onChange={(e) => setHook(e.target.value)} placeholder="Hook" className={area} />
      <textarea
        aria-label="Description"
        lang={lang}
        value={description}
        maxLength={POST_COPY.descriptionMaxChars}
        rows={3}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        className={area}
      />
      <Input aria-label="Hashtags" lang={lang} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#hashtags separated by spaces" className="h-9" />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={saving || !title.trim()}>
          {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}
