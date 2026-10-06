import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { AppError, isAppError } from "@/shared";

/** JSON error body every API route returns: a stable code and a message safe to show. */
export type ApiErrorBody = { error: { code: string; message: string; retryable: boolean } };

export function errorResponse(err: AppError): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    { error: { code: err.code, message: err.message, retryable: err.retryable } },
    { status: err.status },
  );
}

/**
 * Wraps a route handler so thrown errors become the standard JSON error body.
 * AppError → its status and safe message; ZodError → VALIDATION_FAILED;
 * anything else is logged and returned as INTERNAL (raw errors never reach the client).
 *
 *   export const GET = apiRoute(async () => { const user = await requireUser(); ... });
 */
export function apiRoute<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (isAppError(err)) {
        if (err.status >= 500) console.error(`[api] ${err.code}`, err);
        return errorResponse(err);
      }
      if (err instanceof z.ZodError) {
        return errorResponse(new AppError("VALIDATION_FAILED", { details: { issues: err.issues.length } }));
      }
      if (err instanceof SyntaxError) {
        // req.json() on a body that isn't JSON.
        return errorResponse(new AppError("VALIDATION_FAILED"));
      }
      console.error("[api] unexpected error", err);
      return errorResponse(new AppError("INTERNAL"));
    }
  };
}
