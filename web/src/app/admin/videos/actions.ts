"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction, type ActionResult } from "@/lib/admin/action";
import {
  adminCancelVideo,
  adminDeleteVideo,
  adminRerunClipSelection,
  adminRetryVideo,
  type RerunClipsInput,
} from "@/lib/admin/videos-service";
import { cloudinaryConfig } from "@/lib/cloudinary";
import { ROUTES } from "@/lib/routes";

/** Admin video actions (docs/ADMIN.md — Videos and jobs). Each re-checks the admin role. */

function refresh(videoId: string) {
  revalidatePath(`${ROUTES.adminVideos}/${videoId}`);
  revalidatePath(ROUTES.adminVideos);
}

export async function retryVideoAction(videoId: string): Promise<ActionResult> {
  return runAdminAction(async ({ actor }) => {
    await adminRetryVideo(actor, videoId);
    refresh(videoId);
    return null;
  });
}

export async function cancelVideoAction(videoId: string): Promise<ActionResult> {
  return runAdminAction(async ({ actor }) => {
    await adminCancelVideo(actor, videoId);
    refresh(videoId);
    return null;
  });
}

export async function rerunClipsAction(videoId: string, input: RerunClipsInput): Promise<ActionResult> {
  return runAdminAction(async ({ actor }) => {
    await adminRerunClipSelection(actor, videoId, input);
    refresh(videoId);
    return null;
  });
}

export async function deleteVideoAction(videoId: string): Promise<ActionResult> {
  return runAdminAction(async ({ actor }) => {
    await adminDeleteVideo({ cfg: cloudinaryConfig, actor }, videoId);
    refresh(videoId);
    return null;
  });
}
