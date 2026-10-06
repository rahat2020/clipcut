import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { cloudinaryConfig } from "@/lib/cloudinary";
import { loadProgressView } from "@/lib/videos/progress";
import { objectIdString } from "@/lib/videos/schemas";
import { deleteVideo } from "@/lib/videos/upload-service";
import { AppError } from "@/shared";

/** GET /api/videos/:id — processing state for the video page's poll (every 2–5 s). */
export const GET = apiRoute(async (_req: Request, ctx: RouteContext<"/api/videos/[id]">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const videoId = objectIdString.parse(id);
  const video = await loadProgressView(user, videoId);
  if (!video) throw new AppError("NOT_FOUND");
  return NextResponse.json({ video }, { headers: { "Cache-Control": "no-store" } });
});

/** DELETE /api/videos/:id — hide the video now, cancel it if unfinished, delete its file. */
export const DELETE = apiRoute(async (_req: Request, ctx: RouteContext<"/api/videos/[id]">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const videoId = objectIdString.parse(id);
  await deleteVideo({ cfg: cloudinaryConfig, user }, videoId);
  return new NextResponse(null, { status: 204 });
});
