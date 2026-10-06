/**
 * YouTube link → 11-character video id. Pure and client-safe: the form uses it for
 * instant feedback, the API uses it again (never trusting the browser's answer).
 *
 * Accepts watch, youtu.be, shorts, live, embed and mobile/music links. Anything else
 * (channels, playlists without a video, other sites) is rejected.
 */
const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export function parseYouTubeUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw || raw.length > 500) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  let id: string | null | undefined = null;
  if (host === "youtu.be") {
    id = parts[0];
  } else if (HOSTS.has(host)) {
    if (parts[0] === "watch") id = url.searchParams.get("v");
    else if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "")) id = parts[1];
  }
  return id && ID.test(id) ? id : null;
}

/** The one URL form we store and hand to the worker. */
export function canonicalYouTubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}
