// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { FetchImpl } from "../lib/owner-session.ts";
import type { OwnerSourcesBrowserFactory } from "./live.ts";
import { checkRestartForRegression, runStreamHealthReceipt, type StreamHealthReceipt } from "./receipt.ts";

type Json = Record<string, unknown>;

const REVISION = "pdpp-reference@1.0.0+abcdef123456";
const EVIDENCE_AT = "2026-08-11T12:00:00.000Z";
const STATUS_500_PATTERN = /500/;

function response(body: unknown, status = 200, revision: string | null = REVISION) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === "pdpp-reference-revision" ? revision : null;
      },
    },
    status,
    text: async () => text,
  };
}

function manifest(): Json {
  return {
    connector_id: "mail",
    version: "manifest-1",
    streams: [
      { name: "messages", required: true, coverage_strategy: "full_inventory", freshness_strategy: "manual_as_of" },
    ],
  };
}

function reliableCondition(overrides: Json = {}): Json {
  return {
    current: true,
    expires_at: null,
    id: "projection-reliable",
    message: "Projection is current",
    observed_at: EVIDENCE_AT,
    origin: "read_model",
    reason: "projection_current",
    reason_code: null,
    remediation: null,
    sensitivity: "public",
    severity: "info",
    status: "true",
    type: "ProjectionReliable",
    ...overrides,
  };
}

function healthyConnection(overrides: Json = {}): Json {
  return {
    connection_id: "c1",
    connector_id: "mail",
    status: "active",
    revoked_at: null,
    streams: ["messages"],
    manifest_version: "manifest-1",
    manifest_declaration: { state: "current", as_of: EVIDENCE_AT, reason_code: null },
    record_snapshot: { state: "current", as_of: EVIDENCE_AT, reason_code: null },
    terminal_facts: { state: "current", event_seq: 1, as_of: EVIDENCE_AT, reason_code: null },
    owner_state: { resolver: "healthy", owner_of_state: "system", posture: "observed" },
    connection_health: {
      state: "healthy",
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" },
      conditions: [reliableCondition()],
    },
    rendered_verdict: { pill: { tone: "green", label: "Healthy" } },
    last_run: { finished_at: EVIDENCE_AT, status: "succeeded", run_id: "run-1" },
    last_successful_run: { finished_at: EVIDENCE_AT, status: "succeeded", run_id: "run-1" },
    collection_report: [
      {
        stream: "messages",
        coverage_condition: "complete",
        coverage_strategy: "full_inventory",
        freshness_strategy: "manual_as_of",
        checkpoint: "checkpoint-1",
        considered: 1,
        covered: 1,
        evidence_as_of: EVIDENCE_AT,
      },
    ],
    stream_records: [{ stream: "messages", record_count: 3, count_state: "known", declaration_state: "declared" }],
    ...overrides,
  };
}

function browserFactoryFromFetch(fetchImpl: FetchImpl): OwnerSourcesBrowserFactory {
  return () => {
    let html = "";
    return Promise.resolve({
      newContext: () =>
        Promise.resolve({
          addCookies: () => Promise.resolve(),
          newPage: () =>
            Promise.resolve({
              goto: async (url: string) => {
                const fetched = await fetchImpl(url);
                html = await fetched.text();
                return {
                  headers: () => ({
                    "pdpp-reference-revision": fetched.headers.get?.("pdpp-reference-revision") ?? "",
                  }),
                };
              },
              waitForFunction: () => Promise.resolve(),
              content: () => Promise.resolve(html),
              close: () => Promise.resolve(),
            }),
          close: () => Promise.resolve(),
        }),
      close: () => Promise.resolve(),
    });
  };
}

function fetchImplFor({
  connections,
  fleetHealth,
  fleetHealthStatus = 200,
}: {
  connections: Json[];
  fleetHealth: Json | null;
  fleetHealthStatus?: number;
}): FetchImpl {
  return (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: connections, has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/connectors/mail") {
      return Promise.resolve(response(manifest()));
    }
    if (parsed.pathname === "/_ref/fleet-health") {
      return Promise.resolve(
        fleetHealth === null ? response("", fleetHealthStatus) : response(fleetHealth, fleetHealthStatus)
      );
    }
    if (parsed.pathname === "/sources") {
      const rows = connections
        .map((c) => {
          let scope = "active";
          if (c.status === "revoked") {
            scope = "revoked";
          }
          if (c.status === "draft") {
            scope = "draft";
          }
          return `<a data-pdpp-source-row="${c.connection_id}" data-pdpp-source-scope="${scope}" href="/sources/${c.connection_id}">${c.connection_id}</a>`;
        })
        .join("");
      return Promise.resolve(response(rows || '<div data-testid="sources-empty">No sources yet</div>'));
    }
    throw new Error(`unexpected test URL ${url}`);
  };
}

test("a fully quiet, settled fleet produces an overall-passing receipt", async () => {
  const fetchImpl = fetchImplFor({
    connections: [healthyConnection()],
    fleetHealth: { state: "healthy", fully_healthy: true, dimensions: {}, scope: {} },
  });
  const receipt = await runStreamHealthReceipt({
    browserFactory: browserFactoryFromFetch(fetchImpl),
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });
  assert.equal(receipt.authority.status, "pass");
  assert.equal(receipt.fleetHealth.state, "healthy");
  assert.equal(receipt.fleetHealth.ok, true);
  assert.equal(receipt.projectionSettlement.evaluated, true);
  assert.equal(receipt.projectionSettlement.settled, true);
  assert.equal(receipt.ok, true);
});

test("an unhealthy fleet banner fails the receipt even when the strict authority passes", async () => {
  const fetchImpl = fetchImplFor({
    connections: [healthyConnection()],
    fleetHealth: { state: "unhealthy", fully_healthy: false, dimensions: {}, scope: {} },
  });
  const receipt = await runStreamHealthReceipt({
    browserFactory: browserFactoryFromFetch(fetchImpl),
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });
  assert.equal(receipt.fleetHealth.state, "unhealthy");
  assert.equal(receipt.fleetHealth.ok, false);
  assert.equal(receipt.ok, false);
});

test("an unsettled projection fails the receipt and names the unresolved cause", async () => {
  const unsettled = healthyConnection({
    connection_id: "c2",
    connection_health: {
      state: "degraded",
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" },
      conditions: [
        reliableCondition({
          reason: "projection_superseded_by_definition_change",
          status: "false",
          severity: "blocked",
        }),
      ],
    },
  });
  const fetchImpl = fetchImplFor({
    connections: [unsettled],
    fleetHealth: { state: "healthy_with_advisories", fully_healthy: false, dimensions: {}, scope: {} },
  });
  const receipt = await runStreamHealthReceipt({
    browserFactory: browserFactoryFromFetch(fetchImpl),
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });
  assert.equal(receipt.projectionSettlement.settled, false);
  assert.equal(receipt.projectionSettlement.unsettledCount, 1);
  assert.equal(receipt.projectionSettlement.rows[0]?.reason, "projection_superseded_by_definition_change");
  assert.equal(receipt.fleetHealth.ok, false, "healthy_with_advisories is not the quiet state");
  assert.equal(receipt.ok, false);
});

test("a fleet-health fetch failure fails closed rather than being silently omitted", async () => {
  const fetchImpl = fetchImplFor({ connections: [healthyConnection()], fleetHealth: null, fleetHealthStatus: 500 });
  const receipt = await runStreamHealthReceipt({
    browserFactory: browserFactoryFromFetch(fetchImpl),
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });
  assert.equal(receipt.fleetHealth.fetched, false);
  assert.equal(receipt.fleetHealth.ok, false);
  assert.match(receipt.fleetHealth.error ?? "", STATUS_500_PATTERN);
  assert.equal(receipt.ok, false);
});

test("no owner session supplied fails closed on every facet", async () => {
  const fetchImpl = fetchImplFor({
    connections: [],
    fleetHealth: { state: "healthy", fully_healthy: true, dimensions: {}, scope: {} },
  });
  const receipt = await runStreamHealthReceipt({
    browserFactory: browserFactoryFromFetch(fetchImpl),
    env: {},
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });
  assert.equal(receipt.authority.fetched, false);
  assert.equal(receipt.fleetHealth.fetched, false);
  assert.equal(receipt.projectionSettlement.evaluated, false);
  assert.equal(receipt.ok, false);
});

function fixtureReceipt(overrides: {
  fleetHealthOk?: boolean;
  fleetHealthState?: string | null;
  ok?: boolean;
  scoreNumerator?: number;
  settled?: boolean;
  unsettledCount?: number;
}): StreamHealthReceipt {
  const numerator = overrides.scoreNumerator ?? 5;
  return {
    authority: {
      score: { denominator: 5, numerator, percentage: (numerator / 5) * 100, ratio: `${numerator}/5` },
    } as StreamHealthReceipt["authority"],
    fleetHealth: {
      error: null,
      fetched: true,
      fullyHealthy: overrides.fleetHealthOk ?? true,
      ok: overrides.fleetHealthOk ?? true,
      state: (overrides.fleetHealthState ?? "healthy") as StreamHealthReceipt["fleetHealth"]["state"],
    },
    generatedAt: "2026-08-27T00:00:00.000Z",
    ok: overrides.ok ?? true,
    origin: "https://example.test",
    projectionSettlement: {
      evaluated: true,
      rows: [],
      settled: overrides.settled ?? true,
      unsettledCount: overrides.unsettledCount ?? 0,
    },
  };
}

test("a controlled restart with no change reports no regression", () => {
  const before = fixtureReceipt({});
  const after = fixtureReceipt({});
  const regressions = checkRestartForRegression(before, after);
  assert.ok(regressions.every((check) => !check.regressed));
});

test("a restart that drops green streams is flagged as a regression", () => {
  const before = fixtureReceipt({ scoreNumerator: 5 });
  const after = fixtureReceipt({ scoreNumerator: 3 });
  const regressions = checkRestartForRegression(before, after);
  const numeratorCheck = regressions.find((check) => check.rule === "authority.score.numerator");
  assert.equal(numeratorCheck?.regressed, true);
});

test("a restart that re-triggers the fleet banner after it was quiet is flagged", () => {
  const before = fixtureReceipt({ fleetHealthOk: true, fleetHealthState: "healthy" });
  const after = fixtureReceipt({ fleetHealthOk: false, fleetHealthState: "unhealthy" });
  const regressions = checkRestartForRegression(before, after);
  const bannerCheck = regressions.find((check) => check.rule === "fleet_banner_quiet");
  assert.equal(bannerCheck?.regressed, true);
});

test("a restart that unsettles a previously-settled projection is flagged", () => {
  const before = fixtureReceipt({ settled: true, unsettledCount: 0 });
  const after = fixtureReceipt({ settled: false, unsettledCount: 2 });
  const regressions = checkRestartForRegression(before, after);
  const settlementCheck = regressions.find((check) => check.rule === "projection_settlement");
  assert.equal(settlementCheck?.regressed, true);
});

test("a restart is never flagged for IMPROVING (banner newly quiet, more green, newly settled)", () => {
  const before = fixtureReceipt({
    scoreNumerator: 3,
    fleetHealthOk: false,
    fleetHealthState: "unhealthy",
    settled: false,
    unsettledCount: 1,
    ok: false,
  });
  const after = fixtureReceipt({
    scoreNumerator: 5,
    fleetHealthOk: true,
    fleetHealthState: "healthy",
    settled: true,
    unsettledCount: 0,
    ok: true,
  });
  const regressions = checkRestartForRegression(before, after);
  assert.ok(regressions.every((check) => !check.regressed));
});
