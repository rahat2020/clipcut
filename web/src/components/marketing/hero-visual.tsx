import type { CSSProperties } from "react";

/**
 * Landing hero: a long video's timeline with three picked moments turning into 9:16 clips.
 * Pure markup — no images to load. Positions are fixed px inside a 576×680 box.
 */

const BAR_COUNT = 86;
const HOT_RANGES: [number, number][] = [
  [7, 13],
  [32, 39],
  [57, 63],
];
const BARS = Array.from({ length: BAR_COUNT }, (_, i) => ({
  h: 6 + Math.round(Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.37)) * 26),
  hot: HOT_RANGES.some(([a, b]) => i >= a && i <= b),
}));

const SCENES = [
  "radial-gradient(120% 90% at 50% 25%, #3e3228 0%, #1a1613 75%)",
  "radial-gradient(120% 90% at 50% 25%, #2e3a36 0%, #141a18 75%)",
  "radial-gradient(120% 90% at 50% 25%, #2f3242 0%, #15161d 75%)",
];

const CLIPS: { style: CSSProperties; score: number; words: [string, string, string] }[] = [
  { style: { left: 80, top: 424, transform: "rotate(-5deg)", zIndex: 1, background: SCENES[0] }, score: 94, words: ["Everyone thinks", "money", "comes first"] },
  { style: { left: 230, top: 400, zIndex: 3, background: SCENES[1] }, score: 91, words: ["Find your", "first", "customer early"] },
  { style: { left: 380, top: 424, transform: "rotate(5deg)", zIndex: 2, background: SCENES[2] }, score: 88, words: ["Failure", "teaches", "you the most"] },
];

/** Talking-head silhouette used as a stand-in for real video frames. */
export function Silhouette({ wide = false }: { wide?: boolean }) {
  return wide ? (
    <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMax meet" className="absolute inset-0 size-full" aria-hidden="true">
      <circle cx="72" cy="42" r="12" fill="#4a4037" />
      <path d="M48 90c0-18 11-30 24-30s24 12 24 30z" fill="#4a4037" />
    </svg>
  ) : (
    <svg viewBox="0 0 90 160" preserveAspectRatio="xMidYMax meet" className="absolute inset-0 size-full" aria-hidden="true">
      <circle cx="45" cy="64" r="17" fill="#4a4037" />
      <path d="M8 160c0-32 17-52 37-52s37 20 37 52z" fill="#4a4037" />
    </svg>
  );
}

export function HeroVisual() {
  return (
    <div className="relative h-[680px] w-[576px] shrink-0" aria-hidden="true">
      <div
        className="absolute top-0 left-0 h-[304px] w-[540px] overflow-hidden rounded-2xl border"
        style={{ background: "radial-gradient(120% 90% at 40% 25%, #3e3228 0%, #1a1613 72%)" }}
      >
        <Silhouette wide />
        <div className="absolute top-4 left-4 flex gap-2 font-mono text-xs text-foreground/80">
          <span className="rounded-md bg-background/70 px-2 py-1">podcast-ep12.mp4</span>
          <span className="rounded-md bg-background/70 px-2 py-1">48:12</span>
        </div>
      </div>

      <div className="absolute top-[322px] left-0 flex h-12 w-[540px] items-center gap-[3px] rounded-[10px] border bg-card px-2.5">
        {BARS.map((b, i) => (
          <span key={i} className={b.hot ? "w-[3px] shrink-0 rounded-sm bg-primary" : "w-[3px] shrink-0 rounded-sm bg-[#4a4540]"} style={{ height: b.h }} />
        ))}
      </div>
      {[
        [47, 44],
        [197, 52],
        [347, 44],
      ].map(([left, width]) => (
        <div key={left} className="absolute top-[316px] h-[60px] rounded-lg border-2 border-primary" style={{ left, width }} />
      ))}
      <div className="absolute top-[382px] left-0 flex w-[540px] justify-between font-mono text-[11px] text-subtle">
        <span>00:00</span>
        <span>12:00</span>
        <span>24:00</span>
        <span>36:00</span>
        <span>48:12</span>
      </div>

      <svg width="576" height="120" viewBox="0 0 576 120" className="absolute top-[376px] left-0 text-primary">
        {["M69 0 C69 60, 150 50, 150 112", "M223 0 C223 50, 300 60, 300 104", "M369 0 C369 60, 450 50, 450 112"].map((d) => (
          <path key={d} d={d} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="4 5" />
        ))}
      </svg>

      {CLIPS.map((c) => (
        <div
          key={c.score}
          className="absolute h-[248px] w-[140px] overflow-hidden rounded-[18px] border border-line-strong shadow-[0_24px_48px_rgba(0,0,0,0.5)]"
          style={c.style}
        >
          <Silhouette />
          <span className="absolute top-2.5 left-2.5 rounded-md bg-background/80 px-1.5 py-0.5 font-mono text-[11px] text-primary">
            {c.score}
          </span>
          <p className="absolute inset-x-2.5 bottom-14 text-center text-[17px] leading-tight font-bold text-white [text-shadow:0_2px_0_#000,0_0_6px_rgba(0,0,0,0.9)]">
            {c.words[0]} <span className="text-primary">{c.words[1]}</span> {c.words[2]}
          </p>
        </div>
      ))}
    </div>
  );
}
