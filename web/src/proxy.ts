import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Next.js 16 request proxy (formerly middleware.ts). Clerk must run on every page and API
 * request so `auth()` works in server code.
 *
 * Signed-out visitors to app pages (/dashboard, /videos, /admin) are sent to sign-in here.
 * This is a convenience only: every page and route handler still checks the user itself
 * (requireUserPage/requireUser),
 * and admin rights are checked from our database, never here (docs/ADMIN.md §1).
 * API routes are not redirected — they answer 401 JSON via requireUser().
 *
 * Paths are literals (not ROUTES) because the matcher must be statically analysable.
 */
const isAppPage = createRouteMatcher(["/dashboard(.*)", "/videos(.*)", "/admin(.*)"]);

export default clerkMiddleware(
  async (auth, req) => {
    if (isAppPage(req)) await auth.protect();
  },
  // Our own pages instead of Clerk's hosted ones; auth().redirectToSignIn() inherits these.
  { signInUrl: "/sign-in", signUpUrl: "/sign-up" },
);

export const config = {
  matcher: [
    // Everything except Next internals and static files (unless found in search params).
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
