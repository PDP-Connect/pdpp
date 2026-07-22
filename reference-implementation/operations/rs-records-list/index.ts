// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.records.list` operation.
 *
 * Owns the AS/RS record-list semantics for `GET /v1/streams/:stream/records`
 * independent of HTTP framework, sandbox UI, concrete database driver, and
 * `process.env`. Both the native Fastify route and the website sandbox
 * `GET /sandbox/v1/streams/:stream/records` route mount this operation; the
 * host adapter still owns auth, request id / trace id, instrumentation
 * events, response writing, blob-ref URL decoration site (it remains a
 * dependency-shaped capability), and the host-shaped `url` envelope field.
 *
 * Boundary rules (see openspec/changes/mount-rs-record-read-operations):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, or `process` /
 *   `process.env`.
 * - Cursor comparison, `changes_since`, projection, range, `expand[]`, and
 *   blob-ref byte access are delegated to capability dependencies. The
 *   operation does not look at adapter internals.
 * - Manifest, grant, and source descriptor are operation inputs / dependency
 *   results. Hosts compute them once and hand them in.
 *
 * What the operation owns:
 *   - view/fields mutual exclusion;
 *   - manifest stream visibility for owner actors (`not_found`);
 *   - view → fields resolution against the grant
 *     (`field_not_granted` when a view names ungranted fields);
 *   - field/filter validation against the manifest stream;
 *   - owner read-grant construction;
 *   - output envelope shape and `query.received` / `disclosure.served` data
 *     block fields populated from operation inputs and result counts.
 */

import {
  normalizeProjectionFields,
  projectRecordEnvelope,
} from "../read-projection.ts";

export interface RecordsListSourceDescriptor {
  kind: "connector" | "provider_native";
  id: string;
  [extra: string]: unknown;
}

export type RecordsListActor =
  | { kind: "owner"; subject_id: string | null }
  | {
      kind: "client";
      subject_id: string | null;
      client_id: string | null;
      grant_id: string | null;
    };

/**
 * Manifest stream shape consumed by the operation. Only the fields the
 * operation reads are typed; concrete adapters may carry additional fields
 * the operation does not touch.
 */
export interface RecordsListManifestStream {
  name: string;
  views?: Array<{ id: string; fields: string[] }>;
  schema?: { properties?: Record<string, unknown> };
  [extra: string]: unknown;
}

export interface RecordsListManifest {
  streams: RecordsListManifestStream[];
  [extra: string]: unknown;
}

/**
 * Grant shape consumed by the operation. The operation only reads
 * `streams[].name` and `streams[].fields`.
 */
export interface RecordsListGrantStream {
  name: string;
  fields?: string[];
  [extra: string]: unknown;
}

export interface RecordsListGrant {
  streams: RecordsListGrantStream[];
  [extra: string]: unknown;
}

/**
 * Result shape returned by the `queryRecords` capability. Fields beyond
 * `data` are forwarded into the operation output unchanged so adapter-owned
 * pagination / change-cursor metadata flows through without operation
 * intervention.
 */
export interface RecordsListQueryResult {
  data: Array<Record<string, unknown>>;
  has_more?: boolean;
  next_cursor?: string | null;
  next_changes_since?: string | null;
  [extra: string]: unknown;
}

export interface RecordsListDependencies {
  /**
   * Source descriptor for instrumentation events (`source` field on
   * `disclosure.served` / `query.received`). Hosts compute this once.
   */
  getSourceDescriptor(): RecordsListSourceDescriptor;
  /**
   * Resolved manifest the operation should consult for stream visibility
   * (owner actor) and field/view validation. The capability returns the
   * already-resolved manifest the host built from the actor's scope.
   */
  getManifest(): Promise<RecordsListManifest> | RecordsListManifest;
  /**
   * Resolved grant the host derived for this request. For client actors this
   * is the token's grant; for owner actors the operation will overwrite this
   * with an owner read-grant after the manifest visibility check passes.
   */
  getGrant(): RecordsListGrant;
  /**
   * Run the underlying record query against the resolved manifest, grant,
   * and request params. The operation does not normalize cursor, projection,
   * range, `changes_since`, or `expand[]` shape beyond what
   * `validateRequestFields` requires; capability owns the rest.
   */
  queryRecords(
    stream: string,
    grant: RecordsListGrant,
    requestParams: Record<string, unknown>,
    manifest: RecordsListManifest,
  ): Promise<RecordsListQueryResult>;
  /**
   * Apply blob-ref URL decoration to a single record. Hosts wire the
   * concrete implementation: native -> `decorateRecordBlobRefs` from
   * `server/index.js`; sandbox -> identity (sandbox demo records do not
   * carry blob refs).
   */
  decorateRecord(record: Record<string, unknown>): Record<string, unknown>;
  /**
   * Validate request-level field/filter params against the manifest stream.
   * Hosts wire the concrete implementation (native: server-side validator;
   * sandbox: no-op fixture) so the operation does not import server
   * internals.
   *
   * Implementations may throw `RecordsListValidationError` (or any error
   * carrying `code` / `message`) to signal a request-level rejection; hosts
   * map that to their existing error envelopes.
   */
  validateRequestFields(
    requestParams: Record<string, unknown>,
    manifestStream: RecordsListManifestStream | null,
  ): void;
}

export interface RecordsListInput {
  actor: RecordsListActor;
  /** Stream name from the request path. */
  streamName: string;
  /**
   * Mutable copy of the request params (cursor, limit, fields, filter,
   * changes_since, view, etc.). The operation may set / delete `fields` /
   * `view` while resolving views; cursor / pagination semantics flow
   * through unchanged.
   */
  requestParams: Record<string, unknown>;
  /**
   * Raw `view` / `fields` query values forwarded from the host. Hosts pass
   * the value `qs.parse` / `Request.url` produced — typically a string,
   * but `qs` can yield an array for repeated params (`?fields=a&fields=b`)
   * or an object for bracketed params. The operation's mutual-exclusion
   * check tests these for truthiness so it preserves the previous native
   * behavior (`if (req.query.view && req.query.fields)`), regardless of
   * whether the host parsed the param into a string, an array, or any
   * other truthy shape.
   */
  rawQueryView?: unknown;
  rawQueryFields?: unknown;
}

export interface RecordsListOutput {
  /** Result of the underlying query, with each record blob-ref-decorated. */
  result: RecordsListQueryResult;
  /** Echoed for instrumentation parity with the native route. */
  sourceDescriptor: RecordsListSourceDescriptor;
  /**
   * `query.received`-shaped data block (without instrumentation-only fields
   * the host populates such as `requested_view`).
   */
  queryData: {
    query_shape: "record_list";
    has_changes_since: boolean;
    limit: number | null;
    requested_view?: string;
  };
  /** `disclosure.served`-shaped data block. Hosts merge in `source`. */
  disclosureData: {
    query_shape: "record_list";
    record_count: number;
    has_more: boolean;
    has_next_changes_since: boolean;
  };
  /**
   * Owner read-grant the operation built (owner actors only). Hosts may
   * record this for diagnostic / audit purposes; it is also the grant the
   * `queryRecords` capability was called with.
   */
  effectiveGrant: RecordsListGrant;
}

/** Error thrown when the request itself is invalid in a host-independent way. */
export class RecordsListVisibilityError extends Error {
  readonly code: "not_found" | "invalid_request" | "field_not_granted";

  constructor(
    code: "not_found" | "invalid_request" | "field_not_granted",
    message: string,
  ) {
    super(message);
    this.name = "RecordsListVisibilityError";
    this.code = code;
  }
}

function buildOwnerReadGrant(streamName: string): RecordsListGrant {
  return { streams: [{ name: streamName }] };
}

/**
 * Execute the canonical `rs.records.list` operation.
 *
 * The operation mutates `input.requestParams` (deletes `view`, sets
 * `fields`) when resolving a view; hosts pass a fresh copy of the request
 * params per call so this stays explicit.
 */
export async function executeRecordsList(
  input: RecordsListInput,
  dependencies: RecordsListDependencies,
): Promise<RecordsListOutput> {
  const sourceDescriptor = dependencies.getSourceDescriptor();
  const manifest = await dependencies.getManifest();
  let grant = dependencies.getGrant();

  // Owner manifest-visibility check. Client actors rely on grant scope to
  // bound visibility; their manifest stream may not be present and the
  // existing native route does not 404 in that branch.
  if (input.actor.kind === "owner") {
    const mStream = manifest.streams.find((s) => s.name === input.streamName);
    if (!mStream) {
      throw new RecordsListVisibilityError(
        "not_found",
        `Stream '${input.streamName}' not found`,
      );
    }
    grant = buildOwnerReadGrant(input.streamName);
  }

  // View / fields mutual exclusion runs as a truthiness test against the
  // raw query values to match the previous native route exactly
  // (`if (req.query.view && req.query.fields)`). The host may pass arrays
  // (qs repeated params), objects (qs bracketed params), or strings; the
  // operation does not coerce here so non-string truthy values still
  // trigger the rejection instead of silently degrading to a single-param
  // path.
  const rawView = input.rawQueryView;
  const rawFields = input.rawQueryFields;
  if (rawView && rawFields) {
    throw new RecordsListVisibilityError(
      "invalid_request",
      "view and fields are mutually exclusive",
    );
  }

  const mStream =
    manifest.streams.find((s) => s.name === input.streamName) ?? null;

  dependencies.validateRequestFields(input.requestParams, mStream);

  // View → fields resolution. Only runs when the request asks for a view
  // and `fields` was not already promoted by the validator (preserves
  // prior native ordering: validate fields if present, then resolve view
  // if no fields were supplied). View id comparison uses `===` against
  // `viewDef.id`; non-string raw `view` values therefore fall through to
  // the "Unknown view" rejection, matching the previous native behavior
  // (which embedded `req.query.view` directly into the template literal,
  // coercing arrays/objects to their default string form).
  if (rawView && input.requestParams.fields == null) {
    const viewDef = (mStream?.views ?? []).find((v) => v.id === rawView);
    if (!viewDef) {
      throw new RecordsListVisibilityError(
        "invalid_request",
        `Unknown view: ${String(rawView)}`,
      );
    }
    const streamGrant = grant.streams.find((s) => s.name === input.streamName);
    if (streamGrant?.fields) {
      const granted = streamGrant.fields;
      const unauthorized = viewDef.fields.filter((f) => !granted.includes(f));
      if (unauthorized.length) {
        throw new RecordsListVisibilityError(
          "field_not_granted",
          `View includes fields not in grant: ${unauthorized.join(", ")}`,
        );
      }
    }
    input.requestParams.fields = viewDef.fields;
    delete input.requestParams.view;
  }

  const rawResult = await dependencies.queryRecords(
    input.streamName,
    grant,
    input.requestParams,
    manifest,
  );

  const projectionFields = normalizeProjectionFields(input.requestParams.fields);
  const decoratedData = rawResult.data.map((record) =>
    projectRecordEnvelope(dependencies.decorateRecord(record), projectionFields),
  );
  const decoratedResult: RecordsListQueryResult = {
    ...rawResult,
    data: decoratedData,
  };

  const limitParam = input.requestParams.limit;
  const limit =
    typeof limitParam === "number"
      ? limitParam
      : limitParam == null || limitParam === ""
        ? null
        : Number(limitParam);
  const queryData: RecordsListOutput["queryData"] = {
    query_shape: "record_list",
    has_changes_since: !!input.requestParams.changes_since,
    limit: Number.isFinite(limit as number) ? (limit as number) : null,
  };
  // Preserve the previous native instrumentation rule: `requested_view` is
  // only emitted when the host supplied a non-empty string view. Non-string
  // raw values (arrays, objects from qs) still trigger the
  // mutual-exclusion / unknown-view paths above, but they do not surface as
  // a `requested_view` instrumentation field.
  if (typeof rawView === "string" && rawView.trim()) {
    queryData.requested_view = rawView.trim();
  }

  return {
    result: decoratedResult,
    sourceDescriptor,
    queryData,
    disclosureData: {
      query_shape: "record_list",
      record_count: decoratedData.length,
      has_more: !!rawResult.has_more,
      has_next_changes_since: !!rawResult.next_changes_since,
    },
    effectiveGrant: grant,
  };
}
