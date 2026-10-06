/**
 * Draws a clip's cover image (Step 15.5, v2 in 15.6): a clean frame of the clip with big words
 * on it, the way Bangladeshi creators make thumbnails — one key word in a second colour, the
 * face zoomed in, colours a little punchier. Runs in the browser on a <canvas>, so the text is
 * shaped by the browser (Bangla যুক্তাক্ষর come out right) and changes show at once — no
 * server round trip. Client-only.
 *
 * The colours below are colours OF THE IMAGE people post, not UI colours, so they don't come
 * from the app's theme tokens.
 */

import { coverWords } from "@/shared/post-copy";

export const COVER_SIZE = { width: 1080, height: 1920 } as const;

/** `fill` = the words, `accent` = the highlighted word(s), `box` = a band behind each line. */
export const COVER_STYLES = {
  yellow: { label: "Yellow", fill: "#FFD60A", accent: "#FFFFFF", stroke: "#000000", box: null },
  white: { label: "White", fill: "#FFFFFF", accent: "#FFD60A", stroke: "#000000", box: null },
  redBox: { label: "Red box", fill: "#FFFFFF", accent: "#FFD60A", stroke: null, box: "#E5232D" },
  yellowBox: { label: "Yellow box", fill: "#111111", accent: "#E5232D", stroke: null, box: "#FFD60A" },
} as const;
export type CoverStyleId = keyof typeof COVER_STYLES;

export const COVER_POSITIONS = { top: "Top", middle: "Middle", bottom: "Bottom" } as const;
export type CoverPosition = keyof typeof COVER_POSITIONS;

export const COVER_ZOOM = { min: 1, max: 1.8 } as const;

/** Where the frame sits when zoomed in: -1…1 on each axis, 0 = centred. */
export type CoverPan = { x: number; y: number };

const WEIGHT = 800;
const MAX_LINES = 3;
const MAX_TEXT_WIDTH = 960;
const START_SIZE = 160;
const MIN_SIZE = 64;
/** Two lines when that still reads big (≥ TWO_LINE_MIN), else up to MAX_LINES. */
const TWO_LINE_MIN = 112;
/** Contrast / colour lift of "Punch" (ignored by browsers without canvas filters). */
const PUNCH_FILTER = "contrast(1.12) saturate(1.28) brightness(1.04)";

type Img = CanvasImageSource & { width: number; height: number };

/** Word indices → lines no wider than the limit (a single long word gets its own line). */
function wrap(ctx: CanvasRenderingContext2D, words: string[]): number[][] {
  const lines: number[][] = [];
  for (const [i, word] of words.entries()) {
    const last = lines.at(-1);
    const joined = last && [...last.map((j) => words[j]), word].join(" ");
    if (last && joined && ctx.measureText(joined).width <= MAX_TEXT_WIDTH) last.push(i);
    else lines.push([i]);
  }
  return lines;
}

const lineText = (words: string[], line: number[]) => line.map((i) => words[i]).join(" ");

/** Biggest size where the text fits: two lines preferred (more lines cover the face). */
function fit(ctx: CanvasRenderingContext2D, words: string[], family: string): { size: number; lines: number[][] } {
  for (const [maxLines, minSize] of [
    [2, TWO_LINE_MIN],
    [MAX_LINES, MIN_SIZE],
  ] as const) {
    for (let size = START_SIZE; size >= minSize; size -= 6) {
      ctx.font = `${WEIGHT} ${size}px ${family}`;
      const lines = wrap(ctx, words);
      if (lines.length <= maxLines && lines.every((l) => ctx.measureText(lineText(words, l)).width <= MAX_TEXT_WIDTH)) return { size, lines };
    }
  }
  ctx.font = `${WEIGHT} ${MIN_SIZE}px ${family}`;
  return { size: MIN_SIZE, lines: wrap(ctx, words).slice(0, MAX_LINES) };
}

/** How far (cover pixels) the zoomed frame can move each way from the centre. */
export function coverPanRange(img: { width: number; height: number }, zoom: number): { x: number; y: number } {
  const { width: W, height: H } = COVER_SIZE;
  const scale = Math.max(W / img.width, H / img.height) * zoom;
  return { x: Math.max(0, (img.width * scale - W) / 2), y: Math.max(0, (img.height * scale - H) / 2) };
}

/** The frame fills the cover (centre crop if its shape differs), zoomed and moved. */
function drawFrame(ctx: CanvasRenderingContext2D, img: Img, zoom: number, pan: CoverPan, punch: boolean) {
  const { width: W, height: H } = COVER_SIZE;
  const scale = Math.max(W / img.width, H / img.height) * zoom;
  const w = img.width * scale;
  const h = img.height * scale;
  const range = coverPanRange(img, zoom);
  ctx.save();
  if (punch) ctx.filter = PUNCH_FILTER;
  ctx.drawImage(img, (W - w) / 2 + pan.x * range.x, (H - h) / 2 + pan.y * range.y, w, h);
  ctx.restore();
  if (punch) {
    // Darker edges pull the eye to the middle.
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.72);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.42)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }
}

export type CoverArgs = {
  image: Img | null;
  text: string;
  /** Indices into `coverWords(text)` shown in the accent colour. */
  highlight: readonly number[];
  style: CoverStyleId;
  position: CoverPosition;
  fontFamily: string;
  zoom: number;
  pan: CoverPan;
  punch: boolean;
};

export function drawCover(ctx: CanvasRenderingContext2D, args: CoverArgs): void {
  const { width: W, height: H } = COVER_SIZE;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  if (args.image) drawFrame(ctx, args.image, args.zoom, args.pan, args.punch);

  const words = coverWords(args.text.trim());
  if (words.length === 0) return;
  const lit = new Set(args.highlight);
  const style = COVER_STYLES[args.style];
  const { size, lines } = fit(ctx, words, args.fontFamily);
  const lineHeight = Math.round(size * 1.28);
  const blockHeight = lineHeight * lines.length;
  // Kept clear of the platforms' buttons at the bottom of Reels / TikTok / Shorts.
  const top = args.position === "top" ? 230 : args.position === "middle" ? (H - blockHeight) / 2 : H - 520 - blockHeight;

  // A soft dark band behind the words so they read on any frame.
  if (!style.box) {
    const pad = lineHeight;
    const g = ctx.createLinearGradient(0, top - pad, 0, top + blockHeight + pad);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.5, "rgba(0,0,0,0.45)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, top - pad, W, blockHeight + pad * 2);
  }

  ctx.font = `${WEIGHT} ${size}px ${args.fontFamily}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const space = ctx.measureText(" ").width;
  for (const [n, line] of lines.entries()) {
    const y = top + lineHeight * n + lineHeight / 2;
    // Word by word, so one word can take the accent colour; spaces keep the browser's own width.
    const widths = line.map((i) => ctx.measureText(words[i]!).width);
    const total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
    const xs = widths.map((_, k) => (W - total) / 2 + widths.slice(0, k).reduce((a, b) => a + b, 0) + space * k);
    if (style.box) {
      const w = total + size * 0.6;
      ctx.fillStyle = style.box;
      ctx.beginPath();
      ctx.roundRect((W - w) / 2, y - lineHeight / 2 + 6, w, lineHeight - 12, size * 0.18);
      ctx.fill();
    }
    if (style.stroke) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = Math.round(size * 0.16);
      for (const [k, i] of line.entries()) ctx.strokeText(words[i]!, xs[k]!, y);
    }
    for (const [k, i] of line.entries()) {
      ctx.fillStyle = lit.has(i) ? style.accent : style.fill;
      ctx.fillText(words[i]!, xs[k]!, y);
    }
  }
}
