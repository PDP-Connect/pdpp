// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `meta.window` bounded record-list aggregate — section 2 of
 * `complete-explorer-slvp-ideal`.
 *
 * Proves the read contract's optional `meta.window` object:
 *
 *   - `window=exact` returns `meta.window.total` and logical min/max
 *     (`earliest_at`/`latest_at`) over the visible filtered rows, sourced from
 *     the stream's `consent_time_field` (NOT the storage ingest `emitted_at`);
 *   - the window reflects the WHOLE filtered, grant-scoped corpus before
 *     pagination, so `limit=1` still reports the full bounds;
 *   - filters, time-range, and grant projection narrow `total` and the bounds;
 *   - absence / `window=none` omits `meta.window`;
 *   - a stream with no declared `consent_time_field` emits `total` without
 *     timestamps (never substituting `emitted_at`);
 *   - missing/unparseable timestamp values are excluded from min/max;
 *   - an empty filtered corpus emits `{ total: 0 }` with no timestamps;
 *   - a `changes_since` read does not carry `meta.window`;
 *   - an invalid `window` value is rejected with the typed invalid-query
 *     discipline used for `count`;
 *   - multi-connection fan-in merges all-present windows (sum / min / max) and
 *     omits the merged window when any binding cannot produce one.
 *
 * These exercise the SQLite reference path and the in-process fan-in merge
 * directly via `queryRecords` / `queryRecordsAcrossBindings`, mirroring
 * `storage-fan-in-read-contract.test.js`. These exercise the SQLite reference
 * path; Postgres now computes `meta.window` to parity (see
 * computePostgresRecordWindow in postgres-records.js), and that parity is
 * pinned by `record-window-count-parity.test.js`.
 *
 * Spec: openspec/changes/complete-explorer-slvp-ideal/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"The record-list read MAY expose bounded window aggregate metadata").
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { resolveFanInBindings } from "../server/connection-identity.ts";
import { closeDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import {
  ingestRecord,
  queryRecordsAcrossBindings as queryRecordsAcrossBindingsUntyped,
  queryRecords as queryRecordsUntyped,
} from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

// `meta` is attached to the response object mutably after the base object
// literal is constructed and returned, so checkJs:false inference over
// records.js never sees it on the return type; `meta.window` is this file's
// entire subject under test, so it must be real, not `unknown`.
interface RecordWindow {
  earliest_at?: string;
  latest_at?: string;
  total: number;
}

interface RecordListMeta {
  window?: RecordWindow;
}

interface RecordListResponse {
  data: unknown[];
  has_more: boolean;
  meta?: RecordListMeta;
  object: string;
}

// queryRecords/queryRecordsAcrossBindings are imported from checkJs:false JS.
// queryRecords's `manifest` parameter defaults to `= null`, so TS infers its
// type as exactly `null | undefined` (the only type visible without checking
// the JS body) -- a real manifest object literal can never satisfy that
// structurally. These wrappers restate both functions' real contracts,
// verified against records.js's parameter defaults and return statements.
type QueryRecordsFn = (
  storageTarget: unknown,
  stream: string,
  grant: unknown,
  requestParams: Record<string, unknown>,
  manifest: unknown
) => Promise<RecordListResponse>;

type QueryRecordsAcrossBindingsFn = (
  bindings: unknown,
  stream: string,
  grant: unknown,
  requestParams: Record<string, unknown>,
  manifest: unknown
) => Promise<RecordListResponse>;

const queryRecords = queryRecordsUntyped as QueryRecordsFn;
const queryRecordsAcrossBindings = queryRecordsAcrossBindingsUntyped as QueryRecordsAcrossBindingsFn;

// records.js throws a plain Error with a bolted-on `code` field for typed
// invalid-query rejections; `useUnknownInCatchVariables`/assert.rejects
// predicates see the caught value as `unknown`.
interface RecordQueryError extends Error {
  code?: string;
}

function isRecordQueryError(value: unknown): value is RecordQueryError {
  return value instanceof Error;
}

const CONNECTOR_ID = "meta-window";
const STREAM = "messages";
const INSTANCE_A = "cin_window_account_a";
const INSTANCE_B = "cin_window_account_b";

// A stream whose logical time lives in `received_at` (consent_time_field) and
// whose `amount` field is range-filterable, so a filter can narrow the corpus.
const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: CONNECTOR_ID,
  display_name: "Meta-window Test Connector",
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: STREAM,
      primary_key: ["id"],
      query: {
        aggregations: { count: true },
        range_filters: { amount: ["gte", "lte"], received_at: ["gte", "lte"] },
      },
      schema: {
        properties: {
          amount: { type: "integer" },
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

// A second connector whose stream declares NO consent_time_field, to prove the
// total-without-timestamps honesty rule.
const NO_TIME_CONNECTOR_ID = "meta-window-no-time";
const NO_TIME_INSTANCE = "cin_window_no_time";
const noTimeManifest = {
  capabilities: { human_interaction: [] },
  connector_id: NO_TIME_CONNECTOR_ID,
  display_name: "No-time Test Connector",
  protocol_version: "0.1.0",
  streams: [
    {
      name: STREAM,
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
          subject: { type: "string" },
        },
        required: ["id", "subject"],
        type: "object",
      },
    },
  ],
  version: "1.0.0",
};

const grant = {
  streams: [{ fields: ["id", "subject", "amount", "received_at"], name: STREAM }],
};

interface StorageTarget {
  connector_id: string;
  connector_instance_id: string;
}

function target(connectorId: string, instanceId: string): StorageTarget {
  return { connector_id: connectorId, connector_instance_id: instanceId };
}

interface RecordData {
  amount?: number;
  id: string;
  received_at?: string;
  subject: string;
}

interface RecordEnvelope {
  data: RecordData;
  emitted_at: string;
  key: string;
  stream: string;
}

function recordPayload(id: string, subject: string, receivedAt: string | null, amount: number | null): RecordEnvelope {
  const data: RecordData = { id, subject };
  if (receivedAt !== null) {
    data.received_at = receivedAt;
  }
  if (amount !== null) {
    data.amount = amount;
  }
  return { data, emitted_at: receivedAt || "2026-05-30T00:00:00.000Z", key: id, stream: STREAM };
}

async function seedInstance(
  connectorId: string,
  instanceId: string,
  displayName: string,
  bindingKey: string
): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorId,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: bindingKey },
    sourceBindingKey: bindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

interface SeededDbOptions {
  records?: RecordEnvelope[];
}

async function withSeededDb(testFn: () => Promise<void>, { records }: SeededDbOptions = {}): Promise<void> {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(CONNECTOR_ID, INSTANCE_A, "Account A", "a@example.com");
    const seed = records || [
      // received_at is intentionally NOT chronological vs ingest order so the
      // min/max logic is exercised over the logical field, not arrival order.
      recordPayload("rec-1", "second", "2024-06-15T08:00:00.000Z", 100),
      recordPayload("rec-2", "earliest", "2020-01-01T00:00:00.000Z", 200),
      recordPayload("rec-3", "latest", "2026-05-29T18:42:11.000Z", 300),
    ];
    for (const r of seed) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      await ingestRecord(target(CONNECTOR_ID, INSTANCE_A), r);
    }
    await testFn();
  } finally {
    closeDb();
  }
}

// ─── total + logical bounds ──────────────────────────────────────────────────

test("window=exact returns total and logical min/max over visible filtered rows", async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: "exact" },
      baseManifest
    );
    assert.ok(response.meta, "meta is present");
    assert.deepEqual(response.meta.window, {
      earliest_at: "2020-01-01T00:00:00.000Z",
      latest_at: "2026-05-29T18:42:11.000Z",
      total: 3,
    });
  });
});

test("window bounds come from consent_time_field, not the storage emitted_at", async () => {
  await withSeededDb(
    async () => {
      // emitted_at for every record diverges from received_at (set far in the
      // future). The window MUST reflect the logical received_at bounds.
      const response = await queryRecords(
        target(CONNECTOR_ID, INSTANCE_A),
        STREAM,
        grant,
        { window: "exact" },
        baseManifest
      );
      // The bounds are the received_at range; if the window used emitted_at it
      // would report the future 2099 ingest stamp instead.
      assert.ok(response.meta?.window, "meta.window is present");
      assert.equal(response.meta.window.earliest_at, "2020-01-01T00:00:00.000Z");
      assert.equal(response.meta.window.latest_at, "2021-01-01T00:00:00.000Z");
    },
    {
      records: [
        // received_at older than emitted_at; if the window used emitted_at it
        // would report the future ingest stamp instead.
        {
          data: { id: "rec-1", received_at: "2020-01-01T00:00:00.000Z", subject: "a" },
          emitted_at: "2099-01-01T00:00:00.000Z",
          key: "rec-1",
          stream: STREAM,
        },
        {
          data: { id: "rec-2", received_at: "2021-01-01T00:00:00.000Z", subject: "b" },
          emitted_at: "2099-01-01T00:00:00.000Z",
          key: "rec-2",
          stream: STREAM,
        },
      ],
    }
  );
});

// ─── page independence ───────────────────────────────────────────────────────

test("limit=1 still reports the full filtered corpus window", async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { limit: "1", window: "exact" },
      baseManifest
    );
    assert.equal(response.data.length, 1, "page is bounded to one record");
    assert.equal(response.has_more, true, "more pages remain");
    assert.ok(response.meta?.window, "meta.window is present");
    assert.deepEqual(
      response.meta.window,
      {
        earliest_at: "2020-01-01T00:00:00.000Z",
        latest_at: "2026-05-29T18:42:11.000Z",
        total: 3,
      },
      "window describes the whole corpus, not the page"
    );
  });
});

// ─── filter / time-range / grant narrowing ───────────────────────────────────

test("a request filter narrows total and tightens the window bounds", async () => {
  await withSeededDb(async () => {
    // amount >= 200 keeps rec-2 (2020) and rec-3 (2026); drops rec-1 (2024).
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { filter: { amount: { gte: "200" } }, window: "exact" },
      baseManifest
    );
    assert.ok(response.meta?.window, "meta.window is present");
    assert.equal(response.meta.window.total, 2);
    assert.equal(response.meta.window.earliest_at, "2020-01-01T00:00:00.000Z");
    assert.equal(response.meta.window.latest_at, "2026-05-29T18:42:11.000Z");
  });
});

test("a grant time_range narrows total and tightens the window bounds", async () => {
  await withSeededDb(async () => {
    const narrowedGrant = {
      streams: [
        {
          fields: ["id", "subject", "amount", "received_at"],
          name: STREAM,
          time_range: { since: "2023-01-01T00:00:00.000Z" },
        },
      ],
    };
    // received_at >= 2023 keeps rec-1 (2024) and rec-3 (2026); drops rec-2 (2020).
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      narrowedGrant,
      { window: "exact" },
      baseManifest
    );
    assert.ok(response.meta?.window, "meta.window is present");
    assert.equal(response.meta.window.total, 2);
    assert.equal(response.meta.window.earliest_at, "2024-06-15T08:00:00.000Z");
    assert.equal(response.meta.window.latest_at, "2026-05-29T18:42:11.000Z");
  });
});

test("a grant resources constraint narrows total and bounds", async () => {
  await withSeededDb(async () => {
    const scopedGrant = {
      streams: [
        {
          fields: ["id", "subject", "amount", "received_at"],
          name: STREAM,
          resources: ["rec-2"],
        },
      ],
    };
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      scopedGrant,
      { window: "exact" },
      baseManifest
    );
    assert.ok(response.meta?.window, "meta.window is present");
    assert.deepEqual(response.meta.window, {
      earliest_at: "2020-01-01T00:00:00.000Z",
      latest_at: "2020-01-01T00:00:00.000Z",
      total: 1,
    });
  });
});

// ─── honest omission ─────────────────────────────────────────────────────────

test("absence of the window param omits meta.window", async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(target(CONNECTOR_ID, INSTANCE_A), STREAM, grant, {}, baseManifest);
    assert.equal(response.meta?.window, undefined, "no window when not requested");
  });
});

test("window=none omits meta.window", async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: "none" },
      baseManifest
    );
    assert.equal(response.meta?.window, undefined, "window=none means omit");
  });
});

test("an empty filtered corpus emits total:0 with no timestamps", async () => {
  await withSeededDb(async () => {
    // amount >= 9999 matches nothing.
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { filter: { amount: { gte: "9999" } }, window: "exact" },
      baseManifest
    );
    assert.ok(response.meta?.window, "meta.window is present");
    assert.deepEqual(response.meta.window, { total: 0 });
    assert.equal(response.meta.window.earliest_at, undefined);
    assert.equal(response.meta.window.latest_at, undefined);
  });
});

test("a stream with no consent_time_field emits total without timestamps", async () => {
  initDb();
  try {
    await registerConnector(noTimeManifest);
    await seedInstance(NO_TIME_CONNECTOR_ID, NO_TIME_INSTANCE, "No-time Account", "n@example.com");
    await ingestRecord(target(NO_TIME_CONNECTOR_ID, NO_TIME_INSTANCE), {
      data: { id: "r1", subject: "x" },
      key: "r1",
      stream: STREAM,
    });
    await ingestRecord(target(NO_TIME_CONNECTOR_ID, NO_TIME_INSTANCE), {
      data: { id: "r2", subject: "y" },
      key: "r2",
      stream: STREAM,
    });
    const noTimeGrant = { streams: [{ fields: ["id", "subject"], name: STREAM }] };
    const response = await queryRecords(
      target(NO_TIME_CONNECTOR_ID, NO_TIME_INSTANCE),
      STREAM,
      noTimeGrant,
      { window: "exact" },
      noTimeManifest
    );
    assert.ok(response.meta?.window, "meta.window is present");
    assert.deepEqual(response.meta.window, { total: 2 }, "total without timestamps");
  } finally {
    closeDb();
  }
});

test("missing/unparseable consent_time_field values are excluded from min/max", async () => {
  await withSeededDb(
    async () => {
      const response = await queryRecords(
        target(CONNECTOR_ID, INSTANCE_A),
        STREAM,
        grant,
        { window: "exact" },
        baseManifest
      );
      // rec-with-bad-time has an unparseable received_at; it counts toward total
      // but not toward the bounds. rec-no-time has no received_at at all.
      assert.ok(response.meta?.window, "meta.window is present");
      assert.equal(response.meta.window.total, 4);
      assert.equal(response.meta.window.earliest_at, "2020-01-01T00:00:00.000Z");
      assert.equal(response.meta.window.latest_at, "2024-06-15T08:00:00.000Z");
    },
    {
      records: [
        recordPayload("rec-good-1", "a", "2020-01-01T00:00:00.000Z", 10),
        recordPayload("rec-good-2", "b", "2024-06-15T08:00:00.000Z", 20),
        {
          data: { id: "rec-bad-time", received_at: "not-a-date", subject: "c" },
          emitted_at: "2026-01-01T00:00:00.000Z",
          key: "rec-bad-time",
          stream: STREAM,
        },
        {
          data: { id: "rec-no-time", subject: "d" },
          emitted_at: "2026-01-01T00:00:00.000Z",
          key: "rec-no-time",
          stream: STREAM,
        },
      ],
    }
  );
});

test("a corpus where every visible row lacks a parseable time emits total only", async () => {
  await withSeededDb(
    async () => {
      const response = await queryRecords(
        target(CONNECTOR_ID, INSTANCE_A),
        STREAM,
        grant,
        { window: "exact" },
        baseManifest
      );
      assert.ok(response.meta?.window, "meta.window is present");
      assert.deepEqual(response.meta.window, { total: 2 });
    },
    {
      records: [
        {
          data: { id: "r1", received_at: "nope", subject: "a" },
          emitted_at: "2026-01-01T00:00:00.000Z",
          key: "r1",
          stream: STREAM,
        },
        { data: { id: "r2", subject: "b" }, emitted_at: "2026-01-01T00:00:00.000Z", key: "r2", stream: STREAM },
      ],
    }
  );
});

// ─── changes_since ───────────────────────────────────────────────────────────

test("a changes_since read with window=exact is rejected (no corpus window on a delta feed)", async () => {
  await withSeededDb(async () => {
    await assert.rejects(
      () =>
        queryRecords(
          target(CONNECTOR_ID, INSTANCE_A),
          STREAM,
          grant,
          { changes_since: "beginning", window: "exact" },
          baseManifest
        ),
      // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
      (err: unknown) => isRecordQueryError(err) && err.code === "invalid_request" && /window/.test(err.message),
      "window is a list-only param, rejected on the changes feed like count"
    );
  });
});

test("a plain changes_since read carries no meta.window", async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { changes_since: "beginning" },
      baseManifest
    );
    assert.equal(response.object, "list");
    assert.equal(response.meta?.window, undefined, "changes feed never carries a window");
  });
});

// ─── invalid value ───────────────────────────────────────────────────────────

test("an invalid window value is rejected with the typed invalid-query discipline", async () => {
  await withSeededDb(async () => {
    await assert.rejects(
      () => queryRecords(target(CONNECTOR_ID, INSTANCE_A), STREAM, grant, { window: "approx" }, baseManifest),
      (err: unknown) =>
        // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
        isRecordQueryError(err) && err.code === "invalid_request" && /window must be one of/.test(err.message)
    );
  });
});

// ─── multi-connection fan-in ─────────────────────────────────────────────────

interface DualWindowDbOptions {
  recordsB?: RecordEnvelope[];
}

async function withDualWindowDb(testFn: () => Promise<void>, { recordsB }: DualWindowDbOptions = {}): Promise<void> {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(CONNECTOR_ID, INSTANCE_A, "Account A", "a@example.com");
    await seedInstance(CONNECTOR_ID, INSTANCE_B, "Account B", "b@example.com");
    await ingestRecord(target(CONNECTOR_ID, INSTANCE_A), recordPayload("a-1", "a-old", "2021-01-01T00:00:00.000Z", 10));
    await ingestRecord(target(CONNECTOR_ID, INSTANCE_A), recordPayload("a-2", "a-new", "2023-01-01T00:00:00.000Z", 20));
    const bSeed = recordsB || [
      recordPayload("b-1", "b-old", "2019-06-01T00:00:00.000Z", 30),
      recordPayload("b-2", "b-new", "2026-01-01T00:00:00.000Z", 40),
    ];
    for (const r of bSeed) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      await ingestRecord(target(CONNECTOR_ID, INSTANCE_B), r);
    }
    await testFn();
  } finally {
    closeDb();
  }
}

test("fan-in merges all-present windows: total sums, bounds are global min/max", async () => {
  await withDualWindowDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, { window: "exact" }, baseManifest);
    assert.ok(response.meta?.window, "meta.window is present");
    assert.deepEqual(response.meta.window, {
      earliest_at: "2019-06-01T00:00:00.000Z", // global min (from B)
      latest_at: "2026-01-01T00:00:00.000Z", // global max (from B)
      total: 4,
    });
  });
});

test("fan-in omits the merged window when one binding cannot produce bounds", async () => {
  await withDualWindowDb(
    async () => {
      const { bindings } = await resolveFanInBindings({
        connectorId: CONNECTOR_ID,
        ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      });
      const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, { window: "exact" }, baseManifest);
      // Binding B has only timestamp-less rows ⇒ its window is { total } with no
      // bounds ⇒ the merged window must omit bounds (all-or-omit on timestamps).
      assert.ok(response.meta?.window, "meta.window is present");
      assert.equal(response.meta.window.total, 4, "totals still sum");
      assert.equal(response.meta.window.earliest_at, undefined, "bounds omitted when a binding lacks them");
      assert.equal(response.meta.window.latest_at, undefined);
    },
    {
      recordsB: [
        { data: { id: "b-1", subject: "x" }, emitted_at: "2026-01-01T00:00:00.000Z", key: "b-1", stream: STREAM },
        { data: { id: "b-2", subject: "y" }, emitted_at: "2026-01-01T00:00:00.000Z", key: "b-2", stream: STREAM },
      ],
    }
  );
});

test("fan-in single-binding path passes meta.window through unchanged", async () => {
  await withSeededDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(bindings.length, 1);
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, { window: "exact" }, baseManifest);
    assert.ok(response.meta?.window, "meta.window is present");
    assert.deepEqual(response.meta.window, {
      earliest_at: "2020-01-01T00:00:00.000Z",
      latest_at: "2026-05-29T18:42:11.000Z",
      total: 3,
    });
  });
});

test("fan-in without the window param omits meta.window", async () => {
  await withDualWindowDb(async () => {
    const { bindings } = await resolveFanInBindings({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    assert.equal(response.meta?.window, undefined);
  });
});
