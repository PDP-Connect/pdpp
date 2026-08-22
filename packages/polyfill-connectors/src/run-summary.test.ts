// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `buildRunSummary` — the pure fold that turns a
 * connector's protocol message stream into the mechanically-produced
 * `pdpp.run-summary/1` artifact `bin/connector-dev.ts` writes to disk.
 *
 * These build summaries from synthetic message arrays only; no subprocess,
 * no filesystem. The subprocess-driven end-to-end proof lives in
 * `bin/connector-dev.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { buildRunSummary, type RunSummaryMeta } from "./run-summary.ts";

const META: RunSummaryMeta = {
  connector: "widgets",
  started_at: "2026-08-13T10:00:00.000Z",
  finished_at: "2026-08-13T10:00:05.000Z",
  tool_version: "test-version",
};

function record(stream: string, key: string, emittedAt = "2026-08-13T10:00:01.000Z"): EmittedMessage {
  return { type: "RECORD", stream, key, data: { id: key }, emitted_at: emittedAt };
}

test("buildRunSummary: counts records per stream and marks state committed", () => {
  const messages: EmittedMessage[] = [
    { type: "PROGRESS", message: "starting" },
    record("items", "item-1"),
    record("items", "item-2"),
    { type: "STATE", stream: "items", cursor: { last_id: "item-2" } },
    { type: "DONE", status: "succeeded", records_emitted: 2 },
  ];

  const summary = buildRunSummary(messages, META);

  assert.equal(summary.format, "pdpp.run-summary/1");
  assert.equal(summary.generated_by, "connector-dev");
  assert.equal(summary.connector, "widgets");
  assert.equal(summary.duration_ms, 5000);
  assert.equal(Object.keys(summary.streams).length, 1);
  assert.equal(summary.streams.items?.records, 2);
  assert.equal(summary.streams.items?.state_emitted, true);
  assert.equal(summary.skips, 0);
  assert.equal(summary.done.status, "succeeded");
  assert.equal(summary.done.error, undefined);
  assert.equal(summary.provider_contact_observed, false);
});

test("buildRunSummary: provider_contact_observed is always false — connector-dev has no transport-observation layer", () => {
  // Regardless of what the run actually did (succeeded, failed, emitted
  // records, made zero calls), this field is a constant honesty signal, not
  // a derived observation — connector-dev never wraps fetch, so it has no
  // mechanism to observe provider contact at all. Checked against both an
  // empty run and a fully successful one to prove it's not conditioned on
  // outcome.
  assert.equal(buildRunSummary([], META).provider_contact_observed, false);
  assert.equal(
    buildRunSummary(
      [
        record("items", "item-1"),
        { type: "STATE", stream: "items", cursor: { last_id: "item-1" } },
        { type: "DONE", status: "succeeded", records_emitted: 1 },
      ],
      META
    ).provider_contact_observed,
    false
  );
});

test("buildRunSummary: no STATE emitted leaves state_emitted false", () => {
  const messages: EmittedMessage[] = [
    record("items", "item-1"),
    { type: "DONE", status: "succeeded", records_emitted: 1 },
  ];

  const summary = buildRunSummary(messages, META);

  assert.equal(summary.streams.items?.records, 1);
  assert.equal(summary.streams.items?.state_emitted, false);
});

test("buildRunSummary: multiple interleaved streams attribute counts independently", () => {
  const messages: EmittedMessage[] = [
    record("orders", "order-1"),
    record("order_details", "detail-1"),
    record("orders", "order-2"),
    { type: "STATE", stream: "orders", cursor: { last_id: "order-2" } },
    record("order_details", "detail-2"),
    { type: "SKIP_RESULT", stream: "order_details", reason: "shape_check_failed", message: "bad shape" },
    { type: "DONE", status: "succeeded", records_emitted: 4 },
  ];

  const summary = buildRunSummary(messages, META);

  assert.equal(summary.streams.orders?.records, 2);
  assert.equal(summary.streams.orders?.state_emitted, true);
  assert.equal(summary.streams.order_details?.records, 2);
  assert.equal(summary.streams.order_details?.state_emitted, false);
  assert.equal(summary.skips, 1);
});

test("buildRunSummary: failure mid-run with no terminal DONE reports status no_done with partial counts", () => {
  const messages: EmittedMessage[] = [record("items", "item-1"), record("items", "item-2")];

  const summary = buildRunSummary(messages, META);

  assert.equal(summary.done.status, "no_done");
  assert.equal(summary.done.error, undefined);
  assert.equal(summary.streams.items?.records, 2);
  assert.equal(summary.streams.items?.state_emitted, false);
});

test("buildRunSummary: failed DONE surfaces error message and retryable flag", () => {
  const messages: EmittedMessage[] = [
    record("items", "item-1"),
    {
      type: "DONE",
      status: "failed",
      records_emitted: 1,
      error: { message: "retry budget exhausted", retryable: true, code: "retry_exhausted" },
    },
  ];

  const summary = buildRunSummary(messages, META);

  assert.equal(summary.done.status, "failed");
  assert.deepEqual(summary.done.error, {
    message: "retry budget exhausted",
    retryable: true,
    code: "retry_exhausted",
  });
  assert.equal(summary.streams.items?.records, 1);
  assert.equal(summary.streams.items?.state_emitted, false);
});

test("buildRunSummary: no messages at all still produces a well-formed summary", () => {
  const summary = buildRunSummary([], META);

  assert.deepEqual(summary.streams, {});
  assert.equal(summary.skips, 0);
  assert.equal(summary.done.status, "no_done");
  assert.equal(summary.done.coverage, undefined);
  assert.equal(summary.done.latest_record_emitted_at, undefined);
});

test("buildRunSummary: latest_record_emitted_at reflects the latest RECORD.emitted_at across streams", () => {
  const messages: EmittedMessage[] = [
    record("items", "item-1", "2026-08-13T09:00:00.000Z"),
    record("items", "item-2", "2026-08-13T11:00:00.000Z"),
    record("other", "item-3", "2026-08-13T10:00:00.000Z"),
    { type: "DONE", status: "succeeded", records_emitted: 3 },
  ];

  const summary = buildRunSummary(messages, META);

  assert.equal(summary.done.latest_record_emitted_at, "2026-08-13T11:00:00.000Z");
});

test("buildRunSummary: DETAIL_COVERAGE messages roll up into done.coverage", () => {
  const messages: EmittedMessage[] = [
    record("orders", "order-1"),
    {
      type: "DETAIL_COVERAGE",
      reference_only: true,
      stream: "order_details",
      state_stream: "orders",
      required_keys: ["order-1", "order-2"],
      hydrated_keys: ["order-1"],
      considered: 2,
      covered: 1,
    },
    { type: "DONE", status: "succeeded", records_emitted: 1 },
  ];

  const summary = buildRunSummary(messages, META);

  assert.deepEqual(summary.done.coverage, {
    considered: 2,
    covered: 1,
    streams: ["order_details"],
  });
});

test("buildRunSummary: DETAIL_COVERAGE without explicit considered/covered falls back to key-array lengths", () => {
  const messages: EmittedMessage[] = [
    {
      type: "DETAIL_COVERAGE",
      reference_only: true,
      stream: "order_details",
      state_stream: "orders",
      required_keys: ["order-1", "order-2", "order-3"],
      hydrated_keys: ["order-1", "order-2"],
    },
  ];

  const summary = buildRunSummary(messages, META);

  assert.deepEqual(summary.done.coverage, {
    considered: 3,
    covered: 2,
    streams: ["order_details"],
  });
});

test("buildRunSummary: duration_ms is non-negative even with an implausible finished_at", () => {
  const summary = buildRunSummary([], {
    ...META,
    started_at: "2026-08-13T10:00:05.000Z",
    finished_at: "2026-08-13T10:00:00.000Z",
  });

  assert.equal(summary.duration_ms, 0);
});

test("buildRunSummary: derives per-stream elapsed time from RECORD timestamps", () => {
  // A total duration cannot tell an author WHERE a long run went: a real ynab
  // run took 75 minutes, dominated by one paced stream. These fields come from
  // timestamps the protocol already carries.
  const summary = buildRunSummary(
    [
      { type: "RECORD", stream: "slow", key: "a", data: {}, emitted_at: "2026-08-13T10:00:00.000Z" },
      { type: "RECORD", stream: "slow", key: "b", data: {}, emitted_at: "2026-08-13T10:05:00.000Z" },
      { type: "RECORD", stream: "fast", key: "c", data: {}, emitted_at: "2026-08-13T10:00:10.000Z" },
      { type: "DONE", status: "succeeded", records_emitted: 3 },
    ] as unknown as Parameters<typeof buildRunSummary>[0],
    {
      connector: "widgets",
      started_at: "2026-08-13T10:00:00.000Z",
      finished_at: "2026-08-13T10:05:00.000Z",
      tool_version: "0.0.1",
    }
  );

  assert.equal(summary.streams.slow?.elapsed_ms, 300_000);
  assert.equal(summary.streams.slow?.first_record_at, "2026-08-13T10:00:00.000Z");
  assert.equal(summary.streams.slow?.last_record_at, "2026-08-13T10:05:00.000Z");
  // A single-record stream has a real, zero-length span — not absent.
  assert.equal(summary.streams.fast?.elapsed_ms, 0);
});
