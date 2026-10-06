import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { uploadContextForRequest } from "@/lib/videos/context";
import { limitUser } from "@/lib/redis";
import { objectIdString } from "@/lib/videos/schemas";
import { retryVideo } from "@/lib/videos/upload-service";

/** POST /api/videos/:id/retry — put a failed video back in the queue (finished stages are kept). */
export const POST = apiRoute(async (_req: Request, ctx: RouteContext<"/api/videos/[id]/retry">) => {
  const uploadCtx = await uploadContextForRequest(); // auth first
  await limitUser(uploadCtx.user, "retry");
  const { id } = await ctx.params;
  await retryVideo(uploadCtx, objectIdString.parse(id));
  return NextResponse.json({ video: { id, status: "queued" } });
});
