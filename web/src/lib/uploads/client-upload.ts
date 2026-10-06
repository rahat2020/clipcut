/**
 * Browser side of the upload: read the file's length, ask our API for a signed ticket,
 * send the file to Cloudinary in chunks (with progress, retries and cancel), then tell
 * our API to create the video. Runs in the browser only.
 */
import type { UploadTicket } from "./cloudinary-core";
import type { FinalizeUploadInput, RequestUploadInput, SubmitYouTubeInput } from "../videos/schemas";

/** An error with a message that is safe to show as-is. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly code: string = "UPLOAD_FAILED",
  ) {
    super(message);
    this.name = "UploadError";
  }
}

const CHUNK_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_500, 4_000];

/** The video's length from its metadata, or null if the browser can't read this format. */
export function readVideoDuration(file: File, timeoutMs = 8_000): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const done = (ms: number | null) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new UploadError("Can't reach the server. Check your connection and try again.", "NETWORK");
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
  if (!res.ok) {
    throw new UploadError(json?.error?.message ?? "Something went wrong. Please try again.", json?.error?.code);
  }
  return json as T;
}

export function requestUploadTicket(input: RequestUploadInput): Promise<UploadTicket> {
  return postJson<{ ticket: UploadTicket }>("/api/uploads", input).then((r) => r.ticket);
}

export function finalizeUpload(input: FinalizeUploadInput): Promise<{ id: string; status: string }> {
  return postJson<{ video: { id: string; status: string } }>("/api/videos", input).then((r) => r.video);
}

export function submitYouTube(input: SubmitYouTubeInput): Promise<{ id: string; status: string }> {
  return postJson<{ video: { id: string; status: string } }>("/api/videos/youtube", input).then((r) => r.video);
}

function sendChunk(args: {
  ticket: UploadTicket;
  blob: Blob;
  start: number;
  total: number;
  fileName: string;
  signal?: AbortSignal;
  onChunkProgress: (loaded: number) => void;
}): Promise<unknown> {
  const { ticket, blob, start, total, signal } = args;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", ticket.uploadUrl);
    xhr.setRequestHeader("X-Unique-Upload-Id", ticket.videoId);
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${start + blob.size - 1}/${total}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => args.onChunkProgress(Math.min(e.loaded, blob.size));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new UploadError(`Upload failed (HTTP ${xhr.status}).`, xhr.status >= 500 ? "RETRYABLE" : "UPLOAD_REJECTED"));
    };
    xhr.onerror = () => reject(new UploadError("Network error while uploading.", "RETRYABLE"));
    xhr.onabort = () => reject(new UploadError("Upload canceled.", "CANCELED"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.fields)) form.append(k, v);
    form.append("file", blob, args.fileName);
    xhr.send(form);
  });
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new UploadError("Upload canceled.", "CANCELED"));
    });
  });
}

/**
 * Sends the file to Cloudinary in `ticket.chunkBytes` pieces. A failed piece is retried
 * (network errors and 5xx only) before giving up. `onProgress` gets bytes sent so far.
 */
export async function uploadToCloudinary(args: {
  ticket: UploadTicket;
  file: File;
  onProgress: (sentBytes: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { ticket, file, signal } = args;
  if (new Date(ticket.expiresAt) <= new Date()) throw new UploadError("The upload link expired. Please try again.");

  for (let start = 0; start < file.size; start += ticket.chunkBytes) {
    const blob = file.slice(start, Math.min(start + ticket.chunkBytes, file.size));
    for (let attempt = 1; ; attempt++) {
      try {
        await sendChunk({
          ticket,
          blob,
          start,
          total: file.size,
          fileName: file.name,
          signal,
          onChunkProgress: (loaded) => args.onProgress(start + loaded),
        });
        break;
      } catch (err) {
        const retryable = err instanceof UploadError && err.code === "RETRYABLE";
        if (!retryable || attempt >= CHUNK_ATTEMPTS) {
          if (err instanceof UploadError && err.code === "CANCELED") throw err;
          throw new UploadError("The upload didn't go through. Check your connection and try again.");
        }
        await wait(RETRY_DELAYS_MS[attempt - 1] ?? 4_000, signal);
      }
    }
  }
  args.onProgress(file.size);
}
