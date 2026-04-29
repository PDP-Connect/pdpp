/**
 * Canonical `ref.clients.list` operation.
 *
 * Owns the envelope and request-validation semantics for the
 * reference-only operator-issued client listing that powers
 * `GET /_ref/clients?owner=true`. Host adapters (Fastify route in
 * `reference-implementation/server/index.js`) supply the per-operator
 * client projections via the dependency contract; the operation owns:
 *
 *   - the `?owner=true` request requirement (typed
 *     `RefClientsListInvalidRequestError` the host translates into the
 *     existing 400 `invalid_request` envelope);
 *   - the `{object: 'list', data}` envelope shape over the per-operator
 *     client projection.
 *
 * Per-operator scoping (filtering to the requesting owner-session
 * subject so pre-registered seeds never appear here) is the host's
 * responsibility and is exercised through the
 * `listOwnerIssuedClients(subjectId)` capability — the operation
 * doesn't see the substrate or the subject id directly.
 *
 * This is reference/operator surface, not PDPP protocol. Clients must
 * not depend on the response shape.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules,
 *   `reference-implementation/server/*` route or auth modules, or
 *   `process` / `process.env`.
 * - Per-operator client reads flow in through dependencies. The host
 *   wires the concrete read (currently `listOwnerIssuedClients` in
 *   `server/auth.js`); the operation does not look at substrate
 *   internals.
 *
 * Spec: openspec/changes/dcr-per-owner-token-with-revoke/specs/
 *       reference-implementation-architecture/spec.md
 */

export interface RefClientsListClient {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly created_at: string;
  readonly active_token_count: number;
}

export interface RefClientsListInput {
  /**
   * Raw `?owner` query parameter as the host received it. The operation
   * requires the literal string `"true"`; anything else (including
   * `undefined`, multiple values, casing variants, or a boolean
   * `true`) is rejected with `RefClientsListInvalidRequestError` so a
   * future filter (e.g. `?registered_by=anyone`) can be added without
   * silently widening the current contract.
   */
  readonly owner: unknown;
}

export interface RefClientsListDependencies {
  /**
   * Resolve the per-operator client list for the requesting
   * owner-session subject. The host implementation (currently
   * `listOwnerIssuedClients(subjectId)` in `server/auth.js`) owns the
   * filter to dynamic clients whose `metadata.issuer_subject_id` matches
   * the requesting owner-session subject so pre-registered seeds never
   * appear here.
   */
  listOwnerIssuedClients(): Promise<readonly RefClientsListClient[]> | readonly RefClientsListClient[];
}

export interface RefClientsListEnvelope {
  readonly object: "list";
  readonly data: RefClientsListClient[];
}

export class RefClientsListInvalidRequestError extends Error {
  readonly code = "invalid_request" as const;
  constructor(message = "owner=true query parameter is required") {
    super(message);
    this.name = "RefClientsListInvalidRequestError";
  }
}

/**
 * Execute the canonical `ref.clients.list` operation.
 *
 * Validates that the request includes `?owner=true`, then assembles the
 * `{object: 'list', data}` envelope from the host-supplied client
 * projection. The operation has no notion of HTTP, owner sessions,
 * headers, or framework — it returns the envelope and lets the host
 * write the response.
 */
export async function executeRefClientsList(
  input: RefClientsListInput,
  dependencies: RefClientsListDependencies,
): Promise<RefClientsListEnvelope> {
  if (input.owner !== "true") {
    throw new RefClientsListInvalidRequestError();
  }
  const clients = await dependencies.listOwnerIssuedClients();
  return {
    object: "list",
    data: [...clients],
  };
}
