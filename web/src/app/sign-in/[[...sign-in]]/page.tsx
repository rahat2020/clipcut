import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";

import { AuthShell } from "@/components/brand/auth-shell";
import { ROUTES } from "@/lib/routes";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <AuthShell>
      <SignIn path={ROUTES.signIn} signUpUrl={ROUTES.signUp} />
    </AuthShell>
  );
}
