export { AnalysisRun, ANALYSIS_RUN_SCHEMA_VERSION, type AnalysisRunDoc } from "./analysis-run";
export { AuditLog, AUDIT_LOG_SCHEMA_VERSION, type AuditLogDoc } from "./audit-log";
export { Clip, CLIP_SCHEMA_VERSION, type ClipDoc } from "./clip";
export { Render, RENDER_SCHEMA_VERSION, type RenderDoc } from "./render";
export { Setting, type SettingDoc } from "./setting";
export { Transcript, TRANSCRIPT_SCHEMA_VERSION, type TranscriptDoc } from "./transcript";
export { UsageEvent, USAGE_EVENT_SCHEMA_VERSION, type UsageEventDoc } from "./usage-event";
export { User, USER_SCHEMA_VERSION, type UserDoc } from "./user";
export { Video, VIDEO_SCHEMA_VERSION, type VideoDoc } from "./video";

import { AnalysisRun } from "./analysis-run";
import { AuditLog } from "./audit-log";
import { Clip } from "./clip";
import { Render } from "./render";
import { Setting } from "./setting";
import { Transcript } from "./transcript";
import { UsageEvent } from "./usage-event";
import { User } from "./user";
import { Video } from "./video";

/** Every model, for scripts that act on all collections (index creation, backups). */
export const ALL_MODELS = [User, Video, Transcript, AnalysisRun, Clip, Render, UsageEvent, Setting, AuditLog] as const;
