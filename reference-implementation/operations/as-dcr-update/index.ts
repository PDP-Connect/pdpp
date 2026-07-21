/**
 * Canonical `as.dcr.update` operation.
 *
 * Owns RFC 7592-style client-metadata update semantics for `PATCH
 * /oauth/register/:clientId`. The reference supports editing exactly one
 * field — the owner-facing `client_name` label — so the operation owns:
 *
 *   - request-body validation (the body must carry a `client_name` string;
 *     any other field is rejected so a future editable field cannot be
 *     silently accepted);
 *   - the cascading update via the host capability;
 *   - HTTP status mapping for the typed error codes
 *     (`not_found` → 404, `forbidden` → 403,
 *     `invalid_client_metadata` / others → 400).
 *
 * The host adapter owns owner-session enforcement, request-id/trace-id
 * emission, and response writing.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export type DcrUpdateErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_client_metadata"
  | "invalid_request"
  | string;

export interface DcrUpdateInput {
  /** Already URL-decoded client id from the path parameter. */
  readonly clientId: string;
  /** Raw request body as the host received it. */
  readonly body: unknown;
  /** Acting subject id (owner session sub or default placeholder). */
  readonly actingSubjectId: string;
}

export interface DcrUpdatedClient {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly created_at: string;
  readonly updated_at: string | null;
}

export interface DcrUpdateDependencies {
  updateRegisteredClientName(
    clientId: string,
    context: {
      clientName: string;
      actingSubjectId: string;
    },
  ): Promise<DcrUpdatedClient> | DcrUpdatedClient;
}

export interface DcrUpdateSuccessOutcome {
  readonly outcome: "success";
  readonly status: 200;
  readonly client: DcrUpdatedClient;
}

export interface DcrUpdateFailureOutcome {
  readonly outcome: "failure";
  readonly status: number;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type DcrUpdateOutcome = DcrUpdateSuccessOutcome | DcrUpdateFailureOutcome;

// The only editable field. Anything else in the body is rejected so a future
// editable field must be added deliberately, never accepted silently.
const ALLOWED_UPDATE_FIELDS = new Set(["client_name"]);

function mapErrorStatus(code: string): number {
  if (code === "not_found") return 404;
  if (code === "forbidden") return 403;
  return 400;
}

export async function executeAsDcrUpdate(
  input: DcrUpdateInput,
  deps: DcrUpdateDependencies,
): Promise<DcrUpdateOutcome> {
  const body = input.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "invalid_client_metadata",
      errorMessage: "Request body must be a JSON object with a client_name",
    };
  }
  const record = body as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((field) => !ALLOWED_UPDATE_FIELDS.has(field));
  if (unsupported.length > 0) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "invalid_client_metadata",
      errorMessage: `Only client_name is editable; unsupported fields: ${unsupported.join(", ")}`,
    };
  }
  const clientName = record.client_name;
  if (typeof clientName !== "string" || !clientName.trim()) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "invalid_client_metadata",
      errorMessage: "client_name must be a non-empty string",
    };
  }

  try {
    const client = await deps.updateRegisteredClientName(input.clientId, {
      clientName,
      actingSubjectId: input.actingSubjectId,
    });
    return { outcome: "success", status: 200, client };
  } catch (err) {
    const errCode = (err as { code?: string })?.code || "invalid_request";
    const errMessage = (err as { message?: string })?.message || "Client update rejected";
    return {
      outcome: "failure",
      status: mapErrorStatus(errCode),
      errorCode: errCode,
      errorMessage: errMessage,
    };
  }
}
