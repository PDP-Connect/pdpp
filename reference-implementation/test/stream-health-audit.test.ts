// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure stream-health machine audit
 * (scripts/stream-health-audit/audit.ts) and its live auth preflight.
 *
 * The audit now runs in settled/full mode over ConnectorSummary-shaped
 * fixtures:
 *   - required unknown/unmeasured and required+accepted-absence fail on
 *     settled connections regardless of pill label;
 *   - a `draft`/`setup_in_progress` connection is excluded from settled
 *     judgment entirely — it is intentionally owner-discoverable before it
 *     has any coverage evidence (fix-pending-connection-discovery);
 *   - a masked stream is reported once per (stream, evidence class) even
 *     when more than one check inside the audit independently detects it,
 *     while genuinely distinct evidence classes for the same or different
 *     streams still both surface;
 *   - active bounded work is reported as inconclusive, but it does not
 *     suppress masked failures;
 *   - declared-stream count absence fails only when canonical record-snapshot
 *     evidence is current, otherwise it stays inconclusive;
 *   - bearer auth is rejected before HTTP because /_ref/connectors is
 *     cookie-gated.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { FetchImpl } from "../../scripts/lib/owner-session.ts";
import { auditStreamHealth } from "../../scripts/stream-health-audit/audit.ts";
import { runLiveStreamHealthAudit } from "../../scripts/stream-health-audit/live.ts";

function firstOf<T>(items: readonly T[], label: string): T {
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const first = items[0];
  assert.ok(first, `${label}: expected at least one item`);
  return first;
}

function requiredString(value: string | null, label: string): string {
  assert.ok(value !== null, `${label}: expected a non-null string`);
  return value;
}

function healthyVerdict(label = "Healthy", tone = "green") {
  return { pill: { label, tone } };
}

function coverageEntry(overrides: Record<string, unknown> = {}) {
  return {
    checkpoint: "2026-07-09T00:00:00.000Z",
    considered: 1,
    coverage_condition: "complete",
    coverage_strategy: "checkpoint_window",
    covered: 1,
    forward_disposition: "complete",
    freshness_strategy: "scheduled_window",
    required: true,
    stream: "messages",
    ...overrides,
  };
}

function canonicalStream(stream: string, recordCount: number) {
  return { last_updated: null, record_count: recordCount, stream };
}

function settledConnection(overrides: Record<string, unknown> = {}) {
  return {
    collection_report: [coverageEntry(), coverageEntry({ stream: "attachments" })],
    connection_health: {
      badges: { stale: false, syncing: false },
      conditions: [{ status: "true", type: "ProjectionReliable" }],
      state: "healthy",
    },
    connection_id: "conn_a",
    connector_id: "connector_a",
    display_name: "Conn A",
    owner_state: { resolver: "healthy" },
    record_snapshot: { state: "current" },
    rendered_verdict: healthyVerdict(),
    revoked_at: null,
    status: "active",
    stream_records: [canonicalStream("messages", 4), canonicalStream("attachments", 0)],
    streams: ["messages", "attachments"],
    ...overrides,
  };
}

test("settled mode: degraded connection with a required unmeasured stream fails", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          checkpoint: "unknown",
          considered: "unknown",
          coverage_condition: "unknown",
          covered: "unknown",
          forward_disposition: "unmeasured",
          stream: "attachments",
        }),
      ],
      rendered_verdict: healthyVerdict("Degraded", "amber"),
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(firstOf(result.failures, "result.failures").streams, [
    { class: "runtime_evidence_missing", stream: "attachments" },
  ]);
});

test("settled mode: missing coverage_strategy is classified as stored-manifest drift", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          checkpoint: "unknown",
          considered: "unknown",
          coverage_condition: "unknown",
          coverage_strategy: null,
          covered: "unknown",
          forward_disposition: "unmeasured",
          stream: "attachments",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(firstOf(result.failures, "result.failures").streams, [
    { class: "strategy_declaration_missing", stream: "attachments" },
  ]);
});

test("settled mode: blocked connection with a required unmeasured stream fails", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          checkpoint: "unknown",
          considered: "unknown",
          coverage_condition: "unknown",
          covered: "unknown",
          forward_disposition: "unmeasured",
          stream: "attachments",
        }),
      ],
      rendered_verdict: healthyVerdict("Can't collect", "red"),
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(firstOf(result.failures, "result.failures").streams, [
    { class: "runtime_evidence_missing", stream: "attachments" },
  ]);
});

test("machine audit keeps a real ChatGPT-shaped required coverage failure red", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          checkpoint: "unknown",
          considered: "unknown",
          coverage_condition: "unknown",
          covered: "unknown",
          forward_disposition: "unmeasured",
          stream: "shared_conversations",
        }),
      ],
      connector_id: "chatgpt",
      display_name: "ChatGPT",
      stream_records: [canonicalStream("messages", 4), canonicalStream("shared_conversations", 0)],
      streams: ["messages", "shared_conversations"],
    }),
  ]);
  assert.equal(result.status, "fail");
  assert.deepEqual(firstOf(result.failures, "result.failures").streams, [
    { class: "runtime_evidence_missing", stream: "shared_conversations" },
  ]);
});

test("settled mode: optional accepted absence does not fail", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          coverage_condition: "deferred",
          forward_disposition: "complete",
          required: false,
          stream: "attachments",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.inconclusive, []);
});

test("settled mode: active bounded work alone is inconclusive", () => {
  const result = auditStreamHealth([
    settledConnection({
      connection_health: {
        badges: { stale: false, syncing: true },
        conditions: [{ status: "true", type: "ProjectionReliable" }],
        state: "unknown",
      },
      owner_state: { resolver: "collecting" },
      rendered_verdict: healthyVerdict("Checking", "grey"),
    }),
  ]);

  assert.equal(result.status, "inconclusive");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 0);
  assert.equal(result.inconclusive.length, 1);
  assert.deepEqual(firstOf(result.inconclusive, "result.inconclusive").streams, [
    { class: "active_bounded_work", stream: "<active bounded work>" },
  ]);
});

test("settled mode: contradictory active work still fails masked streams", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          checkpoint: "unknown",
          considered: "unknown",
          coverage_condition: "unknown",
          covered: "unknown",
          forward_disposition: "unmeasured",
          stream: "attachments",
        }),
      ],
      connection_health: {
        badges: { stale: false, syncing: true },
        conditions: [{ status: "true", type: "ProjectionReliable" }],
        state: "unknown",
      },
      owner_state: { resolver: "collecting" },
      rendered_verdict: healthyVerdict("Healthy", "green"),
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(firstOf(result.failures, "result.failures").streams, [
    { class: "runtime_evidence_missing", stream: "attachments" },
  ]);
  assert.equal(result.inconclusive.length, 1);
  assert.deepEqual(firstOf(result.inconclusive, "result.inconclusive").streams, [
    { class: "active_bounded_work", stream: "<active bounded work>" },
  ]);
});

test("settled mode: exact zero from a current canonical snapshot passes", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [coverageEntry(), coverageEntry({ stream: "attachments" })],
      stream_records: [canonicalStream("messages", 4), canonicalStream("attachments", 0)],
      streams: ["messages", "attachments"],
    }),
  ]);

  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.inconclusive, []);
});

test("settled mode: stale canonical snapshot keeps declared-stream count unavailable and inconclusive", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [coverageEntry(), coverageEntry({ stream: "attachments" })],
      record_snapshot: { state: "stale" },
      stream_records: [canonicalStream("messages", 4)],
    }),
  ]);

  assert.equal(result.status, "inconclusive");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 0);
  assert.equal(result.inconclusive.length, 1);
  assert.deepEqual(firstOf(result.inconclusive, "result.inconclusive").streams, [
    { class: "declared_stream_count_unavailable", stream: "attachments" },
  ]);
});

test("settled mode: required collection_report entries outside declared streams are still audited", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          checkpoint: "unknown",
          considered: "unknown",
          coverage_condition: "unknown",
          covered: "unknown",
          forward_disposition: "unmeasured",
          stream: "legacy_stream",
        }),
      ],
      stream_records: [canonicalStream("messages", 4), canonicalStream("legacy_stream", 0)],
      streams: ["messages"],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(firstOf(result.failures, "result.failures").streams, [
    { class: "runtime_evidence_missing", stream: "legacy_stream" },
  ]);
  assert.deepEqual(result.inconclusive, []);
});

test("draft connection: status draft is excluded from settled judgment even with an unmeasured required stream", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [],
      connection_id: "conn_draft",
      owner_state: { resolver: "setup_in_progress" },
      rendered_verdict: healthyVerdict("Setup in progress", "grey"),
      status: "draft",
      stream_records: [],
      streams: ["orders"],
    }),
  ]);

  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.inconclusive, []);
});

test("draft connection: owner_state.resolver setup_in_progress alone is excluded even if status is stale/absent", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [],
      connection_id: "conn_draft_stale_status",
      owner_state: { resolver: "setup_in_progress" },
      status: "active",
      stream_records: [],
      streams: ["orders"],
    }),
  ]);

  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("draft connection: active (non-draft) HEB-shaped connection with real missing evidence still fails", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry({
          checkpoint: "unknown",
          considered: "unknown",
          coverage_condition: "unknown",
          covered: "unknown",
          forward_disposition: "unmeasured",
          stream: "orders",
        }),
      ],
      connection_id: "conn_heb_active",
      connector_id: "heb",
      owner_state: { resolver: "healthy" },
      status: "active",
      stream_records: [],
      streams: ["orders"],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.failures.length, 1);
  assert.deepEqual(firstOf(result.failures, "result.failures").streams, [
    { class: "runtime_evidence_missing", stream: "orders" },
  ]);
});

test("duplicate collapse: a stream that is both coverage-unmeasured and retained-record-absent reports once, not twice", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry({
          checkpoint: "unknown",
          considered: "unknown",
          coverage_condition: "unknown",
          covered: "unknown",
          forward_disposition: "unmeasured",
          stream: "orders",
        }),
      ],
      stream_records: [],
      streams: ["orders"],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.failures.length, 1);
  assert.deepEqual(firstOf(result.failures, "result.failures").streams, [
    { class: "runtime_evidence_missing", stream: "orders" },
  ]);
});

test("duplicate collapse does not mask distinct real failures across streams", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          checkpoint: "unknown",
          considered: "unknown",
          coverage_condition: "unknown",
          coverage_strategy: null,
          covered: "unknown",
          forward_disposition: "unmeasured",
          stream: "attachments",
        }),
        coverageEntry({
          coverage_condition: "deferred",
          forward_disposition: "complete",
          required: true,
          stream: "receipts",
        }),
      ],
      stream_records: [
        canonicalStream("messages", 4),
        canonicalStream("attachments", 0),
        canonicalStream("receipts", 0),
      ],
      streams: ["messages", "attachments", "receipts"],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.failures.length, 1);
  const streamsByName = Object.fromEntries(
    firstOf(result.failures, "result.failures").streams.map((s) => [s.stream, s.class])
  );
  assert.deepEqual(streamsByName, {
    attachments: "strategy_declaration_missing",
    receipts: "accepted_absence_on_required",
  });
  assert.equal(firstOf(result.failures, "result.failures").streams.length, 2);
});

test("live audit: bearer auth is rejected before HTTP", async () => {
  let called = false;
  const result = await runLiveStreamHealthAudit({
    env: { PDPP_OWNER_TOKEN: "owner-token-only" },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    fetchImpl: async () => {
      called = true;
      throw new Error("fetch should not run");
    },
    origin: "https://pdpp.example.com",
  });

  assert.equal(called, false);
  assert.equal(result.fetched, false);
  assert.equal(result.authMode, "bearer");
  assert.equal(result.authCapability, "cookie_only");
  assert.equal(result.status, "inconclusive");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(requiredString(result.error, "result.error"), /not supported for \/_ref\/connectors/);
});

test("live audit: PDPP_OWNER_PASSWORD logs in via /owner/login and reaches /_ref/connectors", async () => {
  const cookieHeadersSeen: (string | null)[] = [];
  const response = (status: number, body: string, setCookie: string | null = null) => ({
    headers: {
      get(name: string) {
        return name.toLowerCase() === "set-cookie" ? setCookie : null;
      },
    },
    status,
    text: async () => body,
  });
  // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
  const fetchImpl: FetchImpl = async (url, init) => {
    const href = String(url);
    const initObj = (init as Record<string, unknown> | undefined) || {};
    if (href.includes("/owner/login") && (initObj.method as string | undefined) !== "POST") {
      // Canonical owner landing route is `/`
      // (reference-implementation/test/dashboard-proxy-redirect.test.js pins
      // GET / -> 307 to /owner/login?return_to=%2F). Assert the exact
      // encoded return_to here so a regression to any other value fails
      // this test immediately.
      assert.equal(href, "https://pdpp.example.com/owner/login?return_to=%2F");
      return response(
        200,
        '<input type="hidden" name="_csrf" value="csrf-1" />',
        "pdpp_owner_csrf=csrf-cookie; Path=/"
      );
    }
    if (href.endsWith("/owner/login") && (initObj.method as string | undefined) === "POST") {
      assert.ok(String(initObj.body).includes("password=hunter2"), "login body carries the password to fetch only");
      assert.ok(String(initObj.body).includes("return_to=%2F"));
      const headers = initObj.headers as Record<string, unknown>;
      assert.equal(headers.cookie, "pdpp_owner_csrf=csrf-cookie");
      return response(302, "", "pdpp_owner_session=session-cookie; Path=/; HttpOnly");
    }
    if (href.includes("/_ref/connectors")) {
      const headers = initObj.headers as Record<string, unknown>;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
      cookieHeadersSeen.push((headers?.cookie as string | null) ?? null);
      return response(200, JSON.stringify({ data: [], object: "list" }));
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const result = await runLiveStreamHealthAudit({
    env: { PDPP_OWNER_PASSWORD: "hunter2" },
    fetchImpl,
    origin: "https://pdpp.example.com",
  });

  assert.equal(result.authMode, "password-session");
  assert.equal(result.fetched, true);
  assert.equal(result.status, "pass");
  assert.deepEqual(cookieHeadersSeen, ["pdpp_owner_session=session-cookie"]);
  assert.ok(!JSON.stringify(result).includes("hunter2"), "result must not expose the owner password");
  assert.ok(!JSON.stringify(result).includes("session-cookie"), "result must not expose the owner session cookie");
});

test("live audit: malformed PDPP_OWNER_PASSWORD login (no CSRF field) fails closed as inconclusive", async () => {
  let refConnectorsCalled = false;
  // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
  const fetchImpl: FetchImpl = async (url, init) => {
    const href = String(url);
    const initObj = (init as Record<string, unknown> | undefined) || {};
    if (href.includes("/owner/login") && (initObj.method as string | undefined) !== "POST") {
      // No CSRF cookie/field in the response — malformed/unexpected login page.
      return {
        headers: { get: () => null },
        status: 200,
        text: async () => "<html>no csrf here</html>",
      };
    }
    if (href.includes("/_ref/connectors")) {
      refConnectorsCalled = true;
      return { headers: { get: () => null }, status: 200, text: async () => JSON.stringify({ data: [] }) };
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const result = await runLiveStreamHealthAudit({
    env: { PDPP_OWNER_PASSWORD: "hunter2" },
    fetchImpl,
    origin: "https://pdpp.example.com",
  });

  assert.equal(refConnectorsCalled, false, "must fail closed before ever reaching /_ref/connectors");
  assert.equal(result.fetched, false);
  assert.equal(result.authMode, "password-session");
  assert.equal(result.status, "inconclusive");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(requiredString(result.error, "result.error"), /Owner login via PDPP_OWNER_PASSWORD failed/);
});

test("live audit: no owner session supplied fails closed as inconclusive", async () => {
  const result = await runLiveStreamHealthAudit({
    env: {},
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
    origin: "https://pdpp.example.com",
  });

  assert.equal(result.fetched, false);
  assert.equal(result.authMode, "none");
  assert.equal(result.status, "inconclusive");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(requiredString(result.error, "result.error"), /No owner session supplied/);
});

test("live audit: PDPP_OWNER_SESSION_COOKIE takes precedence over PDPP_OWNER_PASSWORD and never logs in", async () => {
  let loginCalled = false;
  // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
  const fetchImpl: FetchImpl = async (url, init) => {
    const href = String(url);
    const initObj = (init as Record<string, unknown> | undefined) || {};
    if (href.includes("/owner/login")) {
      loginCalled = true;
      throw new Error("must not attempt password login when a cookie is supplied");
    }
    if (href.includes("/_ref/connectors")) {
      const headers = initObj.headers as Record<string, unknown>;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
      assert.equal(headers?.cookie, "pdpp_owner_session=explicit-cookie");
      return { headers: { get: () => null }, status: 200, text: async () => JSON.stringify({ data: [] }) };
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const result = await runLiveStreamHealthAudit({
    env: {
      PDPP_OWNER_PASSWORD: "should-be-ignored",
      PDPP_OWNER_SESSION_COOKIE: "pdpp_owner_session=explicit-cookie",
    },
    fetchImpl,
    origin: "https://pdpp.example.com",
  });

  assert.equal(loginCalled, false);
  assert.equal(result.authMode, "cookie");
  assert.equal(result.fetched, true);
  assert.equal(result.status, "pass");
});

test("empty input passes", () => {
  const result = auditStreamHealth([]);
  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.inconclusive, []);
});
