import type { Metadata } from "next";

import { saveAiSettingsAction, testModelAction } from "@/app/admin/ai/actions";
import { AiSettingsForm } from "@/components/admin/ai-settings-form";
import { PageHeader } from "@/components/admin/ui";
import { listModels } from "@/lib/admin/ai-service";
import { requireAdminPage } from "@/lib/auth/page-guards";
import { env } from "@/lib/env";
import { formatUtc } from "@/lib/format";
import { readAiUsageToday } from "@/lib/redis";
import { getSettingsSnapshot, PROMPT_VERSIONS } from "@/shared";

export const metadata: Metadata = { title: "AI models · Admin" };

/**
 * AI models (docs/ADMIN.md): model, temperature, prompt version, fallback and on/off per
 * task, today's usage against the daily caps, and a Test button. Model lists come live
 * from each provider, so a new Gemini release shows up without a code change.
 */
export default async function AdminAiPage() {
  await requireAdminPage();
  const keys = { gemini: env.GEMINI_API_KEY, groq: env.GROQ_API_KEY };
  const [snapshot, gemini, groq, whisper, usage] = await Promise.all([
    getSettingsSnapshot("ai", { fresh: true }),
    listModels("gemini", "text", keys),
    listModels("groq", "text", keys),
    listModels("groq", "transcription", keys),
    readAiUsageToday(),
  ]);
  const listErrors = [
    ...(gemini.ok ? [] : [`Gemini: ${gemini.reason}`]),
    ...(groq.ok ? [] : [`Groq: ${groq.reason}`]),
  ];

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="AI models"
        note={
          snapshot.version === 0
            ? "Running on defaults — nothing saved yet."
            : `Version ${snapshot.version} · saved ${formatUtc(snapshot.updatedAt)} by ${snapshot.updatedByEmail ?? "?"}${snapshot.invalid ? " · stored value was invalid, defaults in use" : ""}`
        }
      />
      <AiSettingsForm
        initial={snapshot.value}
        version={snapshot.version}
        models={{ gemini: gemini.ok ? gemini.models : [], groq: groq.ok ? groq.models : [], whisper: whisper.ok ? whisper.models : [] }}
        listErrors={listErrors}
        usage={usage}
        promptVersions={PROMPT_VERSIONS}
        save={saveAiSettingsAction}
        test={testModelAction}
      />
    </div>
  );
}
