import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { requestNewClips } from "@/lib/videos/clip-request";
import { objectIdString } from "@/lib/videos/schemas";
import { effectivePlanLimits, getSettings } from "@/shared";

/** POST /api/videos/:id/clip-requests — find a new set of clips with another focus (Step 14). */
export const POST = apiRoute(async (req: Request, ctx: RouteContext<"/api/videos/[id]/clip-requests">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const limits = effectivePlanLimits(user, await getSettings("limits"));
  await requestNewClips({ user, limits }, objectIdString.parse(id), await req.json());
  return NextResponse.json({ video: { id, status: "queued" } });
});
