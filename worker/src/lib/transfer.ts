/**
 * Download speed and time left, from a stream of "bytes so far" readings. Speed is the
 * average over the last few seconds, so a brief stall or burst doesn't swing the
 * estimate wildly, but a lasting slowdown shows up within seconds.
 */
export type TransferStats = {
  doneBytes: number;
  totalBytes: number | null;
  /** 0 until there's enough data to say. */
  bytesPerSec: number;
  /** Null while unknown (no total, or no speed yet). */
  etaSec: number | null;
};

const WINDOW_MS = 8_000;
const MIN_SPAN_MS = 1_500;

export class TransferMeter {
  private samples: { t: number; bytes: number }[] = [];

  update(doneBytes: number, totalBytes: number | null, now = Date.now()): TransferStats {
    const last = this.samples.at(-1);
    if (last && doneBytes < last.bytes) this.samples = []; // a new file/stream started
    this.samples.push({ t: now, bytes: doneBytes });
    while (this.samples.length > 2 && now - this.samples[0]!.t > WINDOW_MS) this.samples.shift();

    const first = this.samples[0]!;
    const span = now - first.t;
    const bytesPerSec = span >= MIN_SPAN_MS ? Math.max(0, ((doneBytes - first.bytes) * 1000) / span) : 0;
    const total = totalBytes && totalBytes > 0 ? totalBytes : null;
    const etaSec = total && bytesPerSec > 0 ? Math.ceil(Math.max(total - doneBytes, 0) / bytesPerSec) : null;
    return { doneBytes, totalBytes: total, bytesPerSec: Math.round(bytesPerSec), etaSec };
  }
}
