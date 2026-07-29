// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.connectors.list` operation.
 *
 * Owns the AS/RS bearer-scoped connector-discovery list semantics for
 * `GET /v1/connectors` independent of HTTP framework, sandbox UI, concrete
 * database driver, and `process.env`. The native Fastify host adapter wires
 * the actor branch (owner-native vs owner-multi-connector vs client-grant)
 * and supplies the per-branch connector items through `listConnectorItems`;
 * the operation owns the `{object: 'list', data}` envelope and the
 * `query.received` / `disclosure.served` `connector_list` data block totals.
 *
 * Boundary rules (see openspec/changes/mount-rs-public-read-operations):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the Fastify host module
 *   (`server/index.js`), the records module (`server/records.js`), or
 *   `process` / `process.env`.
 * - Connector-item assembly capabilities flow in through dependencies. The
 *   host wires the concrete reads (e.g. `buildConnectorDiscoveryItem` calls
 *   per actor branch in `server/index.js`).
 */

export interface ConnectorsListSourceDescriptor {
  id: string;
  kind: "connector" | "provider_native";
  [extra: string]: unknown;
}

/**
 * Connector-discovery item shape, mirroring `buildConnectorDiscoveryItem`'s
 * output. The operation does not constrain extra fields so host evolution of
 * the item shape stays additive without churning this module.
 */
export interface ConnectorsListItem {
  readonly connector_id?: string;
  readonly object: "connector";
  readonly source: ConnectorsListSourceDescriptor;
  readonly stream_count: number;
  readonly streams: readonly unknown[];
  readonly [extra: string]: unknown;
}

export type ConnectorsListActor =
  | { kind: "owner"; subject_id: string | null }
  | {
      kind: "client";
      subject_id: string | null;
      client_id: string | null;
      grant_id: string | null;
    };

export interface ConnectorsListDependencies {
  /**
   * Source descriptor for instrumentation events (`source` field on
   * `disclosure.served` / `query.received`). Hosts compute this once. May be
   * `null` for actor branches that span multiple connectors and have no
   * single canonical source descriptor (matches the `query.received` shape
   * the native route emits today).
   */
  getSourceDescriptor: () => ConnectorsListSourceDescriptor | null;
  /**
   * Returns the connector-discovery items the actor is allowed to see, in the
   * order the host wants them rendered. Implementations are responsible for
   * the actor's visibility rules (owner-native single item, owner-multi-
   * connector list, or client-grant single item).
   */
  listConnectorItems: () => Promise<readonly ConnectorsListItem[]> | readonly ConnectorsListItem[];
}

export interface ConnectorsListInput {
  actor: ConnectorsListActor;
}

export interface ConnectorsListEnvelope {
  readonly data: ConnectorsListItem[];
  readonly object: "list";
}

export interface ConnectorsListOutput {
  /**
   * `disclosure.served`-shaped totals derived from the envelope. Hosts merge
   * these into the disclosure data block alongside the source descriptor.
   */
  disclosureTotals: {
    connector_count: number;
    stream_count: number;
  };
  /** Canonical envelope; the host writes this as the response body. */
  envelope: ConnectorsListEnvelope;
  /**
   * `query.received`-shaped data block. Hosts pass this through to the
   * disclosure spine. The previous native route emitted only the discriminator
   * for this query shape; the operation preserves that.
   */
  queryData: { query_shape: "connector_list" };
  /** Echoed for instrumentation parity with the native route. */
  sourceDescriptor: ConnectorsListSourceDescriptor | null;
}

/**
 * Execute the canonical `rs.connectors.list` operation.
 *
 * Pure of any transport: callers translate `Request` / Fastify `req` into
 * `ConnectorsListInput` and translate `ConnectorsListOutput.envelope` into the
 * response their host emits.
 */
export async function executeConnectorsList(
  _input: ConnectorsListInput,
  dependencies: ConnectorsListDependencies
): Promise<ConnectorsListOutput> {
  const sourceDescriptor = dependencies.getSourceDescriptor();
  const items = await dependencies.listConnectorItems();
  const data = [...items];

  const stream_count = data.reduce(
    (sum, item) => sum + (typeof item.stream_count === "number" ? item.stream_count : 0),
    0
  );

  return {
    disclosureTotals: {
      connector_count: data.length,
      stream_count,
    },
    envelope: { data, object: "list" },
    queryData: { query_shape: "connector_list" },
    sourceDescriptor,
  };
}
