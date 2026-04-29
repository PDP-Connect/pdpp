/**
 * Canonical `as.grant.revoke` operation.
 *
 * Owns the grant-revocation envelope semantics for `POST
 * /grants/:grantId/revoke`: the call into `revokeGrant` with the request-id
 * propagated as audit context, the trace-id surface for adapter header
 * propagation, and the canonical `{revoked: true}` response envelope.
 *
 * The host adapter owns Express plumbing, owner/client revoke
 * authorization (`requireRevokeAuth`), request-id ensure, and response
 * writing. Errors are still propagated unwrapped so the host's
 * `handleError` mapping (existing behavior) covers typed protocol errors.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface AsGrantRevokeInput {
  readonly grantId: string;
  readonly requestId: string;
}

export interface AsGrantRevokeRevokeResult {
  readonly trace_id?: string | null;
  readonly [extra: string]: unknown;
}

export interface AsGrantRevokeDependencies {
  revokeGrant(
    grantId: string,
    context: { request_id: string },
  ): Promise<AsGrantRevokeRevokeResult> | AsGrantRevokeRevokeResult;
}

export interface AsGrantRevokeOutput {
  readonly traceId: string | null;
  readonly envelope: { readonly revoked: true };
}

export async function executeAsGrantRevoke(
  input: AsGrantRevokeInput,
  deps: AsGrantRevokeDependencies,
): Promise<AsGrantRevokeOutput> {
  const result = await deps.revokeGrant(input.grantId, {
    request_id: input.requestId,
  });
  return {
    traceId: result?.trace_id ?? null,
    envelope: { revoked: true },
  };
}
