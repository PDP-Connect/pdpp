// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure stream-health machine audit
 * (scripts/stream-health-audit/audit.mjs) and its live auth preflight.
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

import { auditStreamHealth } from "../../scripts/stream-health-audit/audit.mjs";
import { runLiveStreamHealthAudit } from "../../scripts/stream-health-audit/live.mjs";

function healthyVerdict(label = "Healthy", tone = "green") {
  return { pill: { label, tone } };
}

function coverageEntry(overrides = {}) {
  return {
    stream: "messages",
    coverage_condition: "complete",
    forward_disposition: "complete",
    coverage_strategy: "checkpoint_window",
    freshness_strategy: "scheduled_window",
    checkpoint: "2026-07-09T00:00:00.000Z",
    considered: 1,
    covered: 1,
    required: true,
    ...overrides,
  };
}

function canonicalStream(stream, recordCount) {
  return { stream, record_count: recordCount, last_updated: null };
}

function settledConnection(overrides = {}) {
  return {
    connection_id: "conn_a",
    connector_id: "connector_a",
    display_name: "Conn A",
    status: "active",
    revoked_at: null,
    rendered_verdict: healthyVerdict(),
    connection_health: {
      badges: { syncing: false, stale: false },
      conditions: [{ type: "ProjectionReliable", status: "true" }],
      state: "healthy",
    },
    record_snapshot: { state: "current" },
    owner_state: { resolver: "healthy" },
    streams: ["messages", "attachments"],
    stream_records: [canonicalStream("messages", 4), canonicalStream("attachments", 0)],
    collection_report: [coverageEntry(), coverageEntry({ stream: "attachments" })],
    ...overrides,
  };
}

test("settled mode: degraded connection with a required unmeasured stream fails", () => {
  const result = auditStreamHealth([
    settledConnection({
      rendered_verdict: healthyVerdict("Degraded", "amber"),
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "attachments", class: "runtime_evidence_missing" },
  ]);
});

test("settled mode: missing coverage_strategy is classified as stored-manifest drift", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_strategy: null,
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "attachments", class: "strategy_declaration_missing" },
  ]);
});

test("settled mode: blocked connection with a required unmeasured stream fails", () => {
  const result = auditStreamHealth([
    settledConnection({
      rendered_verdict: healthyVerdict("Can't collect", "red"),
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "attachments", class: "runtime_evidence_missing" },
  ]);
});

test("machine audit keeps a real ChatGPT-shaped required coverage failure red", () => {
  const result = auditStreamHealth([
    settledConnection({
      connector_id: "chatgpt",
      display_name: "ChatGPT",
      streams: ["messages", "shared_conversations"],
      stream_records: [canonicalStream("messages", 4), canonicalStream("shared_conversations", 0)],
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "shared_conversations",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);
  assert.equal(result.status, "fail");
  assert.deepEqual(result.failures[0].streams, [
    { stream: "shared_conversations", class: "runtime_evidence_missing" },
  ]);
});

test("settled mode: optional accepted absence does not fail", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_condition: "deferred",
          forward_disposition: "complete",
          required: false,
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
      rendered_verdict: healthyVerdict("Checking", "grey"),
      connection_health: {
        badges: { syncing: true, stale: false },
        conditions: [{ type: "ProjectionReliable", status: "true" }],
        state: "unknown",
      },
      owner_state: { resolver: "collecting" },
    }),
  ]);

  assert.equal(result.status, "inconclusive");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 0);
  assert.equal(result.inconclusive.length, 1);
  assert.deepEqual(result.inconclusive[0].streams, [
    { stream: "<active bounded work>", class: "active_bounded_work" },
  ]);
});

test("settled mode: contradictory active work still fails masked streams", () => {
  const result = auditStreamHealth([
    settledConnection({
      rendered_verdict: healthyVerdict("Healthy", "green"),
      connection_health: {
        badges: { syncing: true, stale: false },
        conditions: [{ type: "ProjectionReliable", status: "true" }],
        state: "unknown",
      },
      owner_state: { resolver: "collecting" },
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "attachments", class: "runtime_evidence_missing" },
  ]);
  assert.equal(result.inconclusive.length, 1);
  assert.deepEqual(result.inconclusive[0].streams, [
    { stream: "<active bounded work>", class: "active_bounded_work" },
  ]);
});

test("settled mode: exact zero from a current canonical snapshot passes", () => {
  const result = auditStreamHealth([
    settledConnection({
      streams: ["messages", "attachments"],
      stream_records: [canonicalStream("messages", 4), canonicalStream("attachments", 0)],
      collection_report: [coverageEntry(), coverageEntry({ stream: "attachments" })],
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
      record_snapshot: { state: "stale" },
      stream_records: [canonicalStream("messages", 4)],
      collection_report: [coverageEntry(), coverageEntry({ stream: "attachments" })],
    }),
  ]);

  assert.equal(result.status, "inconclusive");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 0);
  assert.equal(result.inconclusive.length, 1);
  assert.deepEqual(result.inconclusive[0].streams, [
    { stream: "attachments", class: "declared_stream_count_unavailable" },
  ]);
});

test("settled mode: required collection_report entries outside declared streams are still audited", () => {
  const result = auditStreamHealth([
    settledConnection({
      streams: ["messages"],
      stream_records: [canonicalStream("messages", 4), canonicalStream("legacy_stream", 0)],
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "legacy_stream",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "legacy_stream", class: "runtime_evidence_missing" },
  ]);
  assert.deepEqual(result.inconclusive, []);
});

test("draft connection: status draft is excluded from settled judgment even with an unmeasured required stream", () => {
  const result = auditStreamHealth([
    settledConnection({
      connection_id: "conn_draft",
      status: "draft",
      rendered_verdict: healthyVerdict("Setup in progress", "grey"),
      owner_state: { resolver: "setup_in_progress" },
      streams: ["orders"],
      stream_records: [],
      collection_report: [],
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
      connection_id: "conn_draft_stale_status",
      status: "active",
      owner_state: { resolver: "setup_in_progress" },
      streams: ["orders"],
      stream_records: [],
      collection_report: [],
    }),
  ]);

  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("draft connection: active (non-draft) HEB-shaped connection with real missing evidence still fails", () => {
  const result = auditStreamHealth([
    settledConnection({
      connection_id: "conn_heb_active",
      connector_id: "heb",
      status: "active",
      owner_state: { resolver: "healthy" },
      streams: ["orders"],
      stream_records: [],
      collection_report: [
        coverageEntry({
          stream: "orders",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [{ stream: "orders", class: "runtime_evidence_missing" }]);
});

test("duplicate collapse: a stream that is both coverage-unmeasured and retained-record-absent reports once, not twice", () => {
  const result = auditStreamHealth([
    settledConnection({
      streams: ["orders"],
      stream_records: [],
      collection_report: [
        coverageEntry({
          stream: "orders",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [{ stream: "orders", class: "runtime_evidence_missing" }]);
});

test("duplicate collapse does not mask distinct real failures across streams", () => {
  const result = auditStreamHealth([
    settledConnection({
      streams: ["messages", "attachments", "receipts"],
      stream_records: [canonicalStream("messages", 4), canonicalStream("attachments", 0), canonicalStream("receipts", 0)],
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_strategy: null,
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
        coverageEntry({
          stream: "receipts",
          coverage_condition: "deferred",
          forward_disposition: "complete",
          required: true,
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.failures.length, 1);
  const streamsByName = Object.fromEntries(result.failures[0].streams.map((s) => [s.stream, s.class]));
  assert.deepEqual(streamsByName, {
    attachments: "strategy_declaration_missing",
    receipts: "accepted_absence_on_required",
  });
  assert.equal(result.failures[0].streams.length, 2);
});

test("live audit: bearer auth is rejected before HTTP", async () => {
  let called = false;
  const result = await runLiveStreamHealthAudit({
    origin: "https://pdpp.example.com",
    env: { PDPP_OWNER_TOKEN: "owner-token-only" },
    fetchImpl: async () => {
      called = true;
      throw new Error("fetch should not run");
    },
  });

  assert.equal(called, false);
  assert.equal(result.fetched, false);
  assert.equal(result.authMode, "bearer");
  assert.equal(result.authCapability, "cookie_only");
  assert.equal(result.status, "inconclusive");
  assert.match(result.error, /not supported for \/_ref\/connectors/);
});

test("live audit: PDPP_OWNER_PASSWORD logs in via /owner/login and reaches /_ref/connectors", async () => {
  const cookieHeadersSeen = [];
  const response = (status, body, setCookie = null) => ({
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "set-cookie" ? setCookie : null;
      },
    },
    text: async () => body,
  });
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/owner/login") && init.method !== "POST") {
      // Canonical owner landing route is `/`
      // (reference-implementation/test/dashboard-proxy-redirect.test.js pins
      // GET / -> 307 to /owner/login?return_to=%2F). Assert the exact
      // encoded return_to here so a regression to any other value fails
      // this test immediately.
      assert.equal(href, "https://pdpp.example.com/owner/login?return_to=%2F");
      return response(200, '<input type="hidden" name="_csrf" value="csrf-1" />', "pdpp_owner_csrf=csrf-cookie; Path=/");
    }
    if (href.endsWith("/owner/login") && init.method === "POST") {
      assert.ok(String(init.body).includes("password=hunter2"), "login body carries the password to fetch only");
      assert.ok(String(init.body).includes("return_to=%2F"));
      assert.equal(init.headers.cookie, "pdpp_owner_csrf=csrf-cookie");
      return response(302, "", "pdpp_owner_session=session-cookie; Path=/; HttpOnly");
    }
    if (href.includes("/_ref/connectors")) {
      cookieHeadersSeen.push(init.headers?.cookie ?? null);
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const result = await runLiveStreamHealthAudit({
    origin: "https://pdpp.example.com",
    env: { PDPP_OWNER_PASSWORD: "hunter2" },
    fetchImpl,
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
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/owner/login") && init.method !== "POST") {
      // No CSRF cookie/field in the response — malformed/unexpected login page.
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => "<html>no csrf here</html>",
      };
    }
    if (href.includes("/_ref/connectors")) {
      refConnectorsCalled = true;
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [] }) };
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const result = await runLiveStreamHealthAudit({
    origin: "https://pdpp.example.com",
    env: { PDPP_OWNER_PASSWORD: "hunter2" },
    fetchImpl,
  });

  assert.equal(refConnectorsCalled, false, "must fail closed before ever reaching /_ref/connectors");
  assert.equal(result.fetched, false);
  assert.equal(result.authMode, "password-session");
  assert.equal(result.status, "inconclusive");
  assert.match(result.error, /Owner login via PDPP_OWNER_PASSWORD failed/);
});

test("live audit: no owner session supplied fails closed as inconclusive", async () => {
  const result = await runLiveStreamHealthAudit({
    origin: "https://pdpp.example.com",
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });

  assert.equal(result.fetched, false);
  assert.equal(result.authMode, "none");
  assert.equal(result.status, "inconclusive");
  assert.match(result.error, /No owner session supplied/);
});

test("live audit: PDPP_OWNER_SESSION_COOKIE takes precedence over PDPP_OWNER_PASSWORD and never logs in", async () => {
  let loginCalled = false;
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/owner/login")) {
      loginCalled = true;
      throw new Error("must not attempt password login when a cookie is supplied");
    }
    if (href.includes("/_ref/connectors")) {
      assert.equal(init.headers?.cookie, "pdpp_owner_session=explicit-cookie");
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [] }) };
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const result = await runLiveStreamHealthAudit({
    origin: "https://pdpp.example.com",
    env: {
      PDPP_OWNER_SESSION_COOKIE: "pdpp_owner_session=explicit-cookie",
      PDPP_OWNER_PASSWORD: "should-be-ignored",
    },
    fetchImpl,
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
