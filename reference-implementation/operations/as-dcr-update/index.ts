// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

export type DcrUpdateErrorCode = "not_found" | "forbidden" | "invalid_client_metadata" | "invalid_request" | string;

export interface DcrUpdateInput {
  /** Acting subject id (owner session sub or default placeholder). */
  readonly actingSubjectId: string;
  /** Raw request body as the host received it. */
  readonly body: unknown;
  /** Already URL-decoded client id from the path parameter. */
  readonly clientId: string;
}

export interface DcrUpdatedClient {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly created_at: string;
  readonly updated_at: string | null;
}

export interface DcrUpdateDependencies {
  updateRegisteredClientName: (
    clientId: string,
    context: {
      clientName: string;
      actingSubjectId: string;
    }
  ) => Promise<DcrUpdatedClient> | DcrUpdatedClient;
}

export interface DcrUpdateSuccessOutcome {
  readonly client: DcrUpdatedClient;
  readonly outcome: "success";
  readonly status: 200;
}

export interface DcrUpdateFailureOutcome {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly outcome: "failure";
  readonly status: number;
}

export type DcrUpdateOutcome = DcrUpdateSuccessOutcome | DcrUpdateFailureOutcome;

// The only editable field. Anything else in the body is rejected so a future
// editable field must be added deliberately, never accepted silently.
const ALLOWED_UPDATE_FIELDS = new Set(["client_name"]);

function mapErrorStatus(code: string): number {
  if (code === "not_found") {
    return 404;
  }
  if (code === "forbidden") {
    return 403;
  }
  return 400;
}

export async function executeAsDcrUpdate(
  input: DcrUpdateInput,
  deps: DcrUpdateDependencies
): Promise<DcrUpdateOutcome> {
  const { body } = input;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      errorCode: "invalid_client_metadata",
      errorMessage: "Request body must be a JSON object with a client_name",
      outcome: "failure",
      status: 400,
    };
  }
  const record = body as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((field) => !ALLOWED_UPDATE_FIELDS.has(field));
  if (unsupported.length > 0) {
    return {
      errorCode: "invalid_client_metadata",
      errorMessage: `Only client_name is editable; unsupported fields: ${unsupported.join(", ")}`,
      outcome: "failure",
      status: 400,
    };
  }
  const clientName = record.client_name;
  if (typeof clientName !== "string" || !clientName.trim()) {
    return {
      errorCode: "invalid_client_metadata",
      errorMessage: "client_name must be a non-empty string",
      outcome: "failure",
      status: 400,
    };
  }

  try {
    const client = await deps.updateRegisteredClientName(input.clientId, {
      actingSubjectId: input.actingSubjectId,
      clientName,
    });
    return { client, outcome: "success", status: 200 };
  } catch (err) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    const errCode = (err as { code?: string })?.code || "invalid_request";
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    const errMessage = (err as { message?: string })?.message || "Client update rejected";
    return {
      errorCode: errCode,
      errorMessage: errMessage,
      outcome: "failure",
      status: mapErrorStatus(errCode),
    };
  }
}
