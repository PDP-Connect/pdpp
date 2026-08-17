// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * dataset-grains render-models — unit coverage for the deployment page's
 * stream-grain and record/blob top-N storage sections.
 *
 * Pins the same invariants as `source-storage.test.ts`:
 * 1. Never fabricate `0`. A missing/non-finite byte value renders `—`.
 * 2. Top-N rows are rendered as-is (already server-bounded) — no
 *    client-side re-sorting past what the server already ranked, no
 *    re-slicing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildDatasetStreamSizeModel, buildDatasetTopModel, buildStreamConnectionLabels } from "./dataset-grains.ts";

// ─── stream-grain model ─────────────────────────────────────────────────────

test("buildDatasetStreamSizeModel renders — for a missing total, never a fabricated 0 B", () => {
  const model = buildDatasetStreamSizeModel([
    { connector_id: "gmail", stream: "messages", total_retained_bytes: null },
  ]);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0]?.sizeLabel, "—");
  assert.equal(model.rows[0]?.sizeMeasured, false);
  assert.equal(model.someMeasured, false);
  assert.doesNotMatch(model.rows[0]?.sizeLabel ?? "", /^0/);
});

test("buildDatasetStreamSizeModel renders — for a non-finite total (NaN), never 0 B", () => {
  const model = buildDatasetStreamSizeModel([
    { connector_id: "gmail", stream: "messages", total_retained_bytes: Number.NaN },
  ]);
  assert.equal(model.rows[0]?.sizeLabel, "—");
});

test("buildDatasetStreamSizeModel formats a measured total and labels connector/stream", () => {
  const model = buildDatasetStreamSizeModel([
    { connector_id: "gmail", stream: "messages", total_retained_bytes: 4_500_000 },
  ]);
  assert.equal(model.rows[0]?.label, "gmail / messages");
  assert.equal(model.rows[0]?.sizeMeasured, true);
  assert.match(model.rows[0]?.sizeLabel ?? "", /MB/);
});

test("buildDatasetStreamSizeModel sorts measured rows before unmeasured rows, bytes descending", () => {
  const model = buildDatasetStreamSizeModel([
    { connector_id: "a", stream: "small", total_retained_bytes: 100 },
    { connector_id: "b", stream: "unmeasured", total_retained_bytes: null },
    { connector_id: "c", stream: "large", total_retained_bytes: 9000 },
  ]);
  assert.deepEqual(
    model.rows.map((r) => r.label),
    ["c / large", "a / small", "b / unmeasured"]
  );
});

// ─── stream disambiguation (regression: 3 ChatGPT connections all rendered
// as an identical "chatgpt / messages" row, indistinguishable) ─────────────

test("buildDatasetStreamSizeModel disambiguates rows that share a connector/stream label", () => {
  const connectionLabels = buildStreamConnectionLabels([
    { connector_instance_id: "cin_chatgpt_1", display_name: "ChatGPT" },
    { connector_instance_id: "cin_chatgpt_2", display_name: "ChatGPT (work)" },
    { connector_instance_id: "cin_chatgpt_3", display_name: "ChatGPT (old)" },
  ]);
  const model = buildDatasetStreamSizeModel(
    [
      {
        connector_id: "chatgpt",
        connector_instance_id: "cin_chatgpt_1",
        stream: "messages",
        total_retained_bytes: 58_000_000,
      },
      {
        connector_id: "chatgpt",
        connector_instance_id: "cin_chatgpt_2",
        stream: "messages",
        total_retained_bytes: 57_300_000,
      },
      {
        connector_id: "chatgpt",
        connector_instance_id: "cin_chatgpt_3",
        stream: "messages",
        total_retained_bytes: 44_900_000,
      },
    ],
    connectionLabels
  );
  const labels = model.rows.map((r) => r.label);
  assert.deepEqual(labels, [
    "chatgpt / messages (ChatGPT)",
    "chatgpt / messages (ChatGPT (work))",
    "chatgpt / messages (ChatGPT (old))",
  ]);
  // Never identical — the whole point of the disambiguator.
  assert.equal(new Set(labels).size, labels.length);
});

test("buildDatasetStreamSizeModel does not disambiguate a stream with only one connection", () => {
  const connectionLabels = buildStreamConnectionLabels([
    { connector_instance_id: "cin_gmail_1", display_name: "Gmail" },
  ]);
  const model = buildDatasetStreamSizeModel(
    [{ connector_id: "gmail", connector_instance_id: "cin_gmail_1", stream: "threads", total_retained_bytes: 1000 }],
    connectionLabels
  );
  assert.equal(model.rows[0]?.label, "gmail / threads");
});

test("buildDatasetStreamSizeModel falls back to the bare connector_instance_id, never a fabricated label, when a duplicate row has no display name", () => {
  const model = buildDatasetStreamSizeModel([
    { connector_id: "reddit", connector_instance_id: "cin_reddit_1", stream: "saved", total_retained_bytes: 10 },
    { connector_id: "reddit", connector_instance_id: "cin_reddit_2", stream: "saved", total_retained_bytes: 20 },
  ]);
  const labels = model.rows.map((r) => r.label);
  assert.deepEqual(labels, ["reddit / saved (cin_reddit_2)", "reddit / saved (cin_reddit_1)"]);
});

test("buildStreamConnectionLabels marks a revoked connection so a duplicate row does not read as equally live", () => {
  const labels = buildStreamConnectionLabels([
    { connector_instance_id: "cin_chatgpt_1", display_name: "ChatGPT", revoked_at: null },
    { connector_instance_id: "cin_chatgpt_2", display_name: "ChatGPT (old)", revoked_at: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal(labels.get("cin_chatgpt_1"), "ChatGPT");
  assert.equal(labels.get("cin_chatgpt_2"), "ChatGPT (old) (revoked)");
});

// ─── top-N model ────────────────────────────────────────────────────────────

test("buildDatasetTopModel renders — for a missing measured value, never a fabricated 0 B", () => {
  const model = buildDatasetTopModel(
    [{ connector_id: "gmail", grain_key: "g1", rank: 1, record_key: "rec_1", stream: "messages" }],
    "record",
    "total_retained_bytes"
  );
  assert.equal(model.rows[0]?.sizeLabel, "—");
  assert.equal(model.rows[0]?.sizeMeasured, false);
});

test("buildDatasetTopModel formats a record row using the requested measure", () => {
  const model = buildDatasetTopModel(
    [
      {
        connector_id: "gmail",
        current_record_json_bytes: 2_000_000,
        grain_key: "g1",
        rank: 1,
        record_key: "rec_1",
        stream: "messages",
        total_retained_bytes: 2_100_000,
      },
    ],
    "record",
    "current_record_json_bytes"
  );
  assert.match(model.rows[0]?.sizeLabel ?? "", /MB/);
  assert.match(model.rows[0]?.label ?? "", /rec_1/);
});

test("buildDatasetTopModel formats a blob row keyed by blob_id", () => {
  const model = buildDatasetTopModel(
    [
      {
        blob_bytes: 900_000,
        blob_id: "blob_sha256_abc",
        connector_id: "gmail",
        grain_key: "g1",
        rank: 1,
        stream: "attachments",
      },
    ],
    "blob",
    "blob_bytes"
  );
  assert.match(model.rows[0]?.label ?? "", /blob_sha256_abc/);
  assert.match(model.rows[0]?.sizeLabel ?? "", /KB|MB/);
});

test("buildDatasetTopModel does not re-sort or re-slice — renders rows in the order the server returned", () => {
  // The server already ranks by the requested measure and bounds to 25 rows
  // (MAX_TOP_LIMIT). The model must not re-derive order from byte value —
  // that would silently diverge from the server's ranking if the client
  // measure differs from the server's sort measure.
  const model = buildDatasetTopModel(
    [
      { blob_bytes: 10, blob_id: "small", grain_key: "g1", rank: 1 },
      { blob_bytes: 9000, blob_id: "large", grain_key: "g2", rank: 2 },
    ],
    "blob",
    "blob_bytes"
  );
  assert.deepEqual(
    model.rows.map((r) => r.rank),
    [1, 2]
  );
  assert.match(model.rows[0]?.label ?? "", /small/);
  assert.match(model.rows[1]?.label ?? "", /large/);
});
