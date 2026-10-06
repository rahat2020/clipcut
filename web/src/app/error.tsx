"use client";

import { ErrorCard } from "@/components/app/error-card";

/** Any other page threw (landing, sign-in, admin): same card, no app shell. */
export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col">
      <ErrorCard {...props} />
    </main>
  );
}
