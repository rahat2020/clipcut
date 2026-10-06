"use client";

import { CoverEditor, type CoverOption, type CoverStart } from "@/components/app/clip-cover";

/** The editor with a pretend "Suggest words" (functions can't cross from the server page). */
export function CoverPreviewEditor({ options, fallback, lang, start }: { options: CoverOption[]; fallback: string; lang?: string; start: CoverStart }) {
  return (
    <CoverEditor
      frames={[1, 2, 3, 4, 5, 6].map((n) => `/dev/frame?n=${n}`)}
      rank={1}
      start={start}
      words={{ options, fallback, lang, pending: false, suggest: { run: async () => {}, disabledReason: null } }}
    />
  );
}
