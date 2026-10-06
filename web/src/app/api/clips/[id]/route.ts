import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { clipUpdateSchema, updateClip } from "@/lib/videos/clip-edit";
import { objectIdString } from "@/lib/videos/schemas";

/** PATCH /api/clips/:id — keep / reject, trim, framing, caption style (Step 13). */
export const PATCH = apiRoute(async (req: Request, ctx: RouteContext<"/api/clips/[id]">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const input = clipUpdateSchema.parse(await req.json());
  await updateClip({ user }, objectIdString.parse(id), input);
  return NextResponse.json({ ok: true });
});
