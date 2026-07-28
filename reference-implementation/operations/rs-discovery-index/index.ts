// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.discovery.index` operation.
 *
 * Owns the cold-start RS discovery index returned by `GET /` on the
 * resource-server app. The body is a tiny unauthenticated pointer that
 * names the well-known endpoint, the schema endpoint, the core query
 * base, and the connectors endpoint so an integrator probing the RS
 * root learns where to read next without trial-and-error.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules, the records module,
 *   `server/index.js`, or `process` / `process.env`.
 * - The operation owns the discovery-index envelope shape and the
 *   pointer set; the host adapter wires `providerName` and the
 *   reference revision and writes the response.
 */

export interface RsDiscoveryIndexInput {
  readonly providerName: string;
  readonly referenceRevision: string | null;
}

export interface RsDiscoveryIndexEnvelope {
  readonly links: {
    readonly well_known: "/.well-known/oauth-protected-resource";
    readonly schema: "/v1/schema";
    readonly core_query_base: "/v1";
    readonly connectors: "/v1/connectors";
  };
  readonly object: "pdpp_discovery_index";
  readonly reference_revision: string | null;
  readonly resource_name: string;
  readonly role: "resource_server";
}

export interface RsDiscoveryIndexOutput {
  readonly envelope: RsDiscoveryIndexEnvelope;
}

/**
 * Execute the canonical `rs.discovery.index` operation.
 *
 * Pure of any transport: callers pass `providerName` and
 * `referenceRevision`; the operation projects the canonical pointer
 * envelope.
 */
export function executeRsDiscoveryIndex(input: RsDiscoveryIndexInput): RsDiscoveryIndexOutput {
  return {
    envelope: {
      links: {
        connectors: "/v1/connectors",
        core_query_base: "/v1",
        schema: "/v1/schema",
        well_known: "/.well-known/oauth-protected-resource",
      },
      object: "pdpp_discovery_index",
      reference_revision: input.referenceRevision,
      resource_name: input.providerName,
      role: "resource_server",
    },
  };
}
