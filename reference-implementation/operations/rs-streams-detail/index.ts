// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.streams.detail` operation.
 *
 * Owns the AS/RS stream-metadata visibility and instrumentation semantics for
 * `GET /v1/streams/:stream` independent of HTTP framework, sandbox UI,
 * concrete database driver, and `process.env`. Both the native Fastify route
 * and the website sandbox `GET /sandbox/v1/streams/:stream` route mount this
 * operation; the host-shaped envelope assembly stays in host adapters because
 * native and sandbox emit different `field_capabilities` / `expand_capabilities`
 * shapes today.
 *
 * Boundary rules (see openspec/changes/mount-rs-stream-detail-operation):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, or `process.env`.
 * - Manifest, grant-visibility, and metadata-assembly capabilities are passed
 *   in as `dependencies`. Hosts wire the concrete implementations: native ->
 *   server/index.js manifest + grant + buildStreamMetadataEntry; sandbox ->
 *   fixture helpers backed by `_demo/dataset.ts` + buildLiveStreamMetadata.
 */

export interface StreamDetailSourceDescriptor {
  kind: "connector" | "provider_native";
  id: string;
  [extra: string]: unknown;
}

/**
 * Host-shaped `stream_metadata` envelope. The operation does not constrain
 * fields beyond `object` / `name` because native (rich `field_capabilities` per
 * field) and sandbox (`{allowed_fields, restricted_fields}`) intentionally
 * differ today; envelope shape is a host concern.
 */
export interface StreamMetadataEnvelope {
  object: "stream_metadata";
  name: string;
  [extra: string]: unknown;
}

export type StreamDetailActor =
  | { kind: "owner"; subject_id: string | null }
  | {
      kind: "client";
      subject_id: string | null;
      client_id: string | null;
      grant_id: string | null;
    };

export interface StreamDetailDependencies {
  /**
   * Source descriptor for instrumentation events (`source` field on
   * `disclosure.served` / `query.received`). Hosts compute this once.
   */
  getSourceDescriptor(): StreamDetailSourceDescriptor;
  /**
   * Capability-shaped manifest visibility dependency. Returns true when the
   * stream is declared in the actor's manifest scope (owner-wide for owner
   * actors; grant-resolved for client actors).
   */
  hasManifestStream(streamName: string): Promise<boolean>;
  /**
   * Grant-visibility dependency. Only consulted for client actors. Owner
   * actors bypass this check entirely (manifest visibility is sufficient).
   */
  isStreamInGrant(streamName: string): boolean;
  /**
   * Metadata-assembly dependency. Called only after visibility and grant
   * checks pass. Hosts compute freshness, field/expand capabilities, and any
   * other envelope fields here. The operation does not introspect the result.
   */
  buildStreamMetadata(streamName: string): Promise<StreamMetadataEnvelope>;
}

export interface StreamDetailInput {
  actor: StreamDetailActor;
  /** Stream name from the request path. */
  streamName: string;
}

export interface StreamDetailOutput {
  /** Host-shaped `stream_metadata` envelope returned by the dependency. */
  metadata: StreamMetadataEnvelope;
  /** Echoed for instrumentation parity with the native route. */
  sourceDescriptor: StreamDetailSourceDescriptor;
  /** `query.received`-shaped data block. Hosts pass this through verbatim. */
  queryData: { query_shape: "stream_metadata" };
}

/**
 * Error thrown when the stream is not visible to the actor. The `code`
 * matches existing native error codes so the host adapter can emit a
 * route-compatible response without translation.
 */
export class StreamDetailVisibilityError extends Error {
  readonly code: "not_found" | "grant_stream_not_allowed";

  constructor(code: "not_found" | "grant_stream_not_allowed", message: string) {
    super(message);
    this.name = "StreamDetailVisibilityError";
    this.code = code;
  }
}

/**
 * Execute the canonical `rs.streams.detail` operation.
 *
 * Pure of any transport: callers translate `Request`/Fastify `req` into
 * `StreamDetailInput` and translate `StreamDetailOutput.metadata` into the
 * response their host emits.
 *
 * Visibility ordering matches the previous native route:
 *   1. manifest stream missing -> `not_found`
 *   2. client actor with stream not in grant -> `grant_stream_not_allowed`
 *   3. otherwise build metadata and return.
 */
export async function executeStreamDetail(
  input: StreamDetailInput,
  dependencies: StreamDetailDependencies,
): Promise<StreamDetailOutput> {
  const sourceDescriptor = dependencies.getSourceDescriptor();

  const manifestVisible = await dependencies.hasManifestStream(input.streamName);
  if (!manifestVisible) {
    throw new StreamDetailVisibilityError(
      "not_found",
      `Stream '${input.streamName}' not found`,
    );
  }

  if (input.actor.kind === "client") {
    if (!dependencies.isStreamInGrant(input.streamName)) {
      throw new StreamDetailVisibilityError(
        "grant_stream_not_allowed",
        `Stream '${input.streamName}' not in grant`,
      );
    }
  }

  const metadata = await dependencies.buildStreamMetadata(input.streamName);

  return {
    metadata,
    sourceDescriptor,
    queryData: { query_shape: "stream_metadata" },
  };
}
