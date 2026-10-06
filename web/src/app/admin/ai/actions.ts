"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction, type ActionResult } from "@/lib/admin/action";
import { saveAiSettings, testModel, type ModelTestResult, type ModelUse } from "@/lib/admin/ai-service";
import { env } from "@/lib/env";
import { ROUTES } from "@/lib/routes";
import { AI_PROVIDERS, AppError, type AiProvider } from "@/shared";

/** AI models page actions (docs/ADMIN.md — AI models). Each re-checks the admin role. */

const keys = () => ({ gemini: env.GEMINI_API_KEY, groq: env.GROQ_API_KEY });

export async function saveAiSettingsAction(value: unknown, expectedVersion: number): Promise<ActionResult<{ version: number }>> {
  return runAdminAction(async ({ actor }) => {
    const saved = await saveAiSettings(actor, value, expectedVersion);
    revalidatePath(ROUTES.adminAi);
    revalidatePath(ROUTES.admin);
    return { version: saved.version };
  });
}

export async function testModelAction(provider: AiProvider, model: string, use: ModelUse): Promise<ActionResult<ModelTestResult>> {
  return runAdminAction(async () => {
    if (!(AI_PROVIDERS as readonly string[]).includes(provider)) throw new AppError("VALIDATION_FAILED", { message: "Unknown provider." });
    return testModel(provider, model.trim(), use === "transcription" ? "transcription" : "text", keys());
  });
}
