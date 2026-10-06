import type { ReactNode } from "react";

import { Logo } from "./logo";

/** Centered frame for sign-in, sign-up and the blocked page. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-12">
      <Logo />
      {children}
    </main>
  );
}
