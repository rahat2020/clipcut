import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api";
import { requireUser } from "@/lib/auth/session";
import { limitUser } from "@/lib/redis";
import { effectivePlanLimits, getSettings, minutesUsedThisPeriod, quotaResetsAt } from "@/shared";

/** The signed-in user's profile, plan limits and this month's usage. 401 when signed out. */
export const GET = apiRoute(async () => {
  const user = await requireUser();
  await limitUser(user, "read");
  const limits = effectivePlanLimits(user, await getSettings("limits"));

  return NextResponse.json({
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name ?? null,
      imageUrl: user.imageUrl ?? null,
      role: user.role,
      plan: user.plan,
      uiLocale: user.uiLocale,
      defaultVideoLanguage: user.defaultVideoLanguage,
    },
    limits,
    usage: {
      periodStart: user.quota?.periodStart ?? null,
      minutesUsed: minutesUsedThisPeriod(user),
      resetsAt: quotaResetsAt(user),
    },
  });
});
