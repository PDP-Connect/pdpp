/**
 * Canonical `as.discovery.index` operation.
 *
 * Owns the cold-start discovery index envelope returned at the AS root
 * (`GET /`). The host adapter resolves the provider name and reference
 * revision and writes the envelope as the response body.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface AsDiscoveryIndexInput {
  readonly providerName: string;
  readonly referenceRevision: string;
}

export interface AsDiscoveryIndexEnvelope {
  readonly object: "pdpp_discovery_index";
  readonly role: "authorization_server";
  readonly resource_name: string;
  readonly links: {
    readonly well_known_authorization_server: "/.well-known/oauth-authorization-server";
  };
  readonly reference_revision: string;
}

export function executeAsDiscoveryIndex(
  input: AsDiscoveryIndexInput,
): AsDiscoveryIndexEnvelope {
  return {
    object: "pdpp_discovery_index",
    role: "authorization_server",
    resource_name: input.providerName,
    links: {
      well_known_authorization_server: "/.well-known/oauth-authorization-server",
    },
    reference_revision: input.referenceRevision,
  };
}
