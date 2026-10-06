import { SignUp } from "@clerk/nextjs";
import type { Metadata } from "next";

import { AuthShell } from "@/components/brand/auth-shell";
import { ROUTES } from "@/lib/routes";

export const metadata: Metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <AuthShell>
      <SignUp path={ROUTES.signUp} signInUrl={ROUTES.signIn} />
    </AuthShell>
  );
}
