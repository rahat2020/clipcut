"use client";

import { Dialog } from "@base-ui/react/dialog";
import { DownloadIcon, ImageIcon, LoaderCircleIcon, SparklesIcon, XIcon } from "lucide-react";
import { Baloo_Da_2 } from "next/font/google";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  COVER_POSITIONS,
  COVER_SIZE,
  COVER_STYLES,
  COVER_ZOOM,
  coverPanRange,
  drawCover,
  type CoverPan,
  type CoverPosition,
  type CoverStyleId,
} from "@/lib/cover-draw";
import { cn } from "@/lib/utils";
import { coverHighlightIndices, coverWords, POST_COPY } from "@/shared/post-copy";

/** Thumbnail letters: round and heavy, Bangla + Latin. Loaded only when the editor draws. */
const coverFont = Baloo_Da_2({ subsets: ["bengali", "latin"], weight: "800", preload: false });

type LoadedImage = HTMLImageElement;

/** Baloo Da 2, then the page's Bangla font (next/font sets it as --font-hind) if it can't load. */
function coverFontFamily(): string {
  const hind = getComputedStyle(document.documentElement).getPropertyValue("--font-hind").trim();
  return `${coverFont.style.fontFamily}, ${hind || "'Hind Siliguri'"}, sans-serif`;
}

function loadImage(src: string): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // Cloudinary sends CORS headers; without this the canvas can't be saved.
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}

const clamp = (v: number) => Math.min(1, Math.max(-1, v));

const segment = (on: boolean) =>
  cn("h-8 rounded-md px-2.5 text-[13px] transition-colors", on ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground hover:text-foreground");

export type CoverOption = { text: string; highlight: string };

/** What the editor starts the words from, and the "Suggest words" request (Step 15.6). */
export type CoverWordsInput = {
  /** The AI's ideas (copy@3+); [] for older post text. */
  options: CoverOption[];
  /** Words to start with when there are no ideas (older cover text, or the title). */
  fallback: string;
  lang?: string;
  /** New words are being written. */
  pending: boolean;
  /** Asks the AI for new ideas for this clip; null = not offered. */
  suggest: { run: () => Promise<void>; disabledReason: string | null } | null;
};

/**
 * Cover editor (Step 15.5 / 15.6): pick one of the clip's clean frames, zoom in and move it,
 * put big words on it (one of the AI's ideas to start with, one word in a second colour),
 * choose a look and a place, download a 1080×1920 JPG. All drawn in the browser — nothing is
 * saved on our side.
 */
export function ClipCoverDialog({ frames, rank, words }: { frames: string[]; rank: number; words: CoverWordsInput }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={buttonVariants({ size: "sm", variant: "outline" })}>
        <ImageIcon />
        Cover
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 supports-backdrop-filter:backdrop-blur-xs" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-2xl border bg-card p-5 shadow-xl outline-none">
          <div className="flex items-center justify-between">
            <Dialog.Title className="font-heading text-lg font-semibold">Cover for clip {rank}</Dialog.Title>
            <Dialog.Close aria-label="Close" className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
              <XIcon />
            </Dialog.Close>
          </div>
          {open && <CoverEditor frames={frames} rank={rank} words={words} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** How the editor opens; only the dev preview sets it (screenshots of each look). */
export type CoverStart = { style?: CoverStyleId; position?: CoverPosition; zoom?: number; pan?: CoverPan };

type EditorProps = { frames: string[]; rank: number; words: CoverWordsInput; start?: CoverStart };

/** New AI ideas arriving start the words over (the editor remounts on them). */
export function CoverEditor(props: EditorProps) {
  return <Editor key={props.words.options.map((o) => o.text).join("|")} {...props} />;
}

function Editor({ frames, rank, words, start }: EditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const first = words.options[0];
  const [frame, setFrame] = useState(0);
  const [text, setText] = useState(first?.text ?? words.fallback);
  const [highlight, setHighlight] = useState(first?.highlight ?? "");
  const [style, setStyle] = useState<CoverStyleId>(start?.style ?? "white");
  const [position, setPosition] = useState<CoverPosition>(start?.position ?? "top");
  const [zoom, setZoom] = useState<number>(start?.zoom ?? COVER_ZOOM.min);
  const [pan, setPan] = useState<CoverPan>(start?.pan ?? { x: 0, y: 0 });
  const [punch, setPunch] = useState(true);
  const [image, setImage] = useState<{ src: string; img: LoadedImage | null; failed: boolean } | null>(null);
  const [fontReady, setFontReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);

  const src = frames[frame]!;
  const current = image?.src === src ? image : null;
  const list = coverWords(text);
  const lit = coverHighlightIndices(text, highlight);

  // Load the chosen frame (state is set from the promise, not synchronously in the effect).
  useEffect(() => {
    let alive = true;
    loadImage(src).then(
      (img) => alive && setImage({ src, img, failed: false }),
      () => alive && setImage({ src, img: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [src]);

  // The font must be loaded before the canvas uses it, or the first draw falls back.
  useEffect(() => {
    let alive = true;
    document.fonts
      .load(`800 100px ${coverFontFamily()}`, "অআক Ab")
      .catch(() => [])
      .then(() => alive && setFontReady(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !fontReady) return;
    const highlighted = coverHighlightIndices(text, highlight);
    drawCover(ctx, { image: current?.img ?? null, text, highlight: highlighted, style, position, fontFamily: coverFontFamily(), zoom, pan, punch });
  }, [current, text, highlight, style, position, fontReady, zoom, pan, punch]);

  function pickOption(o: CoverOption) {
    setText(o.text);
    setHighlight(o.highlight);
  }

  function toggleWord(i: number) {
    const next = new Set(lit);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setHighlight(list.filter((_, j) => next.has(j)).join(" "));
  }

  // Dragging moves the zoomed frame (pointer capture keeps the drag going outside the preview).
  const range = current?.img ? coverPanRange(current.img, zoom) : { x: 0, y: 0 };
  const canMove = range.x > 0 || range.y > 0;
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!canMove) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const toCover = COVER_SIZE.width / e.currentTarget.getBoundingClientRect().width;
    const dx = (e.clientX - drag.current.x) * toCover;
    const dy = (e.clientY - drag.current.y) * toCover;
    drag.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: range.x ? clamp(p.x + dx / range.x) : 0, y: range.y ? clamp(p.y + dy / range.y) : 0 }));
  }
  const endDrag = () => {
    drag.current = null;
  };

  async function suggest() {
    if (!words.suggest) return;
    setAsking(true);
    try {
      await words.suggest.run();
    } finally {
      setAsking(false);
    }
  }

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    try {
      canvas.toBlob(
        (blob) => {
          setSaving(false);
          if (!blob) return toast.error("Couldn’t make the image. Try another frame.");
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `clip-${rank}-cover.jpg`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        },
        "image/jpeg",
        0.92,
      );
    } catch {
      setSaving(false);
      toast.error("Couldn’t make the image. Try another frame.");
    }
  }

  const writing = words.pending || asking;
  return (
    <div className="flex flex-col gap-5 sm:flex-row">
      <div className="flex shrink-0 flex-col gap-2">
        <div
          className={cn("relative mx-auto w-[min(15rem,60vw)] touch-none overflow-hidden rounded-xl border bg-black select-none", canMove && "cursor-grab active:cursor-grabbing")}
          style={{ aspectRatio: "9 / 16" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <canvas ref={canvasRef} width={COVER_SIZE.width} height={COVER_SIZE.height} className="size-full" aria-label="Cover preview" />
          {(!current || !fontReady) && (
            <div className="absolute inset-0 flex items-center justify-center text-subtle">
              {current?.failed ? <span className="px-4 text-center text-xs">This frame couldn’t be loaded.</span> : <LoaderCircleIcon className="animate-spin" />}
            </div>
          )}
        </div>
        <p className="text-center text-xs text-subtle">{canMove ? "Drag the picture to move it" : "Zoom in to move the picture"}</p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-xs text-subtle">Frame</span>
          <div className="flex flex-wrap gap-2">
            {frames.map((f, i) => (
              <button
                key={f}
                type="button"
                aria-label={`Frame ${i + 1}`}
                aria-pressed={frame === i}
                onClick={() => setFrame(i)}
                className={cn("h-20 w-[45px] overflow-hidden rounded-md border-2 transition-colors", frame === i ? "border-primary" : "border-transparent opacity-70 hover:opacity-100")}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- signed private frames, not worth the image optimizer */}
                <img src={f} alt="" className="size-full object-cover" />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex flex-1 items-center gap-2 text-xs text-subtle">
              Zoom
              <input
                type="range"
                min={COVER_ZOOM.min}
                max={COVER_ZOOM.max}
                step={0.05}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="min-w-24 flex-1 accent-primary"
                aria-label="Zoom"
              />
            </label>
            <div className="flex w-fit gap-1 rounded-[10px] border bg-background p-1">
              <button type="button" aria-pressed={punch} onClick={() => setPunch((p) => !p)} className={segment(punch)} title="Stronger colours and darker edges">
                Punch
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex min-h-7 items-center justify-between gap-2">
            <span className="text-xs text-subtle">Words on the cover</span>
            {words.suggest && (
              <Button
                size="sm"
                variant="ghost"
                disabled={writing || !!words.suggest.disabledReason}
                title={words.suggest.disabledReason ?? undefined}
                onClick={suggest}
              >
                {writing ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
                {writing ? "Writing ideas…" : words.options.length > 0 ? "New ideas" : "Suggest words"}
              </Button>
            )}
          </div>
          {words.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {words.options.map((o) => {
                const on = coverHighlightIndices(o.text, o.highlight);
                return (
                  <button
                    key={o.text}
                    type="button"
                    lang={words.lang}
                    aria-pressed={text === o.text}
                    onClick={() => pickOption(o)}
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-[13px] transition-colors",
                      text === o.text ? "border-primary bg-primary/10" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {coverWords(o.text).map((w, i) => (
                      <span key={i} className={on.includes(i) ? "font-semibold text-primary" : undefined}>
                        {i > 0 ? " " : ""}
                        {w}
                      </span>
                    ))}
                  </button>
                );
              })}
            </div>
          )}
          <Input lang={words.lang} value={text} maxLength={POST_COPY.coverTextMaxChars * 2} onChange={(e) => setText(e.target.value)} placeholder="2–5 big words" className="h-9" />
          {list.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-subtle">Second colour:</span>
              {list.map((w, i) => (
                <button
                  key={`${i}:${w}`}
                  type="button"
                  lang={words.lang}
                  aria-pressed={lit.includes(i)}
                  onClick={() => toggleWord(i)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs transition-colors",
                    lit.includes(i) ? "border-primary bg-primary/15 font-semibold text-primary" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {w}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-3">
          <div className="flex flex-col gap-2">
            <span className="text-xs text-subtle">Look</span>
            <div className="flex w-fit flex-wrap gap-1 rounded-[10px] border bg-background p-1">
              {(Object.keys(COVER_STYLES) as CoverStyleId[]).map((s) => (
                <button key={s} type="button" aria-pressed={style === s} onClick={() => setStyle(s)} className={segment(style === s)}>
                  {COVER_STYLES[s].label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-subtle">Place</span>
            <div className="flex w-fit gap-1 rounded-[10px] border bg-background p-1">
              {(Object.keys(COVER_POSITIONS) as CoverPosition[]).map((p) => (
                <button key={p} type="button" aria-pressed={position === p} onClick={() => setPosition(p)} className={segment(position === p)}>
                  {COVER_POSITIONS[p]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-subtle">
          Use it as the cover on Reels and TikTok. YouTube Shorts mostly picks a frame from the video itself.
        </p>
        <div className="mt-auto flex justify-end">
          <Button onClick={download} disabled={!current?.img || !fontReady || saving}>
            {saving ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon />}
            Download cover
          </Button>
        </div>
      </div>
    </div>
  );
}
