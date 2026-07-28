// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `ref.connector-schedule.get`.
 *
 * Pins:
 *   - the success projection: the operation returns the dependency value
 *     unchanged when a schedule exists;
 *   - the typed not-found error mapping: the operation throws
 *     `RefConnectorScheduleGetNotFoundError` with code `'not_found'` when
 *     the dependency returns `null` (or `undefined`);
 *   - that the operation propagates dependency-thrown errors unchanged
 *     so the host can keep its existing error mapping.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  executeRefConnectorScheduleGet,
  RefConnectorScheduleGetNotFoundError,
} from "../operations/ref-connector-schedule-get/index.ts";

test("ref.connector-schedule.get returns the dependency value unchanged when a schedule exists", async () => {
  const schedule = { connector_id: "acme", enabled: true, interval_seconds: 60 };
  const result = await executeRefConnectorScheduleGet(
    { connectorId: "acme" },
    {
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      getConnectorSchedule: async (id) => {
        assert.equal(id, "acme");
        return schedule;
      },
    }
  );
  assert.strictEqual(result, schedule);
});

test("ref.connector-schedule.get throws RefConnectorScheduleGetNotFoundError when dependency returns null", async () => {
  await assert.rejects(
    executeRefConnectorScheduleGet(
      { connectorId: "missing" },
      {
        getConnectorSchedule: async () => null,
      }
    ),
    (err) => {
      assert.ok(err instanceof RefConnectorScheduleGetNotFoundError);
      assert.equal(err.code, "not_found");
      assert.equal(err.connectorId, "missing");
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      assert.match(err.message, /No schedule for connector: missing/);
      return true;
    }
  );
});

test("ref.connector-schedule.get throws RefConnectorScheduleGetNotFoundError when dependency returns undefined", async () => {
  await assert.rejects(
    executeRefConnectorScheduleGet(
      { connectorId: "absent" },
      {
        getConnectorSchedule: async () => undefined,
      }
    ),
    (err) => {
      assert.ok(err instanceof RefConnectorScheduleGetNotFoundError);
      assert.equal(err.connectorId, "absent");
      return true;
    }
  );
});

test("ref.connector-schedule.get propagates dependency-thrown errors unchanged", async () => {
  class DependencyError extends Error {
    code: string;
    constructor() {
      super("controller exploded");
      this.code = "controller_invalid";
    }
  }
  await assert.rejects(
    executeRefConnectorScheduleGet(
      { connectorId: "broken" },
      {
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
        getConnectorSchedule: async () => {
          throw new DependencyError();
        },
      }
    ),
    (err) => {
      assert.ok(err instanceof DependencyError);
      assert.equal(err.code, "controller_invalid");
      return true;
    }
  );
});

test("ref.connector-schedule.get awaits dependency promises before deciding not-found", async () => {
  let resolved = false;
  const schedule = { connector_id: "async", interval_seconds: 60 };
  const result = await executeRefConnectorScheduleGet(
    { connectorId: "async" },
    {
      getConnectorSchedule: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            resolved = true;
            resolve(schedule);
          })
        ),
    }
  );
  assert.equal(resolved, true);
  assert.strictEqual(result, schedule);
});
