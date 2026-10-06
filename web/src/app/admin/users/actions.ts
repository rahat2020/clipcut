"use server";

import { clerkClient } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

import { runAdminAction, type ActionResult } from "@/lib/admin/action";
import {
  deleteUserData,
  resetUserUsage,
  setUserLimitsOverride,
  setUserPlan,
  setUserRole,
  suspendUser,
  unsuspendUser,
  type DeleteUserResult,
  type LimitsOverrideInput,
} from "@/lib/admin/users-service";
import { cloudinaryConfig } from "@/lib/cloudinary";
import { env } from "@/lib/env";
import { ROUTES } from "@/lib/routes";
import type { UserRole } from "@/shared";

/** Admin user actions (docs/ADMIN.md — Users). Each re-checks the admin role. */

function refresh(userId: string) {
  revalidatePath(`${ROUTES.adminUsers}/${userId}`);
  revalidatePath(ROUTES.adminUsers);
}

type Ctx = Parameters<Parameters<typeof runAdminAction>[0]>[0];
const adminCtx = ({ actor }: Ctx) => ({ actor, adminEmails: env.ADMIN_EMAILS });

export async function setPlanAction(userId: string, plan: string): Promise<ActionResult> {
  return runAdminAction(async (ctx) => {
    await setUserPlan(adminCtx(ctx), userId, plan);
    refresh(userId);
    return null;
  });
}

export async function setLimitsAction(userId: string, input: LimitsOverrideInput): Promise<ActionResult> {
  return runAdminAction(async (ctx) => {
    await setUserLimitsOverride(adminCtx(ctx), userId, input);
    refresh(userId);
    return null;
  });
}

export async function resetUsageAction(userId: string): Promise<ActionResult> {
  return runAdminAction(async (ctx) => {
    await resetUserUsage(adminCtx(ctx), userId);
    refresh(userId);
    return null;
  });
}

export async function suspendAction(userId: string, reason: string): Promise<ActionResult> {
  return runAdminAction(async (ctx) => {
    await suspendUser(adminCtx(ctx), userId, { reason });
    refresh(userId);
    return null;
  });
}

export async function unsuspendAction(userId: string): Promise<ActionResult> {
  return runAdminAction(async (ctx) => {
    await unsuspendUser(adminCtx(ctx), userId);
    refresh(userId);
    return null;
  });
}

export async function setRoleAction(userId: string, role: UserRole): Promise<ActionResult> {
  return runAdminAction(async (ctx) => {
    await setUserRole(adminCtx(ctx), userId, role);
    refresh(userId);
    return null;
  });
}

export async function deleteUserDataAction(userId: string, confirmEmail: string): Promise<ActionResult<DeleteUserResult>> {
  return runAdminAction(async (ctx) => {
    const result = await deleteUserData(
      {
        ...adminCtx(ctx),
        cfg: cloudinaryConfig,
        deleteClerkUser: async (clerkId) => {
          await (await clerkClient()).users.deleteUser(clerkId);
        },
      },
      userId,
      confirmEmail,
    );
    refresh(userId);
    return result;
  });
}
