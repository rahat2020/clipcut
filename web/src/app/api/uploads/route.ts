import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { uploadContextForRequest } from "@/lib/videos/context";
import { limitUser } from "@/lib/redis";
import { requestUploadSchema } from "@/lib/videos/schemas";
import { requestUpload } from "@/lib/videos/upload-service";

/**
 * POST /api/uploads — checks the plan limits against the file the browser is about to
 * send, then returns a signed ticket for a direct browser → Cloudinary chunked upload.
 */
export const POST = apiRoute(async (req: Request) => {
  const ctx = await uploadContextForRequest(); // auth first: signed-out callers get 401, not 400
  await limitUser(ctx.user, "upload");
  const input = requestUploadSchema.parse(await req.json());
  const ticket = await requestUpload(ctx, input);
  return NextResponse.json({ ticket });
});
