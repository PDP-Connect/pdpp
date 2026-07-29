// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `ref.spine.search`.
 *
 * Pins:
 *   - the `{object: 'search_result', exact, traces, grants, runs}`
 *     envelope shape;
 *   - the per-bucket summary discriminators projected onto each entry.
 *
 * Spec: openspec/changes/mount-ref-spine-operations
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RefSpineCorrelationSummary } from "../operations/ref-spine-correlations-list/index.ts";
import { executeRefSpineSearch } from "../operations/ref-spine-search/index.ts";

function summary(idPrefix: string): RefSpineCorrelationSummary {
  return {
    actor_id: "pdpp_reference",
    actor_type: "system",
    client_id: null,
    connector_id: null,
    event_count: 1,
    failure: null,
    first_at: "2026-04-01T00:00:00Z",
    grant_id: null,
    id: idPrefix,
    kinds: ["oauth"],
    last_at: "2026-04-01T00:01:00Z",
    needs_input: false,
    request_id: null,
    run_id: null,
    source: null,
    source_id: null,
    source_kind: null,
    status: "succeeded",
  };
}

test("ref.spine.search emits {object: search_result} envelope with per-kind discriminators", async () => {
  const envelope = await executeRefSpineSearch(
    { query: "q" },
    {
      searchSpine: () => ({
        exact: { id: "trc_x", kind: "trace" },
        grants: [summary("grt_a")],
        runs: [summary("run_a")],
        traces: [summary("trc_a")],
      }),
    }
  );
  assert.equal(envelope.object, "search_result");
  assert.deepEqual(envelope.exact, { id: "trc_x", kind: "trace" });
  const [trace] = envelope.traces;
  assert.ok(trace);
  assert.equal(trace.object, "trace_summary");
  assert.equal(trace.trace_id, "trc_a");
  const [grant] = envelope.grants;
  assert.ok(grant);
  assert.equal(grant.object, "grant_summary");
  assert.equal(grant.grant_id, "grt_a");
  const [run] = envelope.runs;
  assert.ok(run);
  assert.equal(run.object, "run_summary");
  assert.equal(run.run_id, "run_a");
});

test("ref.spine.search emits empty result when search returns no hits", async () => {
  const envelope = await executeRefSpineSearch(
    { query: "" },
    {
      searchSpine: () => ({ exact: null, grants: [], runs: [], traces: [] }),
    }
  );
  assert.equal(envelope.exact, null);
  assert.deepEqual(envelope.traces, []);
  assert.deepEqual(envelope.grants, []);
  assert.deepEqual(envelope.runs, []);
});

test("ref.spine.search filters internal maintenance connectors when host supplies predicate", async () => {
  const internal: RefSpineCorrelationSummary = {
    ...summary("grt_internal"),
    connector_id: "pg_lexical_backfill_1780426329141_34951",
    source_id: "pg_lexical_backfill_1780426329141_34951",
    source_kind: "connector",
  };
  const visible: RefSpineCorrelationSummary = {
    ...summary("grt_visible"),
    connector_id: "slack",
    source_id: "slack",
    source_kind: "connector",
  };
  const envelope = await executeRefSpineSearch(
    { query: "backfill" },
    {
      isInternalConnectorId: (id) => id.startsWith("pg_lexical_backfill_"),
      searchSpine: () => ({
        exact: { id: "grt_internal", kind: "grant" },
        grants: [internal, visible],
        runs: [internal, visible],
        traces: [internal, visible],
      }),
    }
  );
  assert.equal(envelope.exact, null);
  assert.deepEqual(
    envelope.traces.map((entry) => entry.trace_id),
    ["grt_visible"]
  );
  assert.deepEqual(
    envelope.grants.map((entry) => entry.grant_id),
    ["grt_visible"]
  );
  assert.deepEqual(
    envelope.runs.map((entry) => entry.run_id),
    ["grt_visible"]
  );
  const [visibleGrant] = envelope.grants;
  assert.ok(visibleGrant);
  assert.deepEqual(visibleGrant.source, { id: "slack", kind: "connector" });
});

test("ref.spine.search forwards the query string to the dependency unchanged", async () => {
  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  let received = null;
  await executeRefSpineSearch(
    { query: "  some-query  " },
    {
      searchSpine: (query) => {
        received = query;
        return { exact: null, grants: [], runs: [], traces: [] };
      },
    }
  );
  assert.equal(received, "  some-query  ");
});

test("ref.spine.search awaits dependency promises", async () => {
  let resolved = false;
  await executeRefSpineSearch(
    { query: "q" },
    {
      searchSpine: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            resolved = true;
            resolve({ exact: null, grants: [], runs: [], traces: [] });
          })
        ),
    }
  );
  assert.equal(resolved, true);
});
