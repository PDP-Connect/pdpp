// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level tests for `ref.dataset.summary.streams`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the response envelope carries `object: 'dataset_summary_streams'`
 *     and every per-row field;
 *   - the `connector_id` filter is trimmed and treated as `null` when
 *     empty, then forwarded to the host's `listStreams` call;
 *   - NULL record-time bounds are surfaced as `null` rather than being
 *     zero-filled;
 *   - `dirty_record_time_bounds` is coerced to a boolean;
 *   - dependencies may return promises (operation awaits them);
 *   - the operation module obeys the shared operation-boundary rule
 *     (no Fastify, raw DB, sandbox, or `process.env` imports).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RefDatasetSummaryProjectionMetadata } from "../operations/ref-dataset-summary/index.ts";
import { executeRefDatasetSummaryStreams } from "../operations/ref-dataset-summary-streams/index.ts";
import { assertOperationBoundary } from "./helpers/operation-boundary.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function read(rel: string) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

function baselineRow(overrides: Record<string, unknown> = {}) {
  return {
    computed_at: "2026-05-19T12:00:00.000Z",
    connector_id: "gmail",
    consent_time_field: "created_at",
    dirty_record_time_bounds: false,
    earliest_ingested_at: "2026-01-01T00:00:00.000Z",
    earliest_record_time: "2025-12-01T00:00:00.000Z",
    latest_ingested_at: "2026-05-01T00:00:00.000Z",
    latest_record_time: "2026-04-30T00:00:00.000Z",
    record_count: 3,
    record_json_bytes: 120,
    stream: "messages",
    ...overrides,
  };
}

function baselineMetadata(
  overrides: Partial<RefDatasetSummaryProjectionMetadata> = {}
): RefDatasetSummaryProjectionMetadata {
  return {
    computed_at: "2026-05-19T12:00:00.000Z",
    last_error: null,
    rebuild_status: "idle",
    source_high_watermark: "rebuilt:42",
    stale_since: null,
    state: "fresh",
    ...overrides,
  };
}

test("ref.dataset.summary.streams returns the dataset_summary_streams envelope with every per-row field", async () => {
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      getProjectionMetadata: () => baselineMetadata(),
      listStreams: () => [baselineRow()],
    }
  );

  assert.equal(envelope.object, "dataset_summary_streams");
  assert.equal(envelope.filters.connector_id, null);
  assert.equal(envelope.streams.length, 1);
  const [row] = envelope.streams;
  assert.ok(row);
  assert.equal(row.connector_id, "gmail");
  assert.equal(row.stream, "messages");
  assert.equal(row.record_count, 3);
  assert.equal(row.record_json_bytes, 120);
  assert.equal(row.earliest_ingested_at, "2026-01-01T00:00:00.000Z");
  assert.equal(row.latest_ingested_at, "2026-05-01T00:00:00.000Z");
  assert.equal(row.earliest_record_time, "2025-12-01T00:00:00.000Z");
  assert.equal(row.latest_record_time, "2026-04-30T00:00:00.000Z");
  assert.equal(row.consent_time_field, "created_at");
  assert.equal(row.dirty_record_time_bounds, false);
  assert.equal(row.computed_at, "2026-05-19T12:00:00.000Z");
  assert.deepEqual(envelope.projection, baselineMetadata());
});

test("ref.dataset.summary.streams forwards a trimmed connector_id filter to listStreams", async () => {
  // biome-ignore lint/suspicious/noEvolvingTypes: the accumulator intentionally represents heterogeneous fixture observations.
  let received = null;
  await executeRefDatasetSummaryStreams(
    { connector_id: "  gmail  " },
    {
      getProjectionMetadata: () => baselineMetadata(),
      listStreams: (input) => {
        received = input;
        return [];
      },
    }
  );

  assert.deepEqual(received, { connectorId: "gmail" });
});

test("ref.dataset.summary.streams treats an empty connector_id as null", async () => {
  // biome-ignore lint/suspicious/noEvolvingTypes: the accumulator intentionally represents heterogeneous fixture observations.
  let received = null;
  const envelope = await executeRefDatasetSummaryStreams(
    { connector_id: "   " },
    {
      getProjectionMetadata: () => baselineMetadata(),
      listStreams: (input) => {
        received = input;
        return [];
      },
    }
  );

  assert.deepEqual(received, { connectorId: null });
  assert.equal(envelope.filters.connector_id, null);
  assert.deepEqual(envelope.streams, []);
});

test("ref.dataset.summary.streams surfaces NULL record-time bounds as null rather than zero-filling", async () => {
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      getProjectionMetadata: () => baselineMetadata(),
      listStreams: () => [
        baselineRow({
          consent_time_field: null,
          earliest_record_time: null,
          latest_record_time: null,
        }),
        baselineRow({
          earliest_record_time: "",
          latest_record_time: undefined,
          stream: "threads",
        }),
      ],
    }
  );

  const [firstStream, secondStream] = envelope.streams;
  assert.ok(firstStream);
  assert.ok(secondStream);
  assert.equal(firstStream.earliest_record_time, null);
  assert.equal(firstStream.latest_record_time, null);
  assert.equal(firstStream.consent_time_field, null);
  assert.equal(secondStream.earliest_record_time, null);
  assert.equal(secondStream.latest_record_time, null);
});

test("ref.dataset.summary.streams coerces dirty_record_time_bounds to a boolean", async () => {
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      getProjectionMetadata: () => baselineMetadata(),
      listStreams: () => [
        baselineRow({ dirty_record_time_bounds: 1 }),
        baselineRow({ dirty_record_time_bounds: 0, stream: "threads" }),
        baselineRow({ dirty_record_time_bounds: true, stream: "labels" }),
      ],
    }
  );

  const [firstRow, secondRow, thirdRow] = envelope.streams;
  assert.ok(firstRow);
  assert.ok(secondRow);
  assert.ok(thirdRow);
  assert.equal(firstRow.dirty_record_time_bounds, true);
  assert.equal(secondRow.dirty_record_time_bounds, false);
  assert.equal(thirdRow.dirty_record_time_bounds, true);
});

test("ref.dataset.summary.streams awaits async dependencies", async () => {
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      getProjectionMetadata: async () => baselineMetadata({ state: "stale" }),
      listStreams: async () => [baselineRow()],
    }
  );
  assert.equal(envelope.streams.length, 1);
  assert.equal(envelope.projection.state, "stale");
});

test("ref.dataset.summary.streams passes the projection-metadata block through unchanged", async () => {
  const metadata = baselineMetadata({
    last_error: null,
    rebuild_status: "running",
    stale_since: "2026-05-20T00:00:00.000Z",
    state: "rebuilding",
  });
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      getProjectionMetadata: () => metadata,
      listStreams: () => [],
    }
  );
  assert.deepEqual(envelope.projection, metadata);
});

test("ref.dataset.summary.streams operation has no host or storage concretes", () => {
  const rel = "reference-implementation/operations/ref-dataset-summary-streams/index.ts";
  assertOperationBoundary(read(rel), rel);
});
