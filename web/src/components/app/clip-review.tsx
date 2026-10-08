"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  LoaderCircleIcon,
  PlayIcon,
  RotateCcwIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { postRender } from "@/components/app/clip-render";
import { usePlayer } from "@/components/app/source-player";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ClipView } from "@/lib/videos/clips";
import type { RenderView } from "@/lib/videos/renders";
import { CAPTION_STYLES } from "@/shared/caption-styles";
import { CLIP_EDIT, REJECT_REASONS } from "@/shared/clip-edit";
import type { ClipStatus, Language, Script } from "@/shared/enums";

/**
 * Step 13: the user's say on a clip — approve / reject (with a reason), trim, framing and
 * caption style. Changes save to the clip; "Save & render" also makes a new MP4.
 */

type ApiError = { error?: { message?: string } };

type ClipPatch = {
  status?: ClipStatus;
  reason?: string;
  startMs?: number;
  endMs?: number;
  cropOffsetX?: number;
  captionStyleId?: string;
  autoZoom?: boolean;
};

async function patchClip(clipId: string, body: ClipPatch): Promise<void> {
  const res = await fetch(`/api/clips/${clipId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(err?.error?.message ?? "Couldn’t save. Please try again.");
  }
}

/** 12.4 s → "0:12.4" — trims move in half seconds, so tenths matter here. */
function timecode(ms: number): string {
  const tenths = Math.round(ms / 100);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

// ── approve / reject ─────────────────────────────────────────

export function ClipVerdict({ clip }: { clip: ClipView }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const save = useMutation({
    mutationFn: (body: ClipPatch) => patchClip(clip.id, body),
    onSuccess: () => {
      setAsking(false);
      router.refresh();
    },
    onError: (err) => toast.error(err.message),
  });
  const busy = save.isPending;

  if (clip.status === "rejected") {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <XIcon className="size-4" />
        <span>
          Rejected{clip.rejectReason ? ` · ${clip.rejectReason}` : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={() => save.mutate({ status: "suggested" })}
        >
          <Undo2Icon />
          Undo
        </Button>
      </div>
    );
  }

  if (asking) {
    return (
      <div className="flex flex-col gap-2.5 rounded-xl border bg-sunken p-3">
        <span className="text-sm">
          What’s wrong with it? Your answer helps the AI pick better clips.
        </span>
        <div className="flex flex-wrap gap-1.5">
          {REJECT_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              disabled={busy}
              onClick={() => save.mutate({ status: "rejected", reason })}
              className="h-9 rounded-full border px-3.5 text-[13px] text-muted-foreground transition-colors hover:border-destructive/50 hover:text-foreground disabled:opacity-60"
            >
              {reason}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => save.mutate({ status: "rejected" })}
          >
            Reject without a reason
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setAsking(false)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const approved = clip.status === "approved";
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        aria-pressed={approved}
        disabled={busy}
        onClick={() =>
          save.mutate({ status: approved ? "suggested" : "approved" })
        }
        className={cn(
          approved &&
            "border-primary/50 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        )}
      >
        {busy && !asking ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : (
          <CheckIcon />
        )}
        {approved ? "Approved" : "Approve"}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        <XIcon />
        Reject
      </Button>
    </div>
  );
}

// ── trim / framing / captions ────────────────────────────────

type Draft = {
  startMs: number;
  endMs: number;
  cropOffsetX: number;
  captionStyleId: string;
  autoZoom: boolean;
};
type EditTab = "trim" | "framing" | "captions";

const EDIT_TABS: { id: EditTab; label: string }[] = [
  { id: "trim", label: "Trim" },
  { id: "framing", label: "Framing" },
  { id: "captions", label: "Captions" },
];

const FRAMING_PRESETS = [
  { label: "Left", value: -1 },
  { label: "Center", value: 0 },
  { label: "Right", value: 1 },
] as const;

const CAPTION_NOTES: Record<string, string> = {
  "preset:bold": "Big white words with a black outline. Key words in yellow; the first line pops in bigger.",
  "preset:clean": "Smaller words on a soft dark box. Key words in yellow.",
  "preset:pop": "Large words, three at a time. Key words in green; the first line pops in bigger.",
  "preset:fire": "Yellow words with key words in red; the first line pops in bigger.",
  "preset:minimal": "Small, quiet captions. No colours, no animation.",
};

const segment = (on: boolean) =>
  cn(
    "h-9 rounded-md px-3 text-[13px] transition-colors",
    on
      ? "bg-raised font-medium text-foreground"
      : "text-muted-foreground hover:text-foreground",
  );

/**
 * Under the player: the selected clip's trim / framing / captions, one tab at a time, so the
 * toolbar keeps a fixed, small height and the whole page fits one screen. Framing shows the
 * 9:16 frame on the player while its tab is open.
 */
export function ClipEditToolbar({
  clips,
  videoId,
  videoMs,
  processing,
  expired,
  language,
  captionScript,
  canSwitchScript,
}: {
  clips: ClipView[];
  videoId: string;
  videoMs: number;
  processing: boolean;
  expired: boolean;
  language: Language;
  /** The video's caption letters (Step 15). */
  captionScript: Script;
  /** A Banglish switch is a post-text request; false when none are left. */
  canSwitchScript: boolean;
}) {
  const { selectedId } = usePlayer();
  const [tab, setTab] = useState<EditTab>("trim");
  const clip = clips.find((c) => c.id === selectedId) ?? null;
  const note = expired
    ? "This video’s files have expired, so clips can’t be edited."
    : processing
      ? "Trim, framing and captions open when processing finishes."
      : clips.length === 0
        ? "Clips appear here to trim, frame and caption once they’re found."
        : !clip
          ? "Pick a clip to trim, frame and caption it."
          : null;

  return (
    <section
      aria-label="Edit clip"
      className="flex flex-col gap-2.5 rounded-2xl border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          role="tablist"
          aria-label="Edit"
          className="flex gap-1 rounded-[10px] border bg-background p-1"
        >
          {EDIT_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={segment(tab === t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {clip && (
          <span className="ml-auto text-xs text-subtle">
            Editing clip {clip.rank}
            {clip.ai ? " · trimmed" : ""}
          </span>
        )}
      </div>
      {note || !clip ? (
        <p className="flex min-h-21 items-center px-1 text-[13px] text-subtle">
          {note}
        </p>
      ) : (
        <ClipEditor
          // A save refreshes the clip from the server; the editor then starts from what was stored.
          key={`${clip.id}:${clip.startMs}:${clip.endMs}:${clip.cropOffsetX}:${clip.captionStyleId}:${clip.autoZoom}`}
          clip={clip}
          tab={tab}
          videoId={videoId}
          videoMs={videoMs}
          letters={
            language === "bn" ? (
              <CaptionLetters
                videoId={videoId}
                script={captionScript}
                enabled={canSwitchScript}
              />
            ) : null
          }
        />
      )}
    </section>
  );
}

function ClipEditor({
  clip,
  tab,
  videoId,
  videoMs,
  letters,
}: {
  clip: ClipView;
  tab: EditTab;
  videoId: string;
  videoMs: number;
  /** The Banglish switch (Bangla videos), shown in the Captions tab. */
  letters: ReactNode;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { playClip, setFrame } = usePlayer();
  const saved: Draft = {
    startMs: clip.startMs,
    endMs: clip.endMs,
    cropOffsetX: clip.cropOffsetX,
    captionStyleId: clip.captionStyleId,
    autoZoom: clip.autoZoom,
  };
  const [draft, setDraft] = useState<Draft>(saved);

  const rangeChanged =
    draft.startMs !== saved.startMs || draft.endMs !== saved.endMs;
  const dirty =
    rangeChanged ||
    draft.cropOffsetX !== saved.cropOffsetX ||
    draft.captionStyleId !== saved.captionStyleId ||
    draft.autoZoom !== saved.autoZoom;
  const ai = clip.ai ?? { startMs: clip.startMs, endMs: clip.endMs };
  const atAiCut = draft.startMs === ai.startMs && draft.endMs === ai.endMs;
  const len = draft.endMs - draft.startMs;
  const step = CLIP_EDIT.nudgeMs;

  // The 9:16 frame on the player while framing is open (or differs from what's saved).
  const showFrame =
    tab === "framing" || draft.cropOffsetX !== saved.cropOffsetX;
  useEffect(() => {
    setFrame(showFrame ? draft.cropOffsetX : null);
  }, [showFrame, draft.cropOffsetX, setFrame]);
  useEffect(() => () => setFrame(null), [setFrame]);

  const save = useMutation({
    mutationFn: async (render: boolean) => {
      const body: ClipPatch = {};
      if (rangeChanged)
        Object.assign(body, { startMs: draft.startMs, endMs: draft.endMs });
      if (draft.cropOffsetX !== saved.cropOffsetX)
        body.cropOffsetX = draft.cropOffsetX;
      if (draft.captionStyleId !== saved.captionStyleId)
        body.captionStyleId = draft.captionStyleId;
      if (draft.autoZoom !== saved.autoZoom) body.autoZoom = draft.autoZoom;
      await patchClip(clip.id, body);
      return render ? postRender(clip.id) : null;
    },
    onSuccess: (view) => {
      if (view)
        queryClient.setQueryData<RenderView[]>(
          ["renders", videoId],
          (old = []) => [...old.filter((r) => r.clipId !== clip.id), view],
        );
      toast.success(view ? "Saved — rendering the new version." : "Saved.");
      router.refresh();
    },
    onError: (err) => toast.error(err.message),
  });

  const nudge = (edge: "startMs" | "endMs", by: number) =>
    setDraft((d) => ({ ...d, [edge]: d[edge] + by }));
  const can = {
    startEarlier: draft.startMs - step >= 0 && len + step <= CLIP_EDIT.maxMs,
    startLater: len - step >= CLIP_EDIT.minMs,
    endEarlier: len - step >= CLIP_EDIT.minMs,
    endLater: draft.endMs + step <= videoMs && len + step <= CLIP_EDIT.maxMs,
  };

  return (
    <fieldset
      disabled={save.isPending}
      className="flex min-h-21 flex-wrap items-center gap-x-6 gap-y-2"
    >
      <legend className="sr-only">
        {EDIT_TABS.find((t) => t.id === tab)?.label}
      </legend>
      {tab === "trim" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <div className="flex flex-col gap-1.5">
            <Edge
              label="Start"
              value={draft.startMs}
              onEarlier={
                can.startEarlier ? () => nudge("startMs", -step) : undefined
              }
              onLater={
                can.startLater ? () => nudge("startMs", step) : undefined
              }
              onPlay={() =>
                playClip(
                  clip.id,
                  draft.startMs,
                  Math.min(draft.startMs + 3_000, draft.endMs),
                )
              }
              playLabel="Play the first 3 seconds"
            />
            <Edge
              label="End"
              value={draft.endMs}
              onEarlier={
                can.endEarlier ? () => nudge("endMs", -step) : undefined
              }
              onLater={can.endLater ? () => nudge("endMs", step) : undefined}
              onPlay={() =>
                playClip(
                  clip.id,
                  Math.max(draft.endMs - 3_000, draft.startMs),
                  draft.endMs,
                )
              }
              playLabel="Play the last 3 seconds"
            />
          </div>
          <div className="flex flex-col items-start gap-1">
            <span className="font-mono text-sm tabular-nums">
              {(len / 1000).toFixed(1)} s
            </span>
            {!atAiCut && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2.5"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    startMs: ai.startMs,
                    endMs: ai.endMs,
                  }))
                }
              >
                <RotateCcwIcon />
                Reset to AI cut
              </Button>
            )}
          </div>
        </div>
      )}

      {tab === "framing" && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 rounded-[10px] border bg-background p-1">
              {FRAMING_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={draft.cropOffsetX === p.value}
                  onClick={() =>
                    setDraft((d) => ({ ...d, cropOffsetX: p.value }))
                  }
                  className={segment(draft.cropOffsetX === p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={draft.cropOffsetX}
              onChange={(e) =>
                setDraft((d) => ({ ...d, cropOffsetX: Number(e.target.value) }))
              }
              aria-label="Move the frame left or right"
              aria-valuetext={
                draft.cropOffsetX === 0
                  ? "centre"
                  : `${Math.round(Math.abs(draft.cropOffsetX) * 100)}% ${draft.cropOffsetX < 0 ? "left" : "right"}`
              }
              className="h-2 w-40 cursor-pointer accent-primary"
            />
          </div>
          <span className="text-xs text-subtle">
            The lit box on the player is what the 9:16 clip keeps.
          </span>
        </div>
      )}

      {tab === "captions" && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {letters}
            <div className="flex w-fit gap-1 rounded-[10px] border bg-background p-1">
              {Object.values(CAPTION_STYLES).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={draft.captionStyleId === s.id}
                  onClick={() =>
                    setDraft((d) => ({ ...d, captionStyleId: s.id }))
                  }
                  className={segment(draft.captionStyleId === s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <span className="text-xs text-subtle">
            {CAPTION_NOTES[draft.captionStyleId] ?? ""}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex w-fit gap-1 rounded-[10px] border bg-background p-1">
              {([true, false] as const).map((on) => (
                <button
                  key={String(on)}
                  type="button"
                  aria-pressed={draft.autoZoom === on}
                  onClick={() => setDraft((d) => ({ ...d, autoZoom: on }))}
                  className={segment(draft.autoZoom === on)}
                >
                  {on ? "Auto zoom" : "No zoom"}
                </button>
              ))}
            </div>
            <span className="text-xs text-subtle">
              {draft.autoZoom
                ? "A quick punch-in at the start and a slow push on key lines."
                : "The frame stays still."}
            </span>
          </div>
        </div>
      )}

      {dirty && (
        <div className="ml-auto flex flex-col items-end gap-1.5">
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
          <div className="flex gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft(saved)}
            >
              Discard
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => save.mutate(false)}
            >
              Save
            </Button>
            <Button type="button" size="sm" onClick={() => save.mutate(true)}>
              {save.isPending ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : null}
              Save &amp; render
            </Button>
          </div>
        </div>
      )}
    </fieldset>
  );
}

/**
 * Bangla script or Banglish for the whole video's captions and post text (Step 15). Switching
 * rewrites the post text (a short "Writing titles & hooks" run); clips already rendered show
 * "Render again".
 */
function CaptionLetters({
  videoId,
  script,
  enabled,
}: {
  videoId: string;
  script: Script;
  enabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function choose(next: Script) {
    if (next === script || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/caption-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: next }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as ApiError | null;
        throw new Error(
          err?.error?.message ?? "Couldn’t switch. Please try again.",
        );
      }
      toast.success(
        next === "Latn"
          ? "Switching to Banglish — titles are rewritten, then render clips again."
          : "Switching to Bangla letters — titles are rewritten, then render clips again.",
      );
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Couldn’t switch. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      role="radiogroup"
      aria-label="Caption letters"
      title="Letters for every clip’s captions and post text"
      className="flex w-fit gap-1 rounded-[10px] border bg-background p-1"
    >
      {(
        [
          ["Beng", "বাংলা"],
          ["Latn", "Banglish"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={script === value}
          disabled={busy || (!enabled && script !== value)}
          onClick={() => choose(value)}
          className={segment(script === value)}
          lang={value === "Beng" ? "bn" : undefined}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** One edge of the clip: its time, half-second nudges either way, and a short listen. */
function Edge({
  label,
  value,
  onEarlier,
  onLater,
  onPlay,
  playLabel,
}: {
  label: string;
  value: number;
  onEarlier?: () => void;
  onLater?: () => void;
  onPlay: () => void;
  playLabel: string;
}) {
  const nudgeClass =
    "flex size-9 items-center justify-center rounded-md border font-mono text-sm transition-colors hover:bg-raised disabled:opacity-40";
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-9 text-xs text-subtle">{label}</span>
      <button
        type="button"
        className={nudgeClass}
        disabled={!onEarlier}
        onClick={onEarlier}
        aria-label={`${label} half a second earlier`}
      >
        −
      </button>
      <span className="w-14 text-center font-mono text-sm tabular-nums">
        {timecode(value)}
      </span>
      <button
        type="button"
        className={nudgeClass}
        disabled={!onLater}
        onClick={onLater}
        aria-label={`${label} half a second later`}
      >
        +
      </button>
      <button
        type="button"
        onClick={onPlay}
        aria-label={playLabel}
        title={playLabel}
        className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-raised hover:text-foreground"
      >
        <PlayIcon className="size-3.5" />
      </button>
    </div>
  );
}
