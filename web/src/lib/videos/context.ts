import "server-only";

import { headers } from "next/headers";

import { effectivePlanLimits, getSettings } from "@/shared";

import { requireUser } from "../auth/session";
import { cloudinaryConfig } from "../cloudinary";
import type { UploadContext } from "./upload-service";

/** Everything the upload service needs for the signed-in user of this request. */
export async function uploadContextForRequest(): Promise<UploadContext> {
  const user = await requireUser();
  const [limits, system, h] = await Promise.all([getSettings("limits"), getSettings("system"), headers()]);
  return {
    cfg: cloudinaryConfig,
    user,
    limits: effectivePlanLimits(user, limits),
    system,
    request: {
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || undefined,
      userAgent: h.get("user-agent")?.slice(0, 300) || undefined,
    },
  };
}
