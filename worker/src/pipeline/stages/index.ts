import type { StageName } from "../../shared";
import { analyze } from "./analyze";
import { audio } from "./audio";
import { copy } from "./copy";
import { ingest } from "./ingest";
import { render } from "./render";
import { transcribe } from "./transcribe";
import type { StageHandler } from "./types";

/**
 * Stage code, in pipeline order. A stage missing here isn't built yet: a run that
 * reaches it stops with STAGE_NOT_READY (the user can retry after the next update).
 * `copy` is a placeholder that skips until Step 15.
 */
export const STAGE_HANDLERS: Partial<Record<StageName, StageHandler>> = {
  ingest,
  audio,
  transcribe,
  analyze,
  copy,
  render,
};
