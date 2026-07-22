import assert from "node:assert/strict";
import test from "node:test";

import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.js";

const LOOPBACK_PREFIX = "postgresql://postgres:pw@127.0.0.1:55447/";

test("dedicated Postgres URL accepts the fixed database and runner-derived per-file database", () => {
  const direct = `${LOOPBACK_PREFIX}pdpp_test`;
  const runnerDerived = `${LOOPBACK_PREFIX}pdpp_test_connector_summary_stream_facts_monotonic_1`;

  assert.equal(dedicatedPostgresTestUrl(direct), direct);
  assert.equal(dedicatedPostgresTestUrl(runnerDerived), runnerDerived);
});

test("dedicated Postgres URL rejects non-dedicated databases and non-loopback targets", () => {
  for (const candidate of [
    `${LOOPBACK_PREFIX}postgres`,
    `${LOOPBACK_PREFIX}pdpp_test_unbounded_name_without_runner_counter`,
    "postgresql://postgres:pw@localhost:55447/pdpp_test_connector_summary_1",
    "postgresql://postgres:pw@127.0.0.1:5432/pdpp_test_connector_summary_1",
    "postgresql://postgres:pw@192.0.2.1:55447/pdpp_test_connector_summary_1",
  ]) {
    assert.equal(dedicatedPostgresTestUrl(candidate), null, candidate);
  }
});
