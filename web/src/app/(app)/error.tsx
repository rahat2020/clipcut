"use client";

import { ErrorCard } from "@/components/app/error-card";

/** A signed-in page threw: the card appears inside the app shell, the sidebar stays. */
export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorCard {...props} />;
}
