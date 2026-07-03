/**
 * Canonical `ref.client.tokens.list` operation.
 *
 * Owns the envelope and request-validation semantics for the reference-only
 * per-client active-token listing that powers
 * `GET /_ref/clients/:clientId/tokens?owner=true` and the owner-console
 * drilldown surfaced when a client's `active_token_count > 1`.
 *
 * The operation owns:
 *   - the `?owner=true` request requirement (typed
 *     `RefClientTokensListInvalidRequestError`, mapped by the host to the
 *     existing 400 `invalid_request` envelope);
 *   - the `{object: 'list', data}` envelope over the per-token projection.
 *
 * Owner-scoping (the acting owner-session subject must own the client) and
 * the bearer-redaction guarantee (the projection carries a non-reversible
 * public token id, never the literal bearer) are the host capability's
 * responsibility — the operation does not see the substrate, the subject id,
 * or any bearer material.
 *
 * This is reference/operator surface, not PDPP protocol. Clients must not
 * depend on the response shape.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface RefClientToken {
  readonly object: "owner_client_token";
  /** Non-reversible public id (digest of the bearer). Safe to render; not a credential. */
  readonly token_id_public: string;
  readonly token_kind: string;
  readonly created_at: string;
  readonly expires_at: string | null;
}

export interface RefClientTokensListInput {
  /**
   * Raw `?owner` query parameter as the host received it. The operation
   * requires the literal string `"true"`, matching `ref.clients.list`, so a
   * future filter cannot silently widen the contract.
   */
  readonly owner: unknown;
}

export interface RefClientTokensListDependencies {
  /**
   * Resolve the acting owner's active tokens for the target client. The host
   * implementation (`listActiveTokensForOwnerClient` in `server/auth.js`)
   * owns the ownership guard and the bearer→public-id projection; it throws
   * a typed `not_found`/`forbidden` error when the acting subject does not
   * own the client, which the host maps to 404/403.
   */
  listActiveTokensForOwnerClient(): Promise<readonly RefClientToken[]> | readonly RefClientToken[];
}

export interface RefClientTokensListEnvelope {
  readonly object: "list";
  readonly data: RefClientToken[];
}

export class RefClientTokensListInvalidRequestError extends Error {
  readonly code = "invalid_request" as const;
  constructor(message = "owner=true query parameter is required") {
    super(message);
    this.name = "RefClientTokensListInvalidRequestError";
  }
}

export async function executeRefClientTokensList(
  input: RefClientTokensListInput,
  dependencies: RefClientTokensListDependencies,
): Promise<RefClientTokensListEnvelope> {
  if (input.owner !== "true") {
    throw new RefClientTokensListInvalidRequestError();
  }
  const tokens = await dependencies.listActiveTokensForOwnerClient();
  return {
    object: "list",
    data: [...tokens],
  };
}
