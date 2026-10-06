import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { cloudinaryConfig } from "@/lib/cloudinary";
import { requestRender } from "@/lib/videos/renders";
import { objectIdString } from "@/lib/videos/schemas";

/** POST /api/clips/:id/render — queue a 9:16 render of this clip (or return the existing one). */
export const POST = apiRoute(async (_req: Request, ctx: RouteContext<"/api/clips/[id]/render">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const render = await requestRender({ cfg: cloudinaryConfig, user }, objectIdString.parse(id));
  return NextResponse.json({ render });
});
