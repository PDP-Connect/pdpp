/**
 * Canonical `rs.records.get` operation.
 *
 * Owns the AS/RS single-record-read semantics for
 * `GET /v1/streams/:stream/records/:id` independent of HTTP framework,
 * sandbox UI, concrete database driver, and `process.env`. Both the native
 * Fastify route and the website sandbox
 * `GET /sandbox/v1/streams/:stream/records/:recordId` route mount this
 * operation; the host adapter still owns auth, request id / trace id,
 * instrumentation events, response writing, and blob-ref URL decoration
 * (which remains a dependency-shaped capability).
 *
 * Boundary rules (see openspec/changes/mount-rs-record-read-operations):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, or `process` /
 *   `process.env`.
 * - Cursor / `expand[]` / `expand_limit` validation and blob-ref byte access
 *   are delegated to capability dependencies. The operation does not look
 *   at adapter internals.
 *
 * What the operation owns:
 *   - `not_found` error mapping when the record does not exist;
 *   - owner read-grant construction for the actor's stream;
 *   - output shape (decorated record + instrumentation data blocks).
 *
 * What stays in the host adapter:
 *   - `decodeURIComponent` of the path-level record id (the operation
 *     receives the already-decoded id so it does not need to know how the
 *     host parsed the URL);
 *   - request id, trace id, query / disclosure instrumentation;
 *   - response writing.
 */

import {
  normalizeProjectionFields,
  projectRecordEnvelope,
} from "../read-projection.ts";

export interface RecordDetailSourceDescriptor {
  kind: "connector" | "provider_native";
  id: string;
  [extra: string]: unknown;
}

export type RecordDetailActor =
  | { kind: "owner"; subject_id: string | null }
  | {
      kind: "client";
      subject_id: string | null;
      client_id: string | null;
      grant_id: string | null;
    };

export interface RecordDetailManifest {
  streams: Array<{ name: string; [extra: string]: unknown }>;
  [extra: string]: unknown;
}

export interface RecordDetailGrantStream {
  name: string;
  fields?: string[];
  [extra: string]: unknown;
}

export interface RecordDetailGrant {
  streams: RecordDetailGrantStream[];
  [extra: string]: unknown;
}

/**
 * `expand` / `expand_limit` request options forwarded to the underlying
 * `getRecord` capability. The operation does not introspect these; the
 * dependency owns expand validation and shape.
 */
export interface RecordDetailExpandOptions {
  expand?: string | string[] | null;
  expand_limit?: string | number | null;
  fields?: string | string[] | null;
}

export interface RecordDetailDependencies {
  /**
   * Source descriptor for instrumentation events (`source` field on
   * `disclosure.served` / `query.received`). Hosts compute this once.
   */
  getSourceDescriptor(): RecordDetailSourceDescriptor;
  /**
   * Resolved manifest the host built from the actor's scope. Forwarded into
   * the `getRecord` capability so adapter-side schema/freshness lookups
   * have the same input as the previous native route.
   */
  getManifest(): Promise<RecordDetailManifest> | RecordDetailManifest;
  /**
   * Resolved grant the host derived for this request. Owner actors get an
   * owner read-grant; client actors get the token's grant.
   */
  getGrant(): RecordDetailGrant;
  /**
   * Fetch a single record. Returns `null` when the record does not exist;
   * the operation maps that to `RecordDetailVisibilityError('not_found')`.
   */
  getRecord(
    stream: string,
    recordId: string,
    grant: RecordDetailGrant,
    manifest: RecordDetailManifest,
    options: RecordDetailExpandOptions,
  ): Promise<Record<string, unknown> | null>;
  /**
   * Apply blob-ref URL decoration to the fetched record. Hosts wire the
   * concrete implementation: native -> `decorateRecordBlobRefs` from
   * `server/index.js`; sandbox -> identity (sandbox demo records do not
   * carry blob refs).
   */
  decorateRecord(record: Record<string, unknown>): Record<string, unknown>;
}

export interface RecordDetailInput {
  actor: RecordDetailActor;
  /** Stream name from the request path. */
  streamName: string;
  /** Record id (already URI-decoded by the host adapter). */
  recordId: string;
  /** `expand` / `expand_limit` raw request values, forwarded unchanged. */
  expandOptions?: RecordDetailExpandOptions;
}

export interface RecordDetailOutput {
  /** Decorated record envelope. */
  record: Record<string, unknown>;
  /** Echoed for instrumentation parity with the native route. */
  sourceDescriptor: RecordDetailSourceDescriptor;
  /** `query.received`-shaped data block. */
  queryData: {
    query_shape: "record_detail";
    requested_record_id: string;
    has_changes_since: false;
    limit: null;
  };
  /** `disclosure.served`-shaped data block. Hosts merge in `source`. */
  disclosureData: {
    query_shape: "record_detail";
    record_count: number;
    has_more: false;
    has_next_changes_since: false;
    requested_record_id: string;
  };
  /** Owner read-grant the operation built when the actor is an owner. */
  effectiveGrant: RecordDetailGrant;
}

/**
 * Error thrown when the requested record cannot be returned. The `code`
 * matches the existing native error code so the host adapter can emit a
 * route-compatible response without translation.
 */
export class RecordDetailVisibilityError extends Error {
  readonly code: "not_found";

  constructor(message: string) {
    super(message);
    this.name = "RecordDetailVisibilityError";
    this.code = "not_found";
  }
}

function buildOwnerReadGrant(streamName: string): RecordDetailGrant {
  return { streams: [{ name: streamName }] };
}

/**
 * Execute the canonical `rs.records.get` operation.
 */
export async function executeRecordDetail(
  input: RecordDetailInput,
  dependencies: RecordDetailDependencies,
): Promise<RecordDetailOutput> {
  const sourceDescriptor = dependencies.getSourceDescriptor();
  const manifest = await dependencies.getManifest();
  let grant = dependencies.getGrant();

  if (input.actor.kind === "owner") {
    grant = buildOwnerReadGrant(input.streamName);
  }

  const expandOptions: RecordDetailExpandOptions = input.expandOptions ?? {};
  const rawRecord = await dependencies.getRecord(
    input.streamName,
    input.recordId,
    grant,
    manifest,
    expandOptions,
  );

  if (rawRecord == null) {
    throw new RecordDetailVisibilityError(
      `Record '${input.recordId}' not found in stream '${input.streamName}'`,
    );
  }

  const record = projectRecordEnvelope(
    dependencies.decorateRecord(rawRecord),
    normalizeProjectionFields(expandOptions.fields),
  );

  return {
    record,
    sourceDescriptor,
    queryData: {
      query_shape: "record_detail",
      requested_record_id: input.recordId,
      has_changes_since: false,
      limit: null,
    },
    disclosureData: {
      query_shape: "record_detail",
      record_count: 1,
      has_more: false,
      has_next_changes_since: false,
      requested_record_id: input.recordId,
    },
    effectiveGrant: grant,
  };
}
