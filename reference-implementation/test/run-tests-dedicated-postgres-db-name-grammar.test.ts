// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Final-gate revision (2026-07-30) — P1: the full `PDPP_TEST_PROFILE=postgres`
 * suite could not start because `scripts/run-tests.ts`'s per-file database
 * name generator (`deriveDedicatedPostgresDbNameForFile`) produced names
 * that `test/helpers/dedicated-postgres-test-url.ts`'s
 * `isDedicatedPostgresTestDatabaseName` grammar rejected — for TWO
 * independent reasons, both fixed together:
 *
 *   1. The middle segment (`<file-derived-base>_<runnerId>`) can reach 47
 *      characters (38-char base cap + 1 separator + 8-char hex runnerId),
 *      while the prior grammar capped it at 40 — rejecting most real test
 *      file names within a handful of allocations.
 *   2. The trailing counter segment is `fileCounter.toString(36)` —
 *      BASE-36, so it contains lowercase letters once the counter passes 9
 *      — while the prior grammar's trailing pattern (`[1-9][0-9]*`) was
 *      decimal-only, rejecting every allocation past the ninth in a run.
 *      (Widening the trailing segment naively to accept any alphanumeric
 *      string, without also anchoring the fixed-length runnerId segment
 *      immediately before it, made the grammar accept unboundedly long
 *      names instead — the fix had to be structural, not just "loosen the
 *      bound": see the current grammar's doc comment.)
 *
 * This file proves: (1) the generator and the acceptance grammar are
 * mutually consistent for every name the generator can actually produce,
 * across realistic file names and many sequential counter values spanning
 * the base-36 digit/letter boundary; (2) the acceptance grammar still
 * rejects genuinely malformed/unbounded names; (3) a mutation proof —
 * reverting the grammar to its prior, too-narrow shape makes this same test
 * suite fail deterministically on a real generator-produced name, confirming
 * the test is not vacuously green.
 *
 * The generator is imported from `scripts/dedicated-postgres-db-name.ts`
 * (a pure, side-effect-free module) rather than `scripts/run-tests.ts`
 * itself, since that script is a top-level-await CLI entrypoint that starts
 * the full test run as a side effect of being imported.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveDedicatedPostgresDbNameForFile } from "../scripts/dedicated-postgres-db-name.ts";
import {
  dedicatedPostgresTestUrl,
  isDedicatedPostgresTestDatabaseName,
} from "./helpers/dedicated-postgres-test-url.ts";

const LOOPBACK_PREFIX = "postgresql://postgres:pw@127.0.0.1:55447/";
const TEST_RUNNER_ID = "b36787e3";
const PRIOR_DEDICATED_POSTGRES_DATABASE_NAME = /^pdpp_test_[a-z0-9_]{1,40}_[1-9][0-9]*$/;
const BASE_36_A_COUNTER = /_a$/;

/** The prior, too-narrow grammar this pass replaced — used only for the mutation proof below. */
function isDedicatedPostgresTestDatabaseNamePriorGrammar(candidate: string): boolean {
  return candidate === "pdpp_test" || PRIOR_DEDICATED_POSTGRES_DATABASE_NAME.test(candidate);
}

test("deriveDedicatedPostgresDbNameForFile never produces a name the acceptance grammar rejects, for realistic file names", () => {
  const realisticNames = [
    "a.test.ts",
    "connector-summary-stream-facts-monotonic.test.ts",
    "aggregate-request-shape-oracle.test.ts",
    "reconcile-schedule-and-lifecycle-checkpoints.test.ts",
    "ref-connectors-record-corpus-independence.test.ts",
    // Exactly the file name the live gate's failure was reproduced against.
    "connector-instance-mutation-dirty-mark-atomicity.test.ts",
    // Pathologically long, to exercise the 38-char base truncation boundary.
    "a-very-extremely-long-descriptive-test-file-name-that-keeps-going-and-going.test.ts",
  ];
  for (const [index, fileName] of realisticNames.entries()) {
    const dbName = deriveDedicatedPostgresDbNameForFile(`test/${fileName}`, TEST_RUNNER_ID, index + 1);
    assert.ok(
      isDedicatedPostgresTestDatabaseName(dbName),
      `generated name ${dbName} (from ${fileName}) was rejected by the acceptance grammar`
    );
  }
});

test("deriveDedicatedPostgresDbNameForFile stays within the acceptance grammar across many sequential counter values (base-36 growth)", () => {
  // The counter renders in base-36, so this exercises single-digit (1-9),
  // then letter-bearing (a-z), then two-digit (10-ZZ in base36) counter
  // values -- the exact dimension a purely visual read of the regex is
  // likely to get wrong.
  for (let counter = 1; counter <= 80; counter += 1) {
    const dbName = deriveDedicatedPostgresDbNameForFile(
      `test/some-representative-file-name-${counter}.test.ts`,
      TEST_RUNNER_ID,
      counter
    );
    assert.ok(isDedicatedPostgresTestDatabaseName(dbName), `counter=${counter} produced a rejected name: ${dbName}`);
  }
});

test("dedicatedPostgresTestUrl accepts a full loopback URL built from a real generator allocation", () => {
  const dbName = deriveDedicatedPostgresDbNameForFile(
    "test/connector-instance-mutation-dirty-mark-atomicity.test.ts",
    TEST_RUNNER_ID,
    1
  );
  const url = `${LOOPBACK_PREFIX}${dbName}`;
  assert.equal(dedicatedPostgresTestUrl(url), url);
});

test("the acceptance grammar still rejects genuinely malformed or unbounded names", () => {
  for (const candidate of [
    "pdpp_test_unbounded_name_without_runner_counter",
    "pdpp_test_",
    "pdpp_test_x_0",
    "pdpp_test_x_",
    "not_pdpp_test_at_all",
    `pdpp_test_${"x".repeat(200)}_1`,
    "pdpp_test_has-a-dash_1",
  ]) {
    assert.equal(isDedicatedPostgresTestDatabaseName(candidate), false, candidate);
  }
});

test("mutation proof: the prior {1,40}-capped grammar rejects a real generator-produced name", () => {
  const dbName = deriveDedicatedPostgresDbNameForFile(
    "test/connector-instance-mutation-dirty-mark-atomicity.test.ts",
    TEST_RUNNER_ID,
    1
  );
  // The CURRENT grammar accepts it...
  assert.ok(isDedicatedPostgresTestDatabaseName(dbName), `current grammar unexpectedly rejected ${dbName}`);
  // ...but the grammar this pass replaced does not: this is the exact
  // defect the final gate reported (the full-suite runner cannot start
  // because its own generated names are rejected), reproduced here
  // deterministically rather than only by running the whole suite.
  assert.equal(
    isDedicatedPostgresTestDatabaseNamePriorGrammar(dbName),
    false,
    `expected the prior {1,40} grammar to reject ${dbName} (proving this test is not vacuously green)`
  );
});

test("mutation proof: the prior decimal-only trailing-counter grammar rejects a base-36 letter-bearing counter", () => {
  // counter=10 is the first value whose base-36 rendering ("a") contains a
  // letter rather than only digits -- the exact boundary the prior
  // `[1-9][0-9]*` (decimal-only) trailing pattern could never accept,
  // regardless of the middle segment's length.
  const dbName = deriveDedicatedPostgresDbNameForFile("test/short.test.ts", TEST_RUNNER_ID, 10);
  assert.match(dbName, BASE_36_A_COUNTER, `expected counter=10 to render as a trailing "a"; got ${dbName}`);
  assert.ok(isDedicatedPostgresTestDatabaseName(dbName), `current grammar unexpectedly rejected ${dbName}`);
  assert.equal(
    isDedicatedPostgresTestDatabaseNamePriorGrammar(dbName),
    false,
    `expected the prior decimal-only grammar to reject ${dbName} (proving this test is not vacuously green)`
  );
});
