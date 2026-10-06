import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { uploadContextForRequest } from "@/lib/videos/context";
import { limitUser } from "@/lib/redis";
import { submitYouTubeSchema } from "@/lib/videos/schemas";
import { submitYouTube } from "@/lib/videos/youtube-service";

/**
 * POST /api/videos/youtube — queue a YouTube video by link.
 * 201 when created, 200 when this request was already handled (same clientRequestId).
 */
export const POST = apiRoute(async (req: Request) => {
  const ctx = await uploadContextForRequest(); // auth first: signed-out callers get 401, not 400
  await limitUser(ctx.user, "upload");
  const input = submitYouTubeSchema.parse(await req.json());
  const { video, created } = await submitYouTube(ctx, input);
  return NextResponse.json({ video: { id: String(video._id), status: video.status } }, { status: created ? 201 : 200 });
});
