"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction, type ActionResult } from "@/lib/admin/action";
import { adminSetVideoExpiry, previewRetention, saveLimits, saveRetention, saveSystem, type RetentionPreview } from "@/lib/admin/settings-service";
import { ROUTES } from "@/lib/routes";

/** Limits & plans, retention and system actions (docs/ADMIN.md). Each re-checks the admin role. */

export async function saveLimitsAction(value: unknown, expectedVersion: number): Promise<ActionResult<{ version: number }>> {
  return runAdminAction(async ({ actor }) => {
    const saved = await saveLimits(actor, value, expectedVersion);
    revalidatePath(ROUTES.adminLimits);
    return { version: saved.version };
  });
}

export async function saveSystemAction(value: unknown, expectedVersion: number): Promise<ActionResult<{ version: number }>> {
  return runAdminAction(async ({ actor }) => {
    const saved = await saveSystem(actor, value, expectedVersion);
    revalidatePath(ROUTES.adminSystem);
    revalidatePath(ROUTES.admin);
    return { version: saved.version };
  });
}

export async function previewRetentionAction(value: unknown): Promise<ActionResult<RetentionPreviewView>> {
  return runAdminAction(async () => toView(await previewRetention(value)));
}

export async function saveRetentionAction(value: unknown, expectedVersion: number, confirm: string): Promise<ActionResult<{ version: number }>> {
  return runAdminAction(async ({ actor }) => {
    const saved = await saveRetention(actor, value, expectedVersion, confirm);
    revalidatePath(ROUTES.adminRetention);
    return { version: saved.version };
  });
}

/** Keep one video's files for N more days (or null = the plan's rule again). */
export async function setVideoExpiryAction(videoId: string, days: number | null): Promise<ActionResult> {
  return runAdminAction(async ({ actor }) => {
    await adminSetVideoExpiry(actor, videoId, days);
    revalidatePath(`${ROUTES.adminVideos}/${videoId}`);
    revalidatePath(ROUTES.adminRetention);
    return null;
  });
}

/** The preview as plain data for the browser (dates as ISO text). */
export type RetentionPreviewView = {
  impact: Omit<RetentionPreview["impact"], "earliest"> & { earliest: string | null };
  purgeDue: number;
  confirm: string | null;
  graceUntil: string | null;
};

function toView(p: RetentionPreview): RetentionPreviewView {
  return {
    impact: { ...p.impact, earliest: p.impact.earliest?.toISOString() ?? null },
    purgeDue: p.purgeDue,
    confirm: p.confirm,
    graceUntil: p.graceUntil?.toISOString() ?? null,
  };
}
