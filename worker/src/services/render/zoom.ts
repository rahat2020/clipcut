import type { Phrase } from "./captions";

/**
 * Auto zoom (render@3): a quick punch-in at the start of the clip, and a slow push on lines
 * that carry the clip's key words. Phrase-level timing is enough here — a push that starts
 * 0.3 s early doesn't look wrong (word times are estimates for Bangla, D42).
 *
 * Done in ffmpeg as a per-frame `scale` (eval=frame) of the cropped source followed by a
 * fixed-size `crop`, so the zoom costs one scale like before: measured +7–9 % encode time on a
 * 20 s 1080×1920 clip (2026-10-07). The zoom centre sits at 42 % of the height, where a
 * speaker's face usually is in a vertical crop.
 */

export const ZOOM_RULES = {
  /** The first frame is this much bigger and eases back to 1 over `punchMs`. */
  punchFrom: 1.12,
  punchMs: 500,
  /** A key line pushes in to this… */
  push: 1.08,
  /** …easing in and out over this. */
  rampMs: 250,
  /** No push in the hook (the punch is there) … */
  notBeforeMs: 2_500,
  /** … at least this far apart … */
  minGapMs: 4_000,
  /** … and at most one per this much clip. */
  everyMs: 5_000,
  /** A push lasts its line, within these bounds. */
  minMs: 800,
  maxMs: 2_500,
  centreY: 0.42,
};

export type ZoomWindow = { startMs: number; endMs: number };

/** Which lines get a push: those with an emphasised word, spread out, never in the hook. */
export function zoomPlan(phrases: readonly Phrase[], durationMs: number, rules = ZOOM_RULES): ZoomWindow[] {
  const max = Math.floor(durationMs / rules.everyMs);
  const out: ZoomWindow[] = [];
  for (const p of phrases) {
    if (out.length >= max) break;
    if (p.startMs < rules.notBeforeMs || !p.words.some((w) => w.emphasis)) continue;
    const last = out.at(-1);
    if (last && p.startMs - last.endMs < rules.minGapMs) continue;
    const endMs = Math.min(p.startMs + Math.min(Math.max(p.endMs - p.startMs, rules.minMs), rules.maxMs), durationMs);
    if (endMs - p.startMs < rules.rampMs * 2) continue;
    out.push({ startMs: p.startMs, endMs });
  }
  return out;
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

/** The zoom factor as an ffmpeg expression of `t` (seconds from the clip start). */
export function zoomExpression(windows: readonly ZoomWindow[], rules = ZOOM_RULES): string {
  const terms = [`1`, `${(rules.punchFrom - 1).toFixed(3)}*pow(max(0,1-t/${sec(rules.punchMs)}),2)`];
  const ramp = sec(rules.rampMs);
  for (const w of windows) {
    terms.push(`${(rules.push - 1).toFixed(3)}*clip(min((t-${sec(w.startMs)})/${ramp},(${sec(w.endMs)}-t)/${ramp}),0,1)`);
  }
  return terms.join("+");
}

/**
 * Replaces the plain `scale=W:H` after the crop: scale the cropped frame to W·z × H·z (even
 * sizes), then cut W×H back out around the zoom centre.
 */
export function zoomFilters(width: number, height: number, windows: readonly ZoomWindow[], rules = ZOOM_RULES): string[] {
  const z = zoomExpression(windows, rules);
  return [
    `scale=w='trunc(${width}*(${z})/2)*2':h='trunc(${height}*(${z})/2)*2':eval=frame:flags=lanczos`,
    `crop=${width}:${height}:x='(iw-${width})/2':y='(ih-${height})*${rules.centreY}'`,
  ];
}
