import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono, Hind_Siliguri } from "next/font/google";

import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BRAND_NAME } from "@/lib/brand";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { ROUTES } from "@/lib/routes";

import "./globals.css";

// Fonts (docs/DESIGN.md): Geist for UI text, Bricolage Grotesque for headings,
// Geist Mono for timecodes, Hind Siliguri as the fallback for Bangla user content.
const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"] });
const hind = Hind_Siliguri({
  variable: "--font-hind",
  subsets: ["bengali", "latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  // Pages set a short title ("Home"); the template adds the product name.
  title: { default: BRAND_NAME, template: `%s · ${BRAND_NAME}` },
  description: "Turn one long video into ready-to-post short clips with captions that render Bangla and English correctly.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geist.variable} ${geistMono.variable} ${bricolage.variable} ${hind.variable} h-full antialiased`}
    >
      {/* Browser extensions (e.g. ColorZilla's cz-shortcut-listen) add attributes to <body>
          before React loads; don't report that as a hydration error. Children are still checked. */}
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        {/* Clerk Core 3: the provider goes inside <body>, not around <html>. */}
        <ClerkProvider
          appearance={clerkAppearance}
          signInUrl={ROUTES.signIn}
          signUpUrl={ROUTES.signUp}
          signInFallbackRedirectUrl={ROUTES.dashboard}
          signUpFallbackRedirectUrl={ROUTES.dashboard}
          afterSignOutUrl={ROUTES.home}
        >
          <Providers>
            <TooltipProvider>{children}</TooltipProvider>
          </Providers>
          <Toaster theme="dark" position="bottom-right" />
        </ClerkProvider>
      </body>
    </html>
  );
}
