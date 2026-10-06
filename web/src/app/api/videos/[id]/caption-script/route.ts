import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { limitUser } from "@/lib/redis";
import { setCaptionScript } from "@/lib/videos/copy-request";
import { objectIdString } from "@/lib/videos/schemas";
import { effectivePlanLimits, getSettings } from "@/shared";

/** POST /api/videos/:id/caption-script — Bangla script or Banglish for a Bangla video's captions and post text (Step 15). */
export const POST = apiRoute(async (req: Request, ctx: RouteContext<"/api/videos/[id]/caption-script">) => {
  const user = await requireUser();
  await limitUser(user, "ai");
  const { id } = await ctx.params;
  const limits = effectivePlanLimits(user, await getSettings("limits"));
  await setCaptionScript({ user, limits }, objectIdString.parse(id), await req.json());
  return NextResponse.json({ ok: true });
});
