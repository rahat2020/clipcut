"use client";

import { CircleAlertIcon, FilmIcon, HourglassIcon, LinkIcon, ScissorsIcon, UploadIcon, WifiLowIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes, formatDuration, formatSpeed, formatTimeLeft } from "@/lib/format";
import {
  finalizeUpload,
  readVideoDuration,
  requestUploadTicket,
  submitYouTube,
  uploadToCloudinary,
  UploadError,
} from "@/lib/uploads/client-upload";
import { cn } from "@/lib/utils";
import { INTENT_LABELS } from "@/lib/video-labels";
import { ACCEPTED_VIDEO_TYPES, FORM_INTENTS } from "@/lib/videos/schemas";
import { parseYouTubeUrl } from "@/lib/videos/youtube-url";
import { SLOW_TRANSFER_BYTES_PER_SEC, type Language } from "@/shared/enums";
import { billableMinutes } from "@/shared/limits";

type Intent = (typeof FORM_INTENTS)[number];

const FORM_INTENT_ITEMS = Object.fromEntries(FORM_INTENTS.map((i) => [i, INTENT_LABELS[i]])) as Record<Intent, string>;

const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: "bn", label: "Bangla" },
  { value: "en", label: "English" },
];

const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|mkv|m4v)$/i;

export type NewVideoCardProps = {
  maxFileMB: number;
  maxDurationMin: number;
  youtubeAllowed: boolean;
  uploadsEnabled: boolean;
  defaultLanguage: Language;
  /** This month's processing minutes, so running out shows up before anything is sent. */
  minutes: { left: number; monthly: number; resetsOn: string | null };
};

type Picked = { file: File; durationMs: number | null };
type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; sent: number; startedAt: number; secondsLeft: number | null; bytesPerSec: number }
  | { kind: "finalizing" }
  | { kind: "submitting" };

/** Average speed so far and seconds left at that speed; unknown for the first couple of seconds. */
function estimateTransfer(sent: number, total: number, startedAt: number, now: number) {
  const elapsed = (now - startedAt) / 1000;
  if (elapsed < 2 || sent <= 0) return { secondsLeft: null, bytesPerSec: 0 };
  const bytesPerSec = sent / elapsed;
  return { secondsLeft: Math.ceil((total - sent) / bytesPerSec), bytesPerSec };
}

/** Start a new video: pick a file, choose language and focus, confirm permission, upload. */
export function NewVideoCard({
  maxFileMB,
  maxDurationMin,
  youtubeAllowed,
  uploadsEnabled,
  defaultLanguage,
  minutes,
}: NewVideoCardProps) {
  const router = useRouter();
  const [picked, setPicked] = useState<Picked | null>(null);
  const [language, setLanguage] = useState<Language>(defaultLanguage);
  const [intent, setIntent] = useState<Intent>("best");
  const [permission, setPermission] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Controlled on purpose: while busy both tabs are disabled, and an uncontrolled Base UI
  // Tabs then falls back to "no tab selected" — which hid the progress panel mid-upload.
  const [tab, setTab] = useState<"upload" | "youtube">("upload");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const youtubeId = parseYouTubeUrl(youtubeUrl);
  const youtubeInvalid = youtubeUrl.trim().length > 0 && !youtubeId;
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase.kind !== "idle";
  const outOfMinutes = minutes.left <= 0;

  // Leaving mid-upload would throw the upload away — ask first.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  async function pickFile(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    if (!ACCEPTED_VIDEO_TYPES.includes(file.type) && !VIDEO_EXTENSIONS.test(file.name)) {
      setError("That file isn’t a supported video. Use MP4, MOV or WebM.");
      return;
    }
    if (file.size > maxFileMB * 1024 * 1024) {
      setError(`This file is ${formatBytes(file.size)}. Your plan allows up to ${maxFileMB} MB.`);
      return;
    }
    const durationMs = await readVideoDuration(file);
    if (durationMs != null && durationMs > maxDurationMin * 60_000) {
      setError(`This video is ${formatDuration(durationMs)} long. Your plan allows up to ${maxDurationMin} minutes.`);
      return;
    }
    // Same rule and wording as the server (lib/uploads/rules.ts).
    if (durationMs != null && billableMinutes(durationMs) > minutes.left) {
      setError(
        minutes.left > 0
          ? `This video needs ${billableMinutes(durationMs)} minutes, but you have ${minutes.left} left this month.`
          : "You’ve used all your processing minutes for this month.",
      );
      return;
    }
    setPicked({ file, durationMs });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void pickFile(e.dataTransfer.files[0]);
  }

  async function submit() {
    if (!picked || !permission || busy) return;
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const { file, durationMs } = picked;

    try {
      setPhase({ kind: "uploading", sent: 0, startedAt: Date.now(), secondsLeft: null, bytesPerSec: 0 });
      const ticket = await requestUploadTicket({
        fileName: file.name,
        sizeBytes: file.size,
        durationMs,
        contentType: file.type,
      });
      await uploadToCloudinary({
        ticket,
        file,
        signal: controller.signal,
        onProgress: (sent) =>
          setPhase((p) =>
            p.kind === "uploading" ? { ...p, sent, ...estimateTransfer(sent, file.size, p.startedAt, Date.now()) } : p,
          ),
      });
      setPhase({ kind: "finalizing" });
      const video = await finalizeUpload({
        videoId: ticket.videoId,
        originalFilename: file.name,
        language,
        intent,
        permission: true,
      });
      toast.success("Upload complete. Your video is in the queue.");
      router.push(`/videos/${video.id}`);
    } catch (err) {
      setPhase({ kind: "idle" });
      if (err instanceof UploadError && err.code === "CANCELED") {
        toast("Upload canceled.");
        return;
      }
      setError(err instanceof UploadError ? err.message : "Something went wrong. Please try again.");
    } finally {
      abortRef.current = null;
    }
  }

  async function submitLink() {
    if (!youtubeId || !permission || busy) return;
    setError(null);
    setPhase({ kind: "submitting" });
    try {
      const video = await submitYouTube({
        url: youtubeUrl,
        clientRequestId: crypto.randomUUID(),
        language,
        intent,
        permission: true,
      });
      toast.success("Link added. Your video is in the queue.");
      router.push(`/videos/${video.id}`);
    } catch (err) {
      setPhase({ kind: "idle" });
      setError(err instanceof UploadError ? err.message : "Something went wrong. Please try again.");
    }
  }

  const canSubmit =
    permission && !busy && !outOfMinutes && (tab === "upload" ? uploadsEnabled && !!picked : youtubeAllowed && !!youtubeId);

  return (
    <section
      id="new-video"
      aria-labelledby="new-video-title"
      className="flex min-w-0 flex-1 scroll-mt-20 flex-col gap-5 rounded-2xl border bg-card p-5 sm:p-6"
    >
      <h2 id="new-video-title" className="sr-only">
        New video
      </h2>

      <MinutesNote minutes={minutes} maxDurationMin={maxDurationMin} />

      <Tabs value={tab} onValueChange={(v) => (v === "upload" || v === "youtube") && setTab(v)} className="gap-5">
        <TabsList className="h-11! rounded-xl border bg-background p-1">
          <TabsTrigger value="upload" className="h-9 gap-2 rounded-lg px-3.5 text-sm" disabled={busy}>
            <UploadIcon />
            Upload file
          </TabsTrigger>
          <TabsTrigger value="youtube" className="h-9 gap-2 rounded-lg px-3.5 text-sm" disabled={busy || !youtubeAllowed}>
            <LinkIcon />
            YouTube link
          </TabsTrigger>
        </TabsList>

        <TabsContent value="upload">
          {!uploadsEnabled ? (
            <div className="flex h-52 items-center justify-center rounded-xl border bg-sunken px-6 text-center text-muted-foreground">
              New uploads are paused right now. Please check back soon.
            </div>
          ) : picked ? (
            <SelectedFile picked={picked} phase={phase} onClear={() => setPicked(null)} onCancel={() => abortRef.current?.abort()} />
          ) : (
            <label
              htmlFor="video-file"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                "flex h-52 cursor-pointer flex-col items-center justify-center gap-3.5 rounded-xl border-[1.5px] border-dashed bg-sunken px-4 text-center transition-colors hover:border-primary/60",
                dragging ? "border-primary bg-primary/5" : "border-line-strong",
              )}
            >
              <span className="flex size-14 items-center justify-center rounded-2xl border bg-raised text-primary">
                <UploadIcon className="size-6" strokeWidth={1.8} />
              </span>
              <span className="text-[17px] font-medium">
                Drop a video here, or <span className="text-primary underline underline-offset-4">browse</span>
              </span>
              <span className="text-sm text-subtle">
                MP4, MOV or WebM · up to {maxFileMB} MB · up to {maxDurationMin} minutes
              </span>
              <input
                ref={inputRef}
                id="video-file"
                type="file"
                accept={[...ACCEPTED_VIDEO_TYPES, ".mp4", ".mov", ".webm", ".mkv", ".m4v"].join(",")}
                className="sr-only"
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </TabsContent>

        <TabsContent value="youtube">
          <div className="flex h-52 flex-col justify-center gap-3 rounded-xl border bg-sunken p-6 sm:p-7">
            <Label htmlFor="youtube-url" className="font-normal text-muted-foreground">
              Paste a YouTube link
            </Label>
            <Input
              id="youtube-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={youtubeUrl}
              onChange={(e) => {
                setYoutubeUrl(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) void submitLink();
              }}
              disabled={busy || !youtubeAllowed}
              aria-invalid={youtubeInvalid || undefined}
              aria-describedby="youtube-help"
              placeholder="https://www.youtube.com/watch?v=…"
              className="h-12 rounded-xl bg-background font-mono text-[15px]"
            />
            <span id="youtube-help" className={cn("text-[13px]", youtubeInvalid ? "text-destructive" : "text-subtle")}>
              {!youtubeAllowed
                ? "YouTube links aren’t available right now. Upload the file instead."
                : youtubeInvalid
                  ? "That doesn’t look like a YouTube video link."
                  : `Public or unlisted videos up to ${maxDurationMin} minutes. Live streams aren’t supported.`}
            </span>
          </div>
        </TabsContent>
      </Tabs>

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-5">
        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="mb-2 text-[13px] text-muted-foreground">Spoken language</legend>
          <div className="flex gap-1 rounded-[10px] border bg-background p-1">
            {LANGUAGE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={language === o.value}
                onClick={() => setLanguage(o.value)}
                className={cn(
                  "h-9 min-w-22 rounded-md px-3.5 text-[15px] transition-colors disabled:opacity-60",
                  language === o.value ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2">
          <Label id="intent-label" className="text-[13px] font-normal text-muted-foreground">
            What should clips focus on?
          </Label>
          <Select items={FORM_INTENT_ITEMS} value={intent} onValueChange={(v) => v && setIntent(v as Intent)} disabled={busy}>
            <SelectTrigger aria-labelledby="intent-label" className="h-11! min-w-60 rounded-[10px] bg-background text-[15px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORM_INTENTS.map((value) => (
                <SelectItem key={value} value={value}>
                  {INTENT_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="h-px bg-border" />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <Label className="cursor-pointer text-[15px] font-normal text-foreground/85">
          <Checkbox checked={permission} disabled={busy} onCheckedChange={(v) => setPermission(v === true)} />
          I own this video or have permission to use it.
        </Label>
        <Button size="lg" disabled={!canSubmit} onClick={tab === "upload" ? submit : submitLink}>
          <ScissorsIcon />
          {phase.kind === "uploading"
            ? "Uploading…"
            : phase.kind === "finalizing"
              ? "Checking video…"
              : phase.kind === "submitting"
                ? "Adding…"
                : "Find clips"}
        </Button>
      </div>
    </section>
  );
}

/**
 * Out of minutes: say so up front (and when they come back) instead of failing on submit.
 * Low on minutes: say how long a video can still be — YouTube lengths are only known later.
 */
function MinutesNote({ minutes, maxDurationMin }: { minutes: NewVideoCardProps["minutes"]; maxDurationMin: number }) {
  const resets = minutes.resetsOn ? ` on ${minutes.resetsOn}` : "";
  if (minutes.left <= 0) {
    return (
      <div role="status" className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 text-sm text-destructive">
        <CircleAlertIcon className="mt-0.5 size-4.5 shrink-0" />
        <span>
          You’ve used all {minutes.monthly} processing minutes for this month.{" "}
          {minutes.resetsOn ? `You can add new videos again${resets}.` : "New videos can’t be processed right now."}
        </span>
      </div>
    );
  }
  if (minutes.left >= maxDurationMin) return null;
  return (
    <div role="status" className="flex gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3.5 text-sm text-warning">
      <HourglassIcon className="mt-0.5 size-4.5 shrink-0" />
      <span>
        {minutes.left} {minutes.left === 1 ? "minute" : "minutes"} left this month
        {minutes.resetsOn ? ` (resets${resets})` : ""}. Videos longer than that won’t be processed.
      </span>
    </div>
  );
}

function SelectedFile({
  picked,
  phase,
  onClear,
  onCancel,
}: {
  picked: Picked;
  phase: Phase;
  onClear: () => void;
  onCancel: () => void;
}) {
  const { file, durationMs } = picked;
  const sent = phase.kind === "uploading" ? phase.sent : phase.kind === "finalizing" ? file.size : 0;
  const pct = Math.round((sent / file.size) * 100);

  let status = "Ready to upload";
  let slow = false;
  if (phase.kind === "uploading") {
    const { secondsLeft: left, bytesPerSec } = phase;
    const speed = bytesPerSec > 0 ? ` · ${formatSpeed(bytesPerSec)}` : "";
    status = `${formatBytes(sent)} of ${formatBytes(file.size)}${speed}${left != null ? ` · ${formatTimeLeft(left)} left` : ""}`;
    slow = bytesPerSec > 0 && bytesPerSec < SLOW_TRANSFER_BYTES_PER_SEC;
  } else if (phase.kind === "finalizing") {
    status = "Upload complete · checking the video…";
  }

  return (
    <div className="flex min-h-52 flex-col justify-center gap-5 rounded-xl border bg-sunken p-5 sm:p-6">
      <div className="flex items-center gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-raised text-primary">
          <FilmIcon className="size-5" strokeWidth={1.8} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-medium">{file.name}</span>
          <span className="font-mono text-[13px] text-subtle">
            {formatBytes(file.size)}
            {durationMs != null && ` · ${formatDuration(durationMs)}`}
          </span>
        </div>
        {phase.kind === "idle" ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Change
          </Button>
        ) : phase.kind === "uploading" ? (
          <Button variant="ghost" size="icon-sm" aria-label="Cancel upload" onClick={onCancel}>
            <XIcon />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <div
          role="progressbar"
          aria-label="Upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-2 overflow-hidden rounded-full bg-border"
        >
          <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between text-[13px] text-muted-foreground">
          <span>{status}</span>
          {phase.kind !== "idle" && <span className="font-mono">{pct}%</span>}
        </div>
        {slow && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-warning">
            <WifiLowIcon className="size-4 shrink-0" />
            Your connection is slow, so this upload will take a while. Keep this tab open until it finishes.
          </p>
        )}
      </div>
    </div>
  );
}
