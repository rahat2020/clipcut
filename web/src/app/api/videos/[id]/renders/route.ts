import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { cloudinaryConfig } from "@/lib/cloudinary";
import { loadRenderViewsForUser } from "@/lib/videos/renders";
import { objectIdString } from "@/lib/videos/schemas";

/** GET /api/videos/:id/renders — each clip's latest render; the clip panel polls it while one is running. */
export const GET = apiRoute(async (_req: Request, ctx: RouteContext<"/api/videos/[id]/renders">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const renders = await loadRenderViewsForUser(cloudinaryConfig, user, objectIdString.parse(id));
  return NextResponse.json({ renders }, { headers: { "Cache-Control": "no-store" } });
});
