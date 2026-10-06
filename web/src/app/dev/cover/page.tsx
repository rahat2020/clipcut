import type { Metadata } from "next";
import { notFound } from "next/navigation";

import type { CoverStart } from "@/components/app/clip-cover";

import { CoverPreviewEditor } from "./preview";

export const metadata: Metadata = { title: "Cover preview (dev)", robots: { index: false, follow: false } };

/** DEVELOPMENT ONLY (404 in production): the cover editor with made-up frames, for screenshots. ?text=… (no AI ideas) &style=redBox &pos=bottom &zoom=1.5 &panY=-1 */
export default async function CoverPreview({ searchParams }: PageProps<"/dev/cover">) {
  if (process.env.NODE_ENV === "production") notFound();
  const q = await searchParams;
  const text = typeof q.text === "string" ? q.text : null;
  const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
  const start = {
    style: one("style") as CoverStart["style"],
    position: one("pos") as CoverStart["position"],
    zoom: one("zoom") ? Number(one("zoom")) : undefined,
    pan: { x: Number(one("panX") ?? 0), y: Number(one("panY") ?? 0) },
  };
  const options = text
    ? []
    : [
        { text: "ফাহানের প্রথম গোল!", highlight: "প্রথম" },
        { text: "গোলের ক্ষুধা মেটেনি!", highlight: "ক্ষুধা" },
        { text: "সাফে কী হবে?", highlight: "সাফে" },
      ];
  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <CoverPreviewEditor options={options} fallback={text ?? ""} lang={text && /[a-z]/i.test(text) ? undefined : "bn"} start={start} />
    </main>
  );
}
