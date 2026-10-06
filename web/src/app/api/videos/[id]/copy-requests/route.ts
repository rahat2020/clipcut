import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { limitUser } from "@/lib/redis";
import { requestCopy } from "@/lib/videos/copy-request";
import { objectIdString } from "@/lib/videos/schemas";
import { effectivePlanLimits, getSettings } from "@/shared";

/** POST /api/videos/:id/copy-requests — write a clip's post text again, or every clip's that has none (Step 15). */
export const POST = apiRoute(async (req: Request, ctx: RouteContext<"/api/videos/[id]/copy-requests">) => {
  const user = await requireUser();
  await limitUser(user, "ai");
  const { id } = await ctx.params;
  const limits = effectivePlanLimits(user, await getSettings("limits"));
  await requestCopy({ user, limits }, objectIdString.parse(id), await req.json().catch(() => ({})));
  return NextResponse.json({ video: { id, status: "queued" } });
});
