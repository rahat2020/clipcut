/** App paths used by more than one file (Clerk config, proxy, redirects, links). */
export const ROUTES = {
  home: "/",
  signIn: "/sign-in",
  signUp: "/sign-up",
  dashboard: "/dashboard",
  /** All of the user's videos; a single video is `${videos}/<id>`. */
  videos: "/videos",
  admin: "/admin",
  /** Admin sections; a single record is `${adminVideos}/<id>` / `${adminUsers}/<id>`. */
  adminVideos: "/admin/videos",
  adminUsers: "/admin/users",
  adminAi: "/admin/ai",
  adminAccuracy: "/admin/accuracy",
  /** Shown instead of the app when the account can't use it (suspended, maintenance, sign-ups closed). */
  blocked: "/blocked",
} as const;
