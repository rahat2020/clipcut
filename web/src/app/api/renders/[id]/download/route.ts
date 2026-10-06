import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { cloudinaryConfig } from "@/lib/cloudinary";
import { downloadRender } from "@/lib/videos/renders";
import { objectIdString } from "@/lib/videos/schemas";

/** GET /api/renders/:id/download — records the download, then redirects to the signed MP4. */
export const GET = apiRoute(async (_req: Request, ctx: RouteContext<"/api/renders/[id]/download">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const url = await downloadRender({ cfg: cloudinaryConfig, user }, objectIdString.parse(id));
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
});
