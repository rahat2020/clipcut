import { notFound } from "next/navigation";

/** DEVELOPMENT ONLY (404 in production): throws on purpose, to see the error page (app/error.tsx). */
export default function Crash(): never {
  if (process.env.NODE_ENV === "production") notFound();
  throw new Error("Deliberate crash from /dev/crash — the error page should appear instead");
}
