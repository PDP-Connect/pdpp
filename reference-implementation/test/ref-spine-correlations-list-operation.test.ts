// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `ref.spine.correlations.list`.
 *
 * Pins:
 *   - the per-kind `trace_summary` / `grant_summary` / `run_summary`
 *     discriminator;
 *   - the `{object: 'list', data, has_more}` envelope shape;
 *   - the optional `next_cursor` (present iff the dependency exposes
 *     one);
 *   - the per-kind field projection from the underlying spine summary.
 *
 * Spec: openspec/changes/mount-ref-spine-operations
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  executeRefSpineCorrelationsList,
  type RefSpineCorrelationSummary,
} from "../operations/ref-spine-correlations-list/index.ts";

/**
 * `makeSummary` accepts overrides for a superset of `RefSpineCorrelationSummary`
 * fields, plus the test-only `provider_id` field the fixtures carry (unused by
 * the operation, kept to preserve fixture values verbatim). `Partial` lets
 * individual tests override only the fields they care about.
 */
type MakeSummaryOverrides = Partial<RefSpineCorrelationSummary> & {
  provider_id?: string;
};

function makeSummary(overrides: MakeSummaryOverrides = {}): RefSpineCorrelationSummary {
  return {
    actor_id: "pdpp_reference",
    actor_type: "system",
    client_id: "client_x",
    connector_id: "conn_x",
    event_count: 3,
    failure: null,
    first_at: "2026-04-01T00:00:00Z",
    grant_id: "grant_1",
    id: "corr_1",
    kinds: ["oauth", "token"],
    last_at: "2026-04-01T00:01:00Z",
    needs_input: false,
    provider_id: "pdpp_reference",
    request_id: "req_1",
    run_id: "run_1",
    source: null,
    source_id: null,
    source_kind: null,
    status: "succeeded",
    ...overrides,
  };
}

test("ref.spine.correlations.list emits trace_summary discriminator", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "trace" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [makeSummary({ id: "trc_1" })],
      }),
    }
  );
  assert.equal(envelope.object, "list");
  assert.equal(envelope.has_more, false);
  assert.equal(envelope.data.length, 1);
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "trace_summary");
  assert.equal(entry.trace_id, "trc_1");
  assert.equal(entry.request_id, "req_1");
  assert.equal(entry.actor_type, "system");
});

test("ref.spine.correlations.list projects optional trace client metadata without replacing client_id", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "trace" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [
          makeSummary({
            client: {
              client_id: "cli_named",
              client_name: "Claude",
              registration_mode: "dynamic",
            },
            client_id: "cli_named",
            id: "trc_named",
          }),
        ],
      }),
    }
  );
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "trace_summary");
  assert.equal(entry.client_id, "cli_named");
  assert.deepEqual(entry.client, {
    client_id: "cli_named",
    client_name: "Claude",
    registration_mode: "dynamic",
  });
});

test("ref.spine.correlations.list emits grant_summary discriminator with source fallback", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "grant" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [makeSummary({ connector_id: "", id: "grt_1" })],
      }),
    }
  );
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "grant_summary");
  assert.equal(entry.grant_id, "grt_1");
  assert.deepEqual(entry.source, null);
  assert.equal("actor_type" in entry, false);
});

test("ref.spine.correlations.list projects optional grant client metadata without replacing client_id", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "grant" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [
          makeSummary({
            client: {
              client_id: "cli_named",
              client_name: "Claude Code",
              registration_mode: "dynamic",
            },
            client_id: "cli_named",
            id: "grt_named",
          }),
        ],
      }),
    }
  );
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "grant_summary");
  assert.equal(entry.client_id, "cli_named");
  assert.deepEqual(entry.client, {
    client_id: "cli_named",
    client_name: "Claude Code",
    registration_mode: "dynamic",
  });
});

test("ref.spine.correlations.list omits grant client metadata when unavailable", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "grant" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [makeSummary({ client: null, client_id: "cli_unknown", id: "grt_raw" })],
      }),
    }
  );
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "grant_summary");
  assert.equal(entry.client_id, "cli_unknown");
  assert.equal("client" in entry, false);
});

test("ref.spine.correlations.list filters internal maintenance connectors when host supplies predicate", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "grant" },
    {
      isInternalConnectorId: (id) => id.startsWith("pg_lexical_backfill_"),
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [
          makeSummary({
            connector_id: "pg_lexical_backfill_1780426329141_34951",
            id: "grt_internal",
            source_id: "pg_lexical_backfill_1780426329141_34951",
            source_kind: "connector",
          }),
          makeSummary({
            connector_id: "gmail",
            id: "grt_real",
            source_id: "gmail",
            source_kind: "connector",
          }),
        ],
      }),
    }
  );
  assert.equal(envelope.data.length, 1);
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "grant_summary");
  assert.equal(entry.grant_id, "grt_real");
  assert.deepEqual(entry.source, { id: "gmail", kind: "connector" });
});

test("ref.spine.correlations.list does not project client metadata on run summaries", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "run" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [
          makeSummary({
            client: {
              client_id: "cli_named",
              client_name: "Claude Code",
              registration_mode: "dynamic",
            },
            id: "run_named",
          }),
        ],
      }),
    }
  );
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "run_summary");
  assert.equal("client" in entry, false);
});

test("ref.spine.correlations.list emits run_summary discriminator with failure_reason and needs_input", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "run" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [
          makeSummary({
            failure: { event_type: "run.failed", reason: "auth_denied" },
            id: "run_1",
            needs_input: true,
          }),
        ],
      }),
    }
  );
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "run_summary");
  assert.equal(entry.run_id, "run_1");
  assert.equal(entry.needs_input, true);
  assert.equal(entry.failure_reason, "auth_denied");
});

test("ref.spine.correlations.list projects browser-profile connection identity and surface failure reason", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "run" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [
          makeSummary({
            browser_surface_profile_key: "chase:cin_expired_setup",
            browser_surface_status: "surface_failed",
            browser_surface_wait_reason: "surface_unhealthy",
            failure: null,
            id: "run_browser_surface_failed",
            status: "surface_failed",
          }),
        ],
      }),
    }
  );
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "run_summary");
  assert.equal(entry.connection_id, "cin_expired_setup");
  assert.equal(entry.connector_instance_id, "cin_expired_setup");
  assert.equal(entry.browser_surface_profile_key, "chase:cin_expired_setup");
  assert.equal(entry.failure_reason, "surface_unhealthy");
});

test("ref.spine.correlations.list does not invent connection identity from non-connection browser profiles", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "run" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [
          makeSummary({
            browser_surface_profile_key: "managed-profile",
            browser_surface_status: "leased",
            id: "run_managed_profile",
          }),
        ],
      }),
    }
  );
  const [entry] = envelope.data;
  assert.ok(entry);
  assert.equal(entry.object, "run_summary");
  assert.equal("connection_id" in entry, false);
  assert.equal("connector_instance_id" in entry, false);
});

test("ref.spine.correlations.list omits next_cursor when the page does not expose one", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "trace" },
    {
      listSpineCorrelations: () => ({
        hasMore: false,
        nextCursor: null,
        summaries: [],
      }),
    }
  );
  assert.equal("next_cursor" in envelope, false);
});

test("ref.spine.correlations.list emits next_cursor when the page exposes one", async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "trace" },
    {
      listSpineCorrelations: () => ({
        hasMore: true,
        nextCursor: "opaque_cursor_value",
        summaries: [makeSummary()],
      }),
    }
  );
  assert.equal(envelope.has_more, true);
  assert.equal(envelope.next_cursor, "opaque_cursor_value");
});

test("ref.spine.correlations.list forwards the kind and filter bag to the dependency unchanged", async () => {
  let received: { kind: string; filterArg: unknown } | undefined;
  const filters = Object.freeze({ q: "abc", status: "failed" });
  await executeRefSpineCorrelationsList(
    { filters, kind: "grant" },
    {
      listSpineCorrelations: (kind, filterArg) => {
        received = { filterArg, kind };
        return { hasMore: false, nextCursor: null, summaries: [] };
      },
    }
  );
  assert.notEqual(received, undefined);
  if (received !== undefined) {
    assert.equal(received.kind, "grant");
    assert.equal(received.filterArg, filters);
  }
});

test("ref.spine.correlations.list awaits dependency promises", async () => {
  let resolved = false;
  const envelope = await executeRefSpineCorrelationsList(
    { filters: {}, kind: "run" },
    {
      listSpineCorrelations: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            resolved = true;
            resolve({ hasMore: false, nextCursor: null, summaries: [makeSummary({ id: "run_async" })] });
          })
        ),
    }
  );
  assert.equal(resolved, true);
  assert.equal(envelope.data.length, 1);
});
