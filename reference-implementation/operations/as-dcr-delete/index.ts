/**
 * Canonical `as.dcr.delete` operation.
 *
 * Owns RFC 7592-style client-deletion semantics for `DELETE
 * /oauth/register/:clientId`: client-id parameter resolution, acting-subject
 * derivation from the owner session, the cascading delete via the host
 * capability, and HTTP status mapping for the typed error codes
 * (`not_found` → 404, `forbidden` → 403, others → 400).
 *
 * The host adapter owns owner-session enforcement, request-id/trace-id
 * emission, and response writing.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export type DcrDeleteErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_request"
  | string;

export interface DcrDeleteInput {
  /** Already URL-decoded client id from the path parameter. */
  readonly clientId: string;
  /** Acting subject id (owner session sub or default placeholder). */
  readonly actingSubjectId: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface DcrDeleteDependencies {
  deleteRegisteredClient(
    clientId: string,
    context: {
      actingSubjectId: string;
      requestId: string;
      traceId: string;
    },
  ): Promise<void> | void;
}

export interface DcrDeleteSuccessOutcome {
  readonly outcome: "success";
  readonly status: 204;
}

export interface DcrDeleteFailureOutcome {
  readonly outcome: "failure";
  readonly status: number;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type DcrDeleteOutcome =
  | DcrDeleteSuccessOutcome
  | DcrDeleteFailureOutcome;

function mapErrorStatus(code: string): number {
  if (code === "not_found") return 404;
  if (code === "forbidden") return 403;
  return 400;
}

export async function executeAsDcrDelete(
  input: DcrDeleteInput,
  deps: DcrDeleteDependencies,
): Promise<DcrDeleteOutcome> {
  try {
    await deps.deleteRegisteredClient(input.clientId, {
      actingSubjectId: input.actingSubjectId,
      requestId: input.requestId,
      traceId: input.traceId,
    });
    return { outcome: "success", status: 204 };
  } catch (err) {
    const errCode = (err as { code?: string })?.code || "invalid_request";
    const errMessage =
      (err as { message?: string })?.message || "Client deletion rejected";
    return {
      outcome: "failure",
      status: mapErrorStatus(errCode),
      errorCode: errCode,
      errorMessage: errMessage,
    };
  }
}
