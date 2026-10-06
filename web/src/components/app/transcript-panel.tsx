import { FileTextIcon } from "lucide-react";

import { formatDuration } from "@/lib/format";
import type { Language } from "@/shared/enums";

export type TranscriptSegmentView = { startMs: number; endMs: number; text: string };

export type TranscriptView = {
  language: Language;
  model: string | null;
  wordCount: number;
  segments: TranscriptSegmentView[];
};

/**
 * The video's transcript, one timed line per Whisper segment. Server-rendered (it changes
 * only when processing moves on, and the page refreshes itself then). Text is the user's
 * content, so it carries `lang` for the Bangla font and line height.
 */
export function TranscriptPanel({ transcript, pendingNote }: { transcript: TranscriptView | null; pendingNote: string }) {
  return (
    <section aria-labelledby="transcript-title" className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex h-12 items-center justify-between gap-3 border-b px-5">
        <h2 id="transcript-title" className="text-sm font-medium">
          Transcript
        </h2>
        {transcript && (
          <span className="text-xs text-subtle">
            {transcript.wordCount.toLocaleString("en-US")} words · {transcript.segments.length} lines
          </span>
        )}
      </div>

      {transcript ? (
        <ol className="max-h-120 overflow-y-auto px-2 py-2" lang={transcript.language}>
          {transcript.segments.map((s) => (
            <li key={`${s.startMs}-${s.endMs}`} className="flex gap-4 rounded-lg px-3 py-2 hover:bg-raised">
              <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-xs text-subtle">{formatDuration(s.startMs)}</span>
              <span className="min-w-0 flex-1 text-[15px] leading-relaxed text-foreground/90">{s.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex items-center gap-3 px-5 py-8 text-sm text-subtle">
          <FileTextIcon className="size-5 shrink-0" strokeWidth={1.8} />
          {pendingNote}
        </div>
      )}
    </section>
  );
}
