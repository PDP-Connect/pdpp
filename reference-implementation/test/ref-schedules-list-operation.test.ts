// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `ref.schedules.list`.
 *
 * Pins:
 *   - the `{object: 'list', data}` envelope shape;
 *   - that the operation passes dependency entries through unchanged;
 *   - that the operation awaits dependency promises (no leaked thenables
 *     in the response).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeRefSchedulesList } from "../operations/ref-schedules-list/index.ts";

test("ref.schedules.list emits {object: list, data: []} when there are no schedules", async () => {
  const envelope = await executeRefSchedulesList({
    listSchedules: () => [],
  });
  assert.deepEqual(envelope, { data: [], object: "list" });
});

test("ref.schedules.list passes dependency entries through unchanged", async () => {
  const inputs = [
    { connector_id: "a", enabled: true, interval_seconds: 60 },
    { connector_id: "b", enabled: false, interval_seconds: 300 },
  ];
  const envelope = await executeRefSchedulesList({
    listSchedules: () => inputs,
  });
  assert.equal(envelope.object, "list");
  assert.deepEqual(envelope.data, inputs);
});

test("ref.schedules.list does not mutate the dependency array", async () => {
  const inputs = [{ connector_id: "a" }, { connector_id: "b" }];
  const snapshot = inputs.slice();
  const envelope = await executeRefSchedulesList({
    listSchedules: () => inputs,
  });
  // Envelope.data is a copy, not the dependency array reference.
  assert.notStrictEqual(envelope.data, inputs);
  assert.deepEqual(inputs, snapshot);
});

test("ref.schedules.list awaits dependency promises (dependency-order behavior)", async () => {
  let resolved = false;
  const envelope = await executeRefSchedulesList({
    listSchedules: () =>
      new Promise((resolve) =>
        setImmediate(() => {
          resolved = true;
          resolve([{ connector_id: "async" }]);
        })
      ),
  });
  assert.equal(resolved, true);
  assert.equal(envelope.data.length, 1);
  const [entry] = envelope.data;
  assert.ok(entry && typeof entry === "object" && "connector_id" in entry);
  assert.equal(entry.connector_id, "async");
});
