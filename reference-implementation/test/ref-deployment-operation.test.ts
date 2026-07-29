const TOP_LEVEL_REGEX_1 = /invalid provenance/;
const TOP_LEVEL_REGEX_2 = /leaked a secret env value/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `ref.deployment`.
 *
 * Pins:
 *   - the operation calls `collectDeploymentReport` exactly once;
 *   - the operation passes the report through without mutation;
 *   - the operation enforces the env-redaction invariant: every
 *     `environment` entry must declare a known `provenance`, and a
 *     secret entry that is `present` with a non-null value is rejected
 *     so a regressed dependency cannot leak unredacted secrets.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RefDeploymentReport } from "../operations/ref-deployment/index.ts";
import { executeRefDeployment } from "../operations/ref-deployment/index.ts";

function makeReport(overrides: Partial<RefDeploymentReport> = {}): RefDeploymentReport {
  const base: RefDeploymentReport = {
    database: { path: ":memory:" },
    environment: [
      { name: "NODE_ENV", provenance: "present", secret: false, value: "test" },
      { name: "PDPP_OWNER_PASSWORD", provenance: "redacted", secret: true, value: null },
    ],
    lexical: {
      backend: {
        active: "sqlite_fts5",
        configured: false,
        fallback: false,
        pg_search: { available: false, state: "not_applicable" },
      },
      index: { backfill_progress: null, state: "built" },
    },
    manifests: [],
    runtime_capabilities: {
      bindings: { browser: false, filesystem: false, local_device: false, network: true },
      collector_paired: false,
      in_container: false,
    },
    semantic: {
      backend: { available: false, configured: false },
      index: { backfill_progress: null, kind: null, state: null },
      participation: { connector_count: 0, field_count: 0, stream_count: 0, tuples: [] },
    },
    warnings: [],
  };
  return { ...base, ...overrides };
}

test("ref.deployment calls collectDeploymentReport exactly once and passes the report through", async () => {
  let calls = 0;
  const report = makeReport();
  const envelope = await executeRefDeployment({
    collectDeploymentReport: () => {
      calls += 1;
      return report;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(envelope, report);
});

test("ref.deployment awaits an async dependency", async () => {
  let resolved = false;
  const envelope = await executeRefDeployment({
    collectDeploymentReport: () =>
      new Promise((resolve) =>
        setImmediate(() => {
          resolved = true;
          resolve(makeReport());
        })
      ),
  });
  assert.equal(resolved, true);
  assert.equal(envelope.database.path, ":memory:");
});

test("ref.deployment accepts every legal env provenance value", async () => {
  const envelope = await executeRefDeployment({
    collectDeploymentReport: () =>
      makeReport({
        environment: [
          { name: "NODE_ENV", provenance: "present", secret: false, value: "test" },
          { name: "AS_PORT", provenance: "absent", secret: false, value: null },
          { name: "PDPP_OWNER_PASSWORD", provenance: "redacted", secret: true, value: null },
        ],
      }),
  });
  assert.equal(envelope.environment.length, 3);
});

test("ref.deployment rejects an environment entry with an unknown provenance", async () => {
  // Deliberately invalid: a regressed dependency could still emit an
  // environment entry whose `provenance` isn't one of the three known
  // values (that's exactly the defensive invariant under test), so the
  // fixture widens `provenance` to `string` before asserting it back to
  // `RefDeploymentReport` to construct that off-contract shape.
  const invalidProvenance: string = "leaked";
  const reportWithInvalidProvenance = {
    ...makeReport(),
    environment: [{ name: "NODE_ENV", provenance: invalidProvenance, secret: false, value: "test" }],
  } as RefDeploymentReport;

  await assert.rejects(
    () =>
      executeRefDeployment({
        collectDeploymentReport: () => reportWithInvalidProvenance,
      }),
    TOP_LEVEL_REGEX_1
  );
});

test("ref.deployment rejects a secret env value emitted with provenance=present and a non-null value", async () => {
  await assert.rejects(
    () =>
      executeRefDeployment({
        collectDeploymentReport: () =>
          makeReport({
            environment: [
              {
                name: "PDPP_OWNER_PASSWORD",
                provenance: "present",
                secret: true,
                value: "should-have-been-redacted",
              },
            ],
          }),
      }),
    TOP_LEVEL_REGEX_2
  );
});
