import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { uploadContextForRequest } from "@/lib/videos/context";
import { limitUser } from "@/lib/redis";
import { finalizeUploadSchema } from "@/lib/videos/schemas";
import { finalizeUpload } from "@/lib/videos/upload-service";

/**
 * POST /api/videos — the upload finished; verify it with Cloudinary and create the video.
 * 201 when created, 200 when this upload was already finalized (safe to retry).
 */
export const POST = apiRoute(async (req: Request) => {
  const ctx = await uploadContextForRequest(); // auth first: signed-out callers get 401, not 400
  await limitUser(ctx.user, "upload");
  const input = finalizeUploadSchema.parse(await req.json());
  const { video, created } = await finalizeUpload(ctx, input);
  return NextResponse.json({ video: { id: String(video._id), status: video.status } }, { status: created ? 201 : 200 });
});
