// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `ref.client.token.revoke` operation.
 *
 * Owns the outcome/status semantics for the reference-only per-token revoke
 * that powers `DELETE /_ref/clients/:clientId/tokens/:tokenIdPublic` and the
 * owner-console token-drilldown revoke action. Revokes exactly one bearer,
 * addressed by its non-bearer public id, without deleting the client or
 * touching its other tokens.
 *
 * The operation owns HTTP status mapping for the typed error codes
 * (`not_found` → 404, `forbidden` → 403, others → 400) and the success
 * envelope. Owner-scoping, the public-id→bearer match, and the client-scoped
 * revoke are the host capability's responsibility.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface RefClientTokenRevokeInput {
  /** Acting subject id (owner session sub or default placeholder). */
  readonly actingSubjectId: string;
  /** Already URL-decoded client id from the path parameter. */
  readonly clientId: string;
  /** Already URL-decoded non-bearer public token id from the path parameter. */
  readonly tokenIdPublic: string;
}

export interface RefClientTokenRevokeResult {
  readonly revoked: boolean;
  readonly token_id_public: string;
}

export interface RefClientTokenRevokeDependencies {
  revokeOwnerClientTokenByPublicId: (
    clientId: string,
    tokenIdPublic: string,
    actingSubjectId: string
  ) => Promise<RefClientTokenRevokeResult> | RefClientTokenRevokeResult;
}

export interface RefClientTokenRevokeSuccessOutcome {
  readonly body: {
    readonly object: "owner_client_token_revocation";
    readonly revoked: boolean;
    readonly token_id_public: string;
  };
  readonly outcome: "success";
  readonly status: 200;
}

export interface RefClientTokenRevokeFailureOutcome {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly outcome: "failure";
  readonly status: number;
}

export type RefClientTokenRevokeOutcome = RefClientTokenRevokeSuccessOutcome | RefClientTokenRevokeFailureOutcome;

function mapErrorStatus(code: string): number {
  if (code === "not_found") {
    return 404;
  }
  if (code === "forbidden") {
    return 403;
  }
  return 400;
}

export async function executeRefClientTokenRevoke(
  input: RefClientTokenRevokeInput,
  deps: RefClientTokenRevokeDependencies
): Promise<RefClientTokenRevokeOutcome> {
  try {
    const result = await deps.revokeOwnerClientTokenByPublicId(
      input.clientId,
      input.tokenIdPublic,
      input.actingSubjectId
    );
    return {
      body: {
        object: "owner_client_token_revocation",
        revoked: result.revoked,
        token_id_public: result.token_id_public,
      },
      outcome: "success",
      status: 200,
    };
  } catch (err) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const errCode = (err as { code?: string })?.code || "invalid_request";
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const errMessage = (err as { message?: string })?.message || "Token revoke rejected";
    return {
      errorCode: errCode,
      errorMessage: errMessage,
      outcome: "failure",
      status: mapErrorStatus(errCode),
    };
  }
}
