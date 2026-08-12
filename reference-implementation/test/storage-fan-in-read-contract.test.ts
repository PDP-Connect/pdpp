// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage fan-in / public-read multi-connection contract regression suite.
 *
 * Closes the deferred runtime tranche under
 * `openspec/changes/expose-connection-identity-on-public-read/tasks.md`:
 *
 *   - records list, aggregate, and streams list fan in across the granted
 *     connections when `connection_id` is omitted;
 *   - exactly-one matching connection auto-selects without raising;
 *   - record detail emits `ambiguous_connection` with `available_connections`
 *     when the identifier resolves to more than one connection;
 *   - grant scope `streams[].connection_id` narrows reads to one connection
 *     and preserves cross-connection (fan-in) semantics when absent;
 *   - owner `setDisplayName` mutates `display_name` and surfaces it on the
 *     subsequent records-list response;
 *   - deprecated `connector_instance_id` request alias keeps working;
 *     conflicting `connection_id` vs `connector_instance_id` values are
 *     rejected with typed `invalid_argument`.
 *
 * Stays on the SQLite reference path; Postgres parity is exercised by the
 * existing per-binding tests under `public-read-connection-id-decoration.test.js`
 * for the single-binding case and by the same fan-in helpers' Postgres-aware
 * delegation in `records.js` / `connection-identity.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import {
  AmbiguousConnectionError,
  resolveFanInBindings as resolveFanInBindingsUntyped,
} from "../server/connection-identity.ts";
import { closeDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import {
  aggregateRecordsAcrossBindings as aggregateRecordsAcrossBindingsUntyped,
  getRecordAcrossBindings,
  ingestRecord,
  listStreamsAcrossBindings as listStreamsAcrossBindingsUntyped,
  queryRecordsAcrossBindings as queryRecordsAcrossBindingsUntyped,
  resolveReadRequestBindings,
  validateConnectionAlias,
} from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

interface RecordListWarning {
  code: string;
  [key: string]: unknown;
}

interface RecordListResponse {
  data: Record<string, unknown>[];
  has_more: boolean;
  meta?: { count?: unknown; warnings?: RecordListWarning[]; window?: unknown; [key: string]: unknown };
  next_changes_since?: string;
  next_cursor?: string | null;
  object: string;
}

function isRecordListWarning(value: unknown): value is RecordListWarning {
  return value !== null && typeof value === "object" && "code" in value && typeof value.code === "string";
}

// `server/records.js` is plain JS: `queryRecordsAcrossBindings` and
// `listStreamsAcrossBindings` build their response object incrementally
// (base fields, then conditional `next_cursor`/`next_changes_since`/`meta`
// assignments later in the function body), so TS infers only the base
// shape. Re-typed here via the same documented pattern used elsewhere in
// this cohort: import the real export and cast it to a signature matching
// the full conditional response contract.
type QueryRecordsAcrossBindingsFn = (
  ...args: Parameters<typeof queryRecordsAcrossBindingsUntyped>
) => Promise<RecordListResponse>;

const queryRecordsAcrossBindings: QueryRecordsAcrossBindingsFn = (
  bindings,
  stream,
  // biome-ignore lint/suspicious/noShadow: localized test assertion preserves its explicit contract.
  grant,
  requestParams,
  manifest,
  opts
) =>
  queryRecordsAcrossBindingsUntyped(bindings, stream, grant, requestParams, manifest, opts).then((response) => {
    const normalized: RecordListResponse = {
      data: response.data.map((record) => ({ ...record })),
      has_more: response.has_more,
      object: response.object,
    };
    if (response.meta !== undefined) {
      const { warnings, ...meta } = response.meta;
      normalized.meta = {
        ...meta,
        ...(Array.isArray(warnings) ? { warnings: warnings.filter(isRecordListWarning) } : {}),
      };
    }
    if (response.next_changes_since !== undefined) {
      normalized.next_changes_since = response.next_changes_since;
    }
    if (response.next_cursor !== undefined) {
      normalized.next_cursor = response.next_cursor;
    }
    return normalized;
  });

interface StreamSummary {
  connection_id?: string;
  connector_instance_id?: string;
  display_name?: string;
  name: string;
  record_count?: number;
  [key: string]: unknown;
}

type ListStreamsAcrossBindingsFn = (
  ...args: Parameters<typeof listStreamsAcrossBindingsUntyped>
) => Promise<StreamSummary[]>;

// biome-ignore lint/suspicious/noShadow: localized test assertion preserves its explicit contract.
const listStreamsAcrossBindings: ListStreamsAcrossBindingsFn = (defaultBindings, grant, manifest, opts) =>
  listStreamsAcrossBindingsUntyped(defaultBindings, grant, manifest, opts).then((streams) =>
    streams.map((stream) => ({ ...stream }))
  );

function hasCode(err: unknown): err is { code: unknown; param?: unknown } {
  return err !== null && typeof err === "object" && "code" in err;
}

interface AggregateResponseBase {
  approximate: boolean;
  field: string | null;
  filtered_record_count: number;
  granularity: string | null;
  group_by: string | null;
  group_by_time: string | null;
  meta?: { warnings?: Array<{ code: string; [key: string]: unknown }>; [key: string]: unknown };
  metric: string;
  object: string;
  stream: string;
  time_zone: string | null;
}

interface AggregateScalarResponse extends AggregateResponseBase {
  value: number | string | null;
}

interface AggregateGroupedResponse extends AggregateResponseBase {
  groups: Array<{ key: unknown; count: number }>;
  limit?: number;
}

type AggregateResponse = AggregateScalarResponse | AggregateGroupedResponse;

// `server/records.js` is plain JS: `aggregateRecordsAcrossBindings` returns a
// genuine union (scalar `value` for count/sum/min/max, or `groups`/`limit`
// for group_by/group_by_time) that TS infers narrowly from whichever branch
// it sees first. Re-typed here via the same documented pattern used
// elsewhere in this cohort: import the real export and cast it to a
// signature matching its actual multi-branch return contract.
type AggregateRecordsAcrossBindingsFn = (
  bindings: unknown,
  stream: string,
  grant: unknown,
  requestParams: Record<string, unknown>,
  manifest: unknown,
  opts?: Record<string, unknown>
) => Promise<AggregateResponse>;

const aggregateRecordsAcrossBindings = aggregateRecordsAcrossBindingsUntyped as AggregateRecordsAcrossBindingsFn;

interface FanInBinding {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string | null;
}

interface FanInBindingsResult {
  bindings: Array<FanInBinding | { connectorId: string; connectorInstanceId: string; displayName: null }>;
  warnings: Array<{ code: string }>;
}

// `server/connection-identity.ts` is plain JS: the destructured `= null`
// defaults give TS no other signal, so `requestConnectionId`/
// `grantStreamConnectionId`/`connectorInstanceIdHint` all infer as exactly
// `null` (never `string`), rejecting every real call these tests make.
// Re-typed here via the same documented pattern used elsewhere in this
// cohort: import the real export and cast it to a signature matching how
// it is actually called.
type ResolveFanInBindingsFn = (args: {
  connectorId: string | null | undefined;
  connectorInstanceIdHint?: string | null;
  grantStreamConnectionId?: string | null;
  ownerSubjectId: string | null | undefined;
  requestConnectionId?: string | null;
}) => Promise<FanInBindingsResult>;

const resolveFanInBindings: ResolveFanInBindingsFn = async (args) => {
  const result = await resolveFanInBindingsUntyped(args);
  return {
    bindings: result.bindings.map((binding) => ({
      connectorId: binding.connectorId,
      connectorInstanceId: binding.connectorInstanceId,
      displayName: binding.displayName ?? null,
    })),
    warnings: result.warnings,
  };
};

const CONNECTOR_ID = "storage-fan-in";
const STREAM = "messages";

const INSTANCE_A = "cin_fanin_account_a";
const INSTANCE_B = "cin_fanin_account_b";
const INSTANCE_C = "cin_fanin_account_c";

const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: CONNECTOR_ID,
  display_name: "Fan-in Test Connector",
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: STREAM,
      primary_key: ["id"],
      query: {
        aggregations: {
          count: true,
          count_distinct: ["subject"],
          group_by: ["subject"],
          group_by_time: ["received_at"],
        },
      },
      schema: {
        properties: {
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
          subject: { type: "string" },
        },
        required: ["id", "subject", "received_at"],
        type: "object",
      },
    },
  ],
  version: "1.0.0",
};

const grant = {
  streams: [{ fields: ["id", "subject", "received_at"], name: STREAM }],
};

function target(instanceId: string) {
  return {
    connector_id: CONNECTOR_ID,
    connector_instance_id: instanceId,
  };
}

function recordPayload(id: string, subject: string, receivedAt: string) {
  return {
    data: { id, received_at: receivedAt, subject },
    emitted_at: receivedAt,
    key: id,
    stream: STREAM,
  };
}

async function seedInstance(instanceId: string, displayName: string, sourceBindingKey: string): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function withDualConnectionDb(testFn: () => Promise<void>): Promise<void> {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, "Account A", "a@example.com");
    await seedInstance(INSTANCE_B, "Account B", "b@example.com");
    await ingestRecord(target(INSTANCE_A), recordPayload("rec-a-1", "A first", "2026-05-18T12:00:00.000Z"));
    await ingestRecord(target(INSTANCE_A), recordPayload("shared-id", "A shared", "2026-05-18T12:01:00.000Z"));
    await ingestRecord(target(INSTANCE_B), recordPayload("rec-b-1", "B first", "2026-05-18T12:02:00.000Z"));
    await ingestRecord(target(INSTANCE_B), recordPayload("shared-id", "B shared", "2026-05-18T12:03:00.000Z"));
    await testFn();
  } finally {
    closeDb();
  }
}

async function withSingleConnectionDb(testFn: () => Promise<void>): Promise<void> {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, "Sole Account", "a@example.com");
    await ingestRecord(target(INSTANCE_A), recordPayload("rec-a-1", "A first", "2026-05-18T12:00:00.000Z"));
    await ingestRecord(target(INSTANCE_A), recordPayload("rec-a-2", "A second", "2026-05-18T12:01:00.000Z"));
    await testFn();
  } finally {
    closeDb();
  }
}

// ─── Binding resolver ──────────────────────────────────────────────────────

test("resolveFanInBindings returns both active bindings when no narrowing is requested", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
    const ids = bindings.map((b) => b.connectorInstanceId).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
  });
});

test("resolveFanInBindings narrows to a single binding when request supplies connection_id", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestConnectionId: INSTANCE_B,
    });
    assert.equal(bindings.length, 1);
    assert.ok(bindings[0]);
    assert.equal(bindings[0].connectorInstanceId, INSTANCE_B);
  });
});

test("resolveFanInBindings rejects connection_id outside the grant with connection_not_found", async () => {
  await withDualConnectionDb(async () => {
    await assert.rejects(
      () =>
        resolveFanInBindings({
          connectorId: CONNECTOR_ID,
          ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
          requestConnectionId: "cin_does_not_exist",
        }),
      (err: unknown) =>
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        "param" in err &&
        err.code === "connection_not_found" &&
        err.param === "connection_id"
    );
  });
});

test("resolveFanInBindings honors grant-scope connection_id constraint", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      grantStreamConnectionId: INSTANCE_A,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(bindings.length, 1);
    assert.ok(bindings[0]);
    assert.equal(bindings[0].connectorInstanceId, INSTANCE_A);
  });
});

test("resolveReadRequestBindings forwards deprecated_alias_used warning when alias is sent", async () => {
  await withDualConnectionDb(async () => {
    const { bindings, warnings } = await resolveReadRequestBindings({
      grant,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestParams: { connector_instance_id: INSTANCE_A },
      storageBinding: { connector_id: CONNECTOR_ID },
      streamName: STREAM,
    });
    assert.equal(bindings.length, 1);
    assert.ok(bindings[0]);
    assert.equal(bindings[0].connectorInstanceId, INSTANCE_A);
    assert.ok(warnings.find((w: { code: string }) => w.code === "deprecated_alias_used"));
  });
});

// ─── Canonical connector-key admission boundary ─────────────────────────────
//
// Regression guard for the grant/owner-read `connection_not_found` cluster:
// a first-party connector registers under its URL-shaped manifest connector_id
// (`https://registry.pdpp.dev/connectors/<slug>`), which the catalog, the
// connector_instances row, and the records rows all collapse to the canonical
// key (`<slug>`) at write time. A grant or owner storage binding can still
// carry the legacy URL form, so `resolveReadRequestBindings` MUST canonicalize
// its storage-binding connector_id before listing active bindings, or
// admission finds zero rows and the read fails connection_not_found.
// See canonicalize-connector-keys Decision 1.

const FIRST_PARTY_URL_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/gmail";
const FIRST_PARTY_CANONICAL_KEY = "gmail";

const firstPartyManifest = {
  capabilities: { human_interaction: [] },
  connector_id: FIRST_PARTY_URL_CONNECTOR_ID,
  display_name: "Gmail",
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: STREAM,
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
          subject: { type: "string" },
        },
        required: ["id", "subject", "received_at"],
        type: "object",
      },
    },
  ],
  version: "1.0.0",
};

const FIRST_PARTY_INSTANCE = "cin_gmail_default_account";

async function withFirstPartyUrlConnectorDb(testFn: () => Promise<void>): Promise<void> {
  initDb();
  try {
    // Registering the URL-shaped manifest stores the catalog row under the
    // canonical key. The live ingest route materializes the default-account
    // connector_instances row under the canonical key (via
    // resolveOwnerConnectorNamespace); mirror that post-ingest state here by
    // seeding the instance and a record under the canonical key.
    await registerConnector(firstPartyManifest);
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    await store.upsert({
      connectorId: FIRST_PARTY_CANONICAL_KEY,
      connectorInstanceId: FIRST_PARTY_INSTANCE,
      createdAt: now,
      displayName: "Gmail",
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      sourceBinding: { account: "default_account" },
      sourceBindingKey: "default_account",
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });
    await ingestRecord(
      { connector_id: FIRST_PARTY_CANONICAL_KEY, connector_instance_id: FIRST_PARTY_INSTANCE },
      recordPayload("rec-1", "Hello", "2026-05-18T12:00:00.000Z")
    );
    await testFn();
  } finally {
    closeDb();
  }
}

test("resolveReadRequestBindings canonicalizes a URL-shaped storage binding to the active canonical instance", async () => {
  await withFirstPartyUrlConnectorDb(async () => {
    // Storage binding still carries the legacy URL form (as a stale grant or
    // owner scope would). Admission must resolve the canonical instance.
    const { bindings } = await resolveReadRequestBindings({
      grant: { streams: [{ name: STREAM }] },
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestParams: {},
      storageBinding: { connector_id: FIRST_PARTY_URL_CONNECTOR_ID },
      streamName: STREAM,
    });
    assert.equal(bindings.length, 1, "one active connection resolves under the canonical key");
    assert.ok(bindings[0]);
    assert.equal(bindings[0].connectorId, FIRST_PARTY_CANONICAL_KEY);
    assert.ok(bindings[0].connectorInstanceId, "a concrete connector_instance_id is bound");
  });
});

test("resolveReadRequestBindings resolves identically for the URL alias and the bare canonical key", async () => {
  await withFirstPartyUrlConnectorDb(async () => {
    const viaUrl = await resolveReadRequestBindings({
      grant: { streams: [{ name: STREAM }] },
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestParams: {},
      storageBinding: { connector_id: FIRST_PARTY_URL_CONNECTOR_ID },
      streamName: STREAM,
    });
    const viaCanonical = await resolveReadRequestBindings({
      grant: { streams: [{ name: STREAM }] },
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestParams: {},
      storageBinding: { connector_id: FIRST_PARTY_CANONICAL_KEY },
      streamName: STREAM,
    });
    assert.ok(viaCanonical.bindings.length >= 1, "canonical key resolves at least one binding");
    assert.deepEqual(
      viaUrl.bindings.map((b: { connectorInstanceId: string }) => b.connectorInstanceId),
      viaCanonical.bindings.map((b: { connectorInstanceId: string }) => b.connectorInstanceId),
      "URL alias and canonical key address the same connection set"
    );
  });
});

// ─── Records list fan-in ───────────────────────────────────────────────────

test("queryRecordsAcrossBindings fans in records across two granted connections", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    assert.equal(response.object, "list");
    assert.equal(response.data.length, 4, "expected union of records across both connections");

    const idsByConnection: Record<string, number> = {};
    for (const record of response.data) {
      const cid = record.connection_id as string;
      assert.ok(cid, "every record SHALL carry connection_id");
      assert.equal(record.connector_instance_id, cid, "deprecated alias mirrors canonical");
      idsByConnection[cid] = (idsByConnection[cid] || 0) + 1;
    }
    assert.equal(idsByConnection[INSTANCE_A], 2);
    assert.equal(idsByConnection[INSTANCE_B], 2);
  });
});

test("queryRecordsAcrossBindings preserves fan-in order and cursor collapse under bounded concurrency", async () => {
  await withDualConnectionDb(async () => {
    await seedInstance(INSTANCE_C, "Account C", "c@example.com");
    await ingestRecord(target(INSTANCE_C), recordPayload("rec-c-1", "C first", "2026-05-18T12:04:00.000Z"));

    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const byConnection = new Map(bindings.map((binding) => [binding.connectorInstanceId, binding]));
    const orderedBindings = [INSTANCE_A, INSTANCE_B, INSTANCE_C]
      .map((connectionId) => byConnection.get(connectionId))
      .filter((binding): binding is FanInBinding => binding !== undefined);
    assert.equal(orderedBindings.length, 3, "expected all seeded bindings to resolve");

    let peakInFlight = 0;
    const response = await queryRecordsAcrossBindings(orderedBindings, STREAM, grant, { limit: 1 }, baseManifest, {
      concurrency: 2,
      onInFlightChange: (inFlight: number) => {
        peakInFlight = Math.max(peakInFlight, inFlight);
      },
    });

    assert.deepEqual(
      response.data.map((record) => record.connection_id),
      [INSTANCE_A, INSTANCE_B, INSTANCE_C],
      "bounded fan-in keeps global result order identical to serial binding order"
    );
    assert.equal(response.has_more, true);
    assert.equal(response.next_cursor, undefined, "multi-binding fan-in still suppresses an unsafe global cursor");
    assert.ok(response.meta?.warnings?.some((warning) => warning.code === "partial_results"));
    assert.ok(peakInFlight > 1, `expected bounded fan-in to overlap reads, saw peak ${peakInFlight}`);
    assert.ok(peakInFlight <= 2, `expected peak in-flight reads <= 2, saw ${peakInFlight}`);
  });
});

test("queryRecordsAcrossBindings narrows to one binding when bindings list is filtered", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestConnectionId: INSTANCE_A,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    assert.equal(response.data.length, 2);
    for (const record of response.data) {
      assert.equal(record.connection_id, INSTANCE_A);
      assert.equal(record.display_name, "Account A");
    }
  });
});

test("queryRecordsAcrossBindings auto-selects exactly-one binding without raising", async () => {
  await withSingleConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(bindings.length, 1);
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    assert.equal(response.data.length, 2);
    for (const record of response.data) {
      assert.equal(record.connection_id, INSTANCE_A);
    }
  });
});

// ─── Records detail ambiguity / auto-select ────────────────────────────────

test("getRecordAcrossBindings emits ambiguous_connection when identifier resolves to multiple bindings", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    await assert.rejects(
      () => getRecordAcrossBindings(bindings, STREAM, "shared-id", grant, baseManifest, {}),
      (err: unknown) => {
        assert.ok(err instanceof AmbiguousConnectionError, "expected AmbiguousConnectionError");
        assert.equal(err.code, "ambiguous_connection");
        assert.equal(err.retry_with, "connection_id");
        const ids = err.available_connections.map((c: { connection_id: string }) => c.connection_id).sort();
        assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
        const labels = err.available_connections.map((c: { display_name?: string }) => c.display_name).sort();
        assert.deepEqual(labels, ["Account A", "Account B"]);
        return true;
      }
    );
  });
});

test("getRecordAcrossBindings auto-selects the only binding holding a unique identifier", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const record = await getRecordAcrossBindings(bindings, STREAM, "rec-a-1", grant, baseManifest, {});
    assert.equal(record.connection_id, INSTANCE_A);
    assert.equal(record.display_name, "Account A");
  });
});

test("getRecordAcrossBindings narrows successfully with explicit connection_id on ambiguous identifier", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestConnectionId: INSTANCE_B,
    });
    const record = await getRecordAcrossBindings(bindings, STREAM, "shared-id", grant, baseManifest, {
      connection_id: INSTANCE_B,
    });
    assert.equal(record.connection_id, INSTANCE_B);
    assert.ok(record.data);
    assert.equal(record.data.subject, "B shared");
  });
});

test("getRecordAcrossBindings returns not_found when identifier is absent from every binding", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    await assert.rejects(
      () => getRecordAcrossBindings(bindings, STREAM, "missing", grant, baseManifest, {}),
      (err: unknown) => hasCode(err) && err.code === "not_found"
    );
  });
});

// ─── Aggregate fan-in ──────────────────────────────────────────────────────

test("aggregateRecordsAcrossBindings sums counts across granted connections", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const response = await aggregateRecordsAcrossBindings(bindings, STREAM, grant, { metric: "count" }, baseManifest);
    assert.equal(response.object, "aggregation");
    assert.equal(response.stream, STREAM);
    assert.equal(response.metric, "count");
    assert.equal(response.field, null);
    assert.equal(response.group_by, null);
    assert.equal(response.group_by_time, null);
    assert.equal(response.granularity, null);
    assert.equal(response.time_zone, null);
    assert.equal(response.approximate, false);
    assert.equal(response.filtered_record_count, 4);
    assert.ok("value" in response, "scalar metric response must carry a value");
    assert.equal(response.value, 4);
  });
});

test("aggregateRecordsAcrossBindings merges scalar group_by buckets across granted connections", async () => {
  await withDualConnectionDb(async () => {
    await ingestRecord(target(INSTANCE_B), recordPayload("rec-b-2", "A first", "2026-05-18T12:04:00.000Z"));
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const response = await aggregateRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { group_by: "subject", limit: "10", metric: "count" },
      baseManifest
    );
    assert.equal(response.object, "aggregation");
    assert.equal(response.stream, STREAM);
    assert.equal(response.metric, "count");
    assert.equal(response.group_by, "subject");
    assert.equal(response.filtered_record_count, 5);
    assert.ok("groups" in response, "grouped response must carry groups");
    assert.equal(response.limit, 10);
    assert.deepEqual(response.groups, [
      { count: 2, key: "A first" },
      { count: 1, key: "A shared" },
      { count: 1, key: "B first" },
      { count: 1, key: "B shared" },
    ]);
  });
});

test("aggregateRecordsAcrossBindings merges group_by_time buckets across granted connections", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const response = await aggregateRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { granularity: "day", group_by_time: "received_at", metric: "count" },
      baseManifest
    );
    assert.equal(response.object, "aggregation");
    assert.equal(response.stream, STREAM);
    assert.equal(response.metric, "count");
    assert.equal(response.group_by_time, "received_at");
    assert.equal(response.granularity, "day");
    assert.equal(response.time_zone, "UTC");
    assert.equal(response.filtered_record_count, 4);
    assert.ok("groups" in response, "grouped response must carry groups");
    assert.deepEqual(response.groups, [{ count: 4, key: "2026-05-18" }]);
  });
});

test("aggregateRecordsAcrossBindings rejects exact count_distinct across multiple connections", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    await assert.rejects(
      () =>
        aggregateRecordsAcrossBindings(
          bindings,
          STREAM,
          grant,
          { field: "subject", metric: "count_distinct" },
          baseManifest
        ),
      (err: unknown) =>
        err instanceof Error &&
        hasCode(err) &&
        err.code === "invalid_request" &&
        // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
        /scope with connection_id/.test(err.message)
    );
  });
});

// ─── Streams list fan-in ───────────────────────────────────────────────────

test("listStreamsAcrossBindings emits one summary per (stream, connection_id)", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const summaries = await listStreamsAcrossBindings(bindings, grant, baseManifest);
    assert.equal(summaries.length, 2);
    // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
    const ids = summaries.map((s) => s.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
    for (const summary of summaries) {
      assert.equal(summary.name, STREAM);
      assert.equal(summary.connector_instance_id, summary.connection_id);
      assert.ok(summary.display_name && ["Account A", "Account B"].includes(summary.display_name));
    }
  });
});

// ─── Owner-mode setDisplayName ─────────────────────────────────────────────

test("store.setDisplayName updates the display_name and rejects empty / non-owner / missing", async () => {
  await withSingleConnectionDb(async () => {
    const store = createSqliteConnectorInstanceStore();
    const updated = await store.setDisplayName(INSTANCE_A, {
      displayName: "My Renamed Account",
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.ok(updated, "setDisplayName must return the updated row");
    assert.equal(updated.displayName, "My Renamed Account");

    assert.throws(
      () =>
        store.setDisplayName(INSTANCE_A, {
          displayName: "   ",
          ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        }),
      (err: unknown) => hasCode(err) && err.code === "invalid_request" && err.param === "display_name"
    );

    assert.throws(
      () =>
        store.setDisplayName("cin_missing_instance", {
          displayName: "X",
          ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        }),
      (err: unknown) => hasCode(err) && err.code === "connector_instance_not_found"
    );

    // Owner mismatch: a different subject id must not be able to rename.
    assert.throws(
      () =>
        store.setDisplayName(INSTANCE_A, {
          displayName: "Stolen",
          ownerSubjectId: "someone_else",
        }),
      (err: unknown) => hasCode(err) && err.code === "connector_instance_not_found"
    );
  });
});

test("renamed display_name surfaces on the next records-list fan-in response", async () => {
  await withDualConnectionDb(async () => {
    const store = createSqliteConnectorInstanceStore();
    await store.setDisplayName(INSTANCE_B, {
      displayName: "Account B (Personal)",
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });

    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    const fromB = response.data.find((r) => r.connection_id === INSTANCE_B);
    assert.equal(fromB?.display_name, "Account B (Personal)");
  });
});

// ─── Alias compatibility regression (re-pinned for this tranche) ───────────

test("validateConnectionAlias accepts canonical, accepts alias, rejects conflicts", () => {
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: "cin_x" }));
  assert.doesNotThrow(() => validateConnectionAlias({ connector_instance_id: "cin_x" }));
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: "cin_x", connector_instance_id: "cin_x" }));
  assert.throws(
    () => validateConnectionAlias({ connection_id: "cin_x", connector_instance_id: "cin_y" }),
    (err: unknown) => hasCode(err) && err.code === "invalid_argument" && err.param === "connector_instance_id"
  );
});

// ─── Owner-review revision: P1/P2/P3 regression coverage ───────────────────
//
// All tests below pin the fan-in-branch-revision behavior the owner-review
// memo at `tmp/workstreams/fan-in-branch-owner-review-report.md` flagged.
// The corresponding fixes live in `server/records.js` (helpers) and
// `server/index.js` (route adapters).

test("queryRecordsAcrossBindings rejects changes_since under multi-binding fan-in with retry guidance", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(bindings.length, 2);
    await assert.rejects(
      () => queryRecordsAcrossBindings(bindings, STREAM, grant, { changes_since: "beginning" }, baseManifest),
      (err: unknown) => {
        assert.ok(
          err !== null &&
            typeof err === "object" &&
            "code" in err &&
            "param" in err &&
            "retry_with" in err &&
            "available_connections" in err
        );
        assert.equal(err.code, "invalid_argument");
        assert.equal(err.param, "changes_since");
        assert.equal(err.retry_with, "connection_id");
        assert.ok(Array.isArray(err.available_connections), "expected available_connections list");
        // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
        const ids = (err.available_connections as Array<{ connection_id: string }>).map((c) => c.connection_id).sort();
        assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
        return true;
      }
    );
  });
});

test("queryRecordsAcrossBindings honors changes_since on the single-binding fast path", async () => {
  await withSingleConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(bindings.length, 1);
    const response = await queryRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { changes_since: "beginning" },
      baseManifest
    );
    assert.equal(response.object, "list");
    assert.ok(
      typeof response.next_changes_since === "string" && response.next_changes_since.length > 0,
      "single-binding changes_since must still emit a forward-progress cursor"
    );
  });
});

test("queryRecordsAcrossBindings emits partial_results warning when fan-in collapses pagination", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    // limit=1 forces each binding to report has_more=true so the fan-in
    // wrapper must surface the partial-results warning instead of
    // silently dropping the cursor.
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, { limit: 1 }, baseManifest);
    assert.equal(response.has_more, true);
    assert.equal(response.next_cursor, undefined, "multi-binding fan-in must NOT synthesize next_cursor");
    const warnings = response.meta?.warnings || [];
    const partial = warnings.find((w) => w.code === "partial_results");
    assert.ok(partial, `expected partial_results warning, got ${JSON.stringify(warnings)}`);
    assert.equal(partial.param, "connection_id");
  });
});

test("queryRecordsAcrossBindings sums exact counts honestly across bindings", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, { count: "exact" }, baseManifest);
    assert.equal(response.data.length, 4);
    assert.deepEqual(
      response.meta?.count,
      { kind: "exact", value: 4 },
      "multi-binding count=exact must sum per-binding exact counts, not echo whichever ran last"
    );
  });
});

test("queryRecordsAcrossBindings threads resolver warnings (deprecated alias) into multi-binding meta.warnings", async () => {
  await withDualConnectionDb(async () => {
    const { bindings, warnings } = await resolveReadRequestBindings({
      grant,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestParams: {},
      storageBinding: { connector_id: CONNECTOR_ID },
      streamName: STREAM,
    });
    // Simulate the route's deprecated-alias resolver warnings being
    // threaded into the helper. The two-binding fan-in path strips
    // connection_id/alias per-binding, so without this thread-through the
    // warning would be lost.
    const fakeAliasWarning = {
      code: "deprecated_alias_used",
      message: "`connector_instance_id` is deprecated; send `connection_id` instead.",
      param: "connector_instance_id",
    };
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest, {
      extraWarnings: [...warnings, fakeAliasWarning],
    });
    const surfaced = (response.meta?.warnings || []).find((w) => w.code === "deprecated_alias_used");
    assert.ok(
      surfaced,
      `deprecated_alias_used warning must surface on multi-binding fan-in; got ${JSON.stringify(response.meta?.warnings)}`
    );
  });
});

test("aggregateRecordsAcrossBindings threads resolver warnings into multi-binding meta.warnings", async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const response = await aggregateRecordsAcrossBindings(bindings, STREAM, grant, { metric: "count" }, baseManifest, {
      extraWarnings: [
        {
          code: "deprecated_alias_used",
          message: "`connector_instance_id` is deprecated; send `connection_id` instead.",
          param: "connector_instance_id",
        },
      ],
    });
    const surfaced = (response.meta?.warnings || []).find((w) => w.code === "deprecated_alias_used");
    assert.ok(
      surfaced,
      `aggregate fan-in must carry deprecated_alias_used; got ${JSON.stringify(response.meta?.warnings)}`
    );
  });
});

test("listStreamsAcrossBindings honors per-stream grant connection_id when resolver is supplied", async () => {
  // Two-stream grant where each stream pins a different connection_id.
  // Without per-stream resolution, the route would resolve bindings for
  // grant.streams[0] only and count stream B against binding A's storage.
  await withDualConnectionDb(async () => {
    // Re-seed: add a second stream "tasks" so each connection has its own
    // records under different streams. We seed records via direct ingest
    // for both streams.
    const tasksStream = "tasks";
    const taskManifest = {
      ...baseManifest,
      streams: [
        ...baseManifest.streams,
        {
          consent_time_field: "received_at",
          cursor_field: "received_at",
          name: tasksStream,
          primary_key: ["id"],
          query: { aggregations: { count: true } },
          schema: {
            properties: {
              id: { type: "string" },
              received_at: { format: "date-time", type: "string" },
            },
            required: ["id", "received_at"],
            type: "object",
          },
        },
      ],
    };
    // Records exist on both connections for `messages`; add tasks-specific
    // records only on connection B so we can detect mis-counted fan-in.
    await ingestRecord(target(INSTANCE_B), {
      data: { id: "task-1", received_at: "2026-05-19T00:00:00.000Z" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "task-1",
      stream: tasksStream,
    });

    // Pinned grant: messages → connection A, tasks → connection B.
    const pinnedGrant = {
      streams: [
        { connection_id: INSTANCE_A, fields: ["id", "subject", "received_at"], name: STREAM },
        { connection_id: INSTANCE_B, fields: ["id", "received_at"], name: tasksStream },
      ],
    };

    // Sanity: the default-resolver shape (no per-stream resolver) would
    // resolve bindings against firstStream=messages → connection A only,
    // miss the tasks records on connection B, and emit zero entries for
    // tasks. The per-stream resolver path must show both summaries with
    // honest counts.
    const ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID;
    const resolverFor = async (streamGrant: { name: string; connection_id?: string }) => {
      const { bindings } = await resolveReadRequestBindings({
        grant: pinnedGrant,
        ownerSubjectId,
        requestParams: {},
        storageBinding: { connector_id: CONNECTOR_ID },
        streamName: streamGrant.name,
      });
      return bindings;
    };
    const firstStreamBindings = await resolverFor({ name: STREAM });
    const summaries = await listStreamsAcrossBindings(firstStreamBindings, pinnedGrant, taskManifest, {
      resolveBindingsForStream: resolverFor,
    });
    const messagesA = summaries.find((s) => s.name === STREAM && s.connection_id === INSTANCE_A);
    const tasksB = summaries.find((s) => s.name === tasksStream && s.connection_id === INSTANCE_B);
    assert.ok(messagesA, `expected messages@A summary; got ${JSON.stringify(summaries)}`);
    assert.ok(tasksB, `expected tasks@B summary; got ${JSON.stringify(summaries)}`);
    assert.equal(
      tasksB.record_count,
      1,
      "tasks records under connection B must be counted from B, not borrowed from A"
    );

    // Cross-validation: there should be NO tasks summary under connection A
    // because A is not authorized to read tasks.
    const tasksA = summaries.find((s) => s.name === tasksStream && s.connection_id === INSTANCE_A);
    assert.equal(tasksA, undefined, "tasks must not surface under A when grant pins tasks → B");
  });
});
