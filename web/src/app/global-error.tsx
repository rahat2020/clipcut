"use client";

import "./globals.css";

/**
 * Last resort: the root layout itself failed (fonts, Clerk, the provider tree), so none of the
 * app's components can be trusted here. Plain markup with the theme's colours only.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="flex min-h-full items-center justify-center bg-background p-6 text-foreground">
        <div role="alert" className="flex max-w-md flex-col items-center gap-4 rounded-2xl border bg-card px-8 py-10 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
          <p className="leading-relaxed text-muted-foreground">
            ClipCut hit a problem on our side. Your videos and clips are safe. Try again in a moment.
          </p>
          <button type="button" onClick={reset} className="h-9 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground">
            Try again
          </button>
          {error.digest && <p className="text-xs text-subtle">Reference: {error.digest}</p>}
        </div>
      </body>
    </html>
  );
}
