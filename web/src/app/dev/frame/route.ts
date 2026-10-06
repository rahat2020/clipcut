import { notFound } from "next/navigation";

/**
 * DEVELOPMENT ONLY (404 in production): a made-up 1080×1920 "frame" for the cover editor
 * preview (/dev/workspace, /dev/cover) — no binary test images in the repo.
 */
export function GET(req: Request) {
  if (process.env.NODE_ENV === "production") notFound();
  const n = Number(new URL(req.url).searchParams.get("n") ?? "1") || 1;
  const hue = (n * 67) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,35%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},40%,15%)"/></linearGradient></defs>
  <rect width="1080" height="1920" fill="url(#g)"/>
  <circle cx="540" cy="820" r="260" fill="hsl(30,35%,62%)"/>
  <rect x="250" y="1080" width="580" height="840" rx="200" fill="hsl(${(hue + 180) % 360},30%,85%)"/>
</svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
}
