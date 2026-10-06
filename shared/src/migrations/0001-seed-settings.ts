import type { Migration } from "./types";

/**
 * Writes the default value of every settings group, so the admin panel shows real,
 * editable documents from day one. Existing documents are left untouched ($setOnInsert),
 * which makes this safe to run on a database an admin has already configured.
 *
 * Values are frozen here on purpose (not imported from settings/schemas.ts): if the
 * defaults change later, this migration must still describe what it did originally.
 */
const DEFAULTS_AT_THIS_MIGRATION: Record<string, Record<string, unknown>> = {
  ai: {
    transcription: { provider: "groq", model: "whisper-large-v3", enabled: true },
    clipSelection: {
      provider: "gemini",
      model: "gemini-2.5-flash",
      temperature: 0.3,
      promptVersion: "clip-select@1",
      enabled: true,
      fallback: { provider: "groq", model: "openai/gpt-oss-120b" },
    },
    copyWriting: {
      provider: "gemini",
      model: "gemini-2.5-flash",
      temperature: 0.7,
      promptVersion: "copy@1",
      enabled: true,
      fallback: { provider: "groq", model: "openai/gpt-oss-120b" },
    },
    dailyCaps: { groqAudioMinutes: 300, groqRequests: 500, geminiRequests: 200 },
  },
  limits: {
    plans: {
      free: { monthlyMinutes: 60, maxFileMB: 100, maxDurationMin: 60, concurrentJobs: 1, maxClipsPerVideo: 10, allowYoutube: true },
    },
  },
  retention: {
    plans: { free: { days: 7 } },
    graceHours: 24,
    changedAt: null,
    purgeSoftDeletedAfterDays: 30,
  },
  system: {
    maintenanceMode: false,
    maintenanceMessage: "",
    uploadsEnabled: true,
    youtubeEnabled: true,
    signupsEnabled: true,
  },
};

export const migration0001: Migration = {
  id: "0001-seed-settings",
  description: "Create the four settings documents with their default values",
  async up({ db, log }) {
    const settings = db.collection<{ _id: string }>("settings");
    const now = new Date();
    for (const [group, data] of Object.entries(DEFAULTS_AT_THIS_MIGRATION)) {
      const res = await settings.updateOne(
        { _id: group },
        {
          $setOnInsert: {
            data,
            schemaVersion: 1,
            version: 1,
            updatedByEmail: "migration:0001",
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
      log(res.upsertedCount ? `created settings "${group}"` : `settings "${group}" already exists — left as is`);
    }
  },
};
