import type { Logger } from "pino";

import type { PipelineRun, RunVideo } from "../run";

export type StageContext = {
  /** The video as it was when the run was claimed. */
  video: RunVideo;
  run: PipelineRun;
  /** This job's own scratch folder (created before the first stage, deleted after the last). */
  scratchDir: string;
  log: Logger;
};

/**
 * One pipeline stage. Throw an AppError for anything the user should see; return
 * "skipped" when the stage has nothing to do for this video.
 */
export type StageHandler = (ctx: StageContext) => Promise<void | "skipped">;
