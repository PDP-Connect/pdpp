// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { FetchImpl } from "../lib/owner-session.ts";
import { fetchAllConnectorSummaries } from "../lib/ref-connectors-page-follow.ts";
import {
  evaluateStreamHealthAuthority,
  parseOwnerSourcesDom,
  type StreamHealthAuthorityInput,
  type StreamHealthAuthorityResult,
} from "./authority.ts";
import { type OwnerSourcesBrowserFactory, runLiveStreamHealthAuthority } from "./live.ts";

type Json = Record<string, unknown>;

const REVISION = "pdpp-reference@1.0.0+abcdef123456";
const EVIDENCE_AT = "2026-08-11T12:00:00.000Z";
const SUCCESSFUL_RUNTIME_EVIDENCE_PATTERN = /successful runtime evidence/;
const DISAGREEMENT_PATTERN = /disagrees/;
const PROJECTION_PATTERN = /projection/;
const SOCKET_FAILURE_PATTERN = /socket failed/;
const FUTURE_PROVIDER_REASON_PATTERN = /future_provider_reason/;

function manifest(overrides: Json = {}): Json {
  return {
    connector_id: "mail",
    version: "manifest-1",
    streams: [
      {
        name: "messages",
        required: true,
        coverage_strategy: "full_inventory",
        freshness_strategy: "manual_as_of",
      },
    ],
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
      conditions: [
        {
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
        },
      ],
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

function fullyEvidencedInput(connection: Json, connectorManifest = manifest()): StreamHealthAuthorityInput {
  const synthetic = (connectorManifest.catalog as Json | undefined)?.kind === "test_fixture";
  return {
    auth: { authenticated: true, mode: "test", resolved: true },
    connections: [connection],
    dom: {
      authenticated: true,
      connectionIds: synthetic ? [] : [String(connection.connection_id)],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: synthetic ? null : String(connection.connection_id),
      streamKeys: synthetic ? [] : [{ connectionId: String(connection.connection_id), stream: "messages" }],
      suspense: false,
    },
    manifests: [connectorManifest],
    paginationComplete: true,
    revision: { dom: REVISION, expected: REVISION, sha: "abcdef123456", summaries: REVISION },
  };
}

function evaluate(connection: Json, connectorManifest = manifest()): StreamHealthAuthorityResult {
  return evaluateStreamHealthAuthority(fullyEvidencedInput(connection, connectorManifest));
}

test("structured coverage remains authoritative when rendered DOM evidence is unavailable", () => {
  const healthyInput = fullyEvidencedInput(healthyConnection());
  const healthy = evaluateStreamHealthAuthority({ ...healthyInput, dom: null });
  assert.equal(healthy.coverageStatus, "pass");
  assert.equal(healthy.status, "inconclusive");
  assert.equal(healthy.gates.dom, "inconclusive");

  const incomplete = healthyConnection({
    collection_report: [
      {
        checkpoint: "checkpoint-1",
        considered: 2,
        coverage_condition: "partial",
        coverage_strategy: "full_inventory",
        covered: 1,
        evidence_as_of: EVIDENCE_AT,
        freshness_strategy: "manual_as_of",
        stream: "messages",
      },
    ],
  });
  const incompleteResult = evaluateStreamHealthAuthority({
    ...fullyEvidencedInput(incomplete),
    dom: null,
  });
  assert.equal(incompleteResult.coverageStatus, "fail");
  assert.equal(incompleteResult.status, "fail");
});

function browserFactoryFromFetch(
  fetchImpl: FetchImpl,
  options: {
    cleanupFailures?: ReadonlySet<"browser" | "context" | "page">;
    cleanupCalls?: string[];
    resolveHtml?: string;
    setupFailure?: "browser" | "context" | "cookies" | "page";
    timeout?: boolean;
  } = {}
): OwnerSourcesBrowserFactory {
  const { setupFailure } = options;
  return () => {
    let html = "";
    if (setupFailure === "browser") {
      return Promise.reject(new Error("browser launch failed"));
    }
    return Promise.resolve({
      newContext: () =>
        setupFailure === "context"
          ? Promise.reject(new Error("context setup failed"))
          : Promise.resolve({
              addCookies: () =>
                setupFailure === "cookies" ? Promise.reject(new Error("cookies setup failed")) : Promise.resolve(),
              newPage: () =>
                setupFailure === "page"
                  ? Promise.reject(new Error("page setup failed"))
                  : Promise.resolve({
                      goto: async (url: string) => {
                        const fetched = await fetchImpl(url);
                        html = await fetched.text();
                        return {
                          headers: () => ({
                            "pdpp-reference-revision": fetched.headers.get?.("pdpp-reference-revision") ?? "",
                          }),
                        };
                      },
                      waitForFunction: () => {
                        if (options.timeout) {
                          return Promise.reject(new Error("Timeout 15000ms exceeded"));
                        }
                        if (options.resolveHtml !== undefined) {
                          html = options.resolveHtml;
                        }
                        return Promise.resolve();
                      },
                      content: () => Promise.resolve(html),
                      close: () => {
                        options.cleanupCalls?.push("page");
                        return options.cleanupFailures?.has("page")
                          ? Promise.reject(new Error("page close failed"))
                          : Promise.resolve();
                      },
                    }),
              close: () => {
                options.cleanupCalls?.push("context");
                return options.cleanupFailures?.has("context")
                  ? Promise.reject(new Error("context close failed"))
                  : Promise.resolve();
              },
            }),
      close: () => {
        options.cleanupCalls?.push("browser");
        return options.cleanupFailures?.has("browser")
          ? Promise.reject(new Error("browser close failed"))
          : Promise.resolve();
      },
    });
  };
}

test("live DOM acquisition waits for streamed Next.js content to resolve before parsing", async () => {
  const streamed = '<div aria-busy="true"><template><a data-pdpp-source-row="c1"></a></template></div>';
  const resolved = `<header data-pdpp-reference-revision="${REVISION}"><a data-pdpp-source-row="c1" href="/sources/c1">one</a><a data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages"></a></header>`;
  assert.equal(parseOwnerSourcesDom(streamed).resolved, false);
  const fetchImpl: FetchImpl = (url) => {
    const path = new URL(url).pathname;
    if (path === "/_ref/connectors") {
      return Promise.resolve(response({ data: [healthyConnection()], has_more: false, object: "list" }));
    }
    if (path === "/connectors/mail") {
      return Promise.resolve(response(manifest()));
    }
    if (path === "/sources") {
      return Promise.resolve(response(streamed));
    }
    throw new Error(`unexpected test URL ${url}`);
  };
  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    browserFactory: browserFactoryFromFetch(fetchImpl, { resolveHtml: resolved }),
    origin: "https://example.test",
  });
  assert.equal(result.gates.dom, "resolved");
  assert.equal(result.status, "pass");
});

test("live DOM acquisition fails closed when a streamed page never resolves", async () => {
  const unresolved = '<div aria-busy="true"><template><a data-pdpp-source-row="c1"></a></template></div>';
  const fetchImpl: FetchImpl = (url) => {
    const path = new URL(url).pathname;
    if (path === "/_ref/connectors") {
      return Promise.resolve(response({ data: [], has_more: false, object: "list" }));
    }
    if (path === "/sources") {
      return Promise.resolve(response(unresolved));
    }
    throw new Error(`unexpected test URL ${url}`);
  };
  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    fetchImpl,
    browserFactory: browserFactoryFromFetch(fetchImpl, { timeout: true }),
    origin: "https://example.test",
  });
  assert.equal(result.gates.dom, "inconclusive");
  assert.equal(result.status, "inconclusive");
  assert.equal(result.fetched, true);
});

test("live DOM traversal fails closed on unique-cursor exhaustion", async () => {
  const pageCount = 513;
  let calls = 0;
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [], has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/sources") {
      calls += 1;
      const cursor = parsed.searchParams.get("page_cursor");
      const page = cursor ? Number(cursor.replace("page-", "")) : 1;
      const next = page < pageCount ? `<a href="/sources?page_cursor=page-${page + 1}">Next</a>` : "";
      return Promise.resolve(response(`<div data-testid="sources-empty">empty</div>${next}`));
    }
    throw new Error(`unexpected test URL ${url}`);
  };
  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    fetchImpl,
    origin: "https://example.test",
  });
  assert.equal(calls, 512);
  assert.equal(result.gates.pagination, "inconclusive");
  assert.equal(result.status, "inconclusive");
  assert.ok(
    result.findings.some((finding) => finding.reason === "owner DOM traversal budget exceeded: maximum 512 pages")
  );
});

test("live DOM browser setup failures fail closed at every setup stage", async () => {
  const fetchImpl: FetchImpl = (url) => {
    if (new URL(url).pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [], has_more: false, object: "list" }));
    }
    throw new Error(`unexpected test URL ${url}`);
  };
  for (const stage of ["browser", "context", "cookies", "page"] as const) {
    const cleanupCalls: string[] = [];
    // biome-ignore lint/performance/noAwaitInLoops: each stage is a distinct fail-closed lifecycle assertion.
    const result = await runLiveForTest({
      env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
      fetchImpl,
      browserFactory: browserFactoryFromFetch(fetchImpl, { cleanupCalls, setupFailure: stage }),
      origin: "https://example.test",
    });
    const expectedCleanupCalls = {
      browser: [],
      context: ["browser"],
      cookies: ["context", "browser"],
      page: ["context", "browser"],
    } as const;
    assert.deepEqual(cleanupCalls, expectedCleanupCalls[stage], stage);
    assert.equal(result.gates.dom, "inconclusive", stage);
    assert.ok(
      result.findings.some(
        (finding) =>
          finding.reason ===
          `owner DOM browser setup failed: ${stage === "browser" ? "browser launch failed" : `${stage} setup failed`}`
      ),
      stage
    );
  }
});

test("live DOM cleanup attempts every resource after cleanup failures", async () => {
  const cleanupCalls: string[] = [];
  const fetchImpl: FetchImpl = (url) => {
    if (new URL(url).pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [], has_more: false, object: "list" }));
    }
    if (new URL(url).pathname === "/sources") {
      return Promise.resolve(response('<div data-testid="sources-empty">No sources yet</div>'));
    }
    throw new Error(`unexpected test URL ${url}`);
  };
  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    fetchImpl,
    browserFactory: browserFactoryFromFetch(fetchImpl, {
      cleanupCalls,
      cleanupFailures: new Set(["page", "context"]),
    }),
    origin: "https://example.test",
  });
  assert.deepEqual(cleanupCalls, ["page", "context", "browser"]);
  assert.equal(result.gates.dom, "inconclusive");
  assert.ok(
    result.findings.some(
      (finding) => finding.reason === "owner DOM cleanup failed: page: page close failed; context: context close failed"
    )
  );
});

function runLiveForTest(
  input: Omit<Parameters<typeof runLiveStreamHealthAuthority>[0], "browserFactory"> & {
    browserFactory?: OwnerSourcesBrowserFactory;
  }
) {
  return runLiveStreamHealthAuthority({
    ...input,
    browserFactory:
      input.browserFactory ??
      browserFactoryFromFetch(input.fetchImpl ?? (() => Promise.reject(new Error("missing fetch")))),
  });
}

function streamResult(result: StreamHealthAuthorityResult): StreamHealthAuthorityResult["streams"][number] {
  const stream = result.streams.find((item) => item.stream === "messages");
  assert.ok(stream, "expected a messages stream finding");
  return stream;
}

function unsafeAuthorityInput(value: unknown): StreamHealthAuthorityInput {
  return value as StreamHealthAuthorityInput;
}

function response(body: unknown, status = 200, revision = REVISION) {
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

test("derives an exact green numerator/denominator from active production streams", () => {
  const second = healthyConnection({ connection_id: "c2" });
  const result = evaluateStreamHealthAuthority({
    auth: { authenticated: true, mode: "test", resolved: true },
    connections: [healthyConnection(), second],
    dom: {
      authenticated: true,
      connectionIds: ["c1", "c2"],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: "c1",
      streamKeys: [
        { connectionId: "c1", stream: "messages" },
        { connectionId: "c2", stream: "messages" },
      ],
      suspense: false,
    },
    manifests: [manifest()],
    paginationComplete: true,
    revision: { dom: REVISION, expected: REVISION, sha: "abcdef123456", summaries: REVISION },
  });

  assert.equal(result.status, "pass", JSON.stringify({ gates: result.gates, findings: result.findings }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.score, { denominator: 2, numerator: 2, percentage: 100, ratio: "2/2" });
  assert.equal(result.activeConnectionCount, 2);
  assert.equal(result.productionStreamCount, 2);
  assert.equal(result.perClass.green, 2);
});

test("accepts canonical RI producer reasons but rejects unknown reasons", () => {
  const baseHealth = healthyConnection().connection_health as Json;
  for (const reason of [
    "complete",
    "terminal_gap",
    "interaction_timeout",
    "connector_reported_failed",
    "credentials_required",
  ]) {
    const condition = {
      current: reason === "complete",
      expires_at: null,
      id: `source-coverage-${reason}`,
      message: "Source coverage status",
      observed_at: EVIDENCE_AT,
      origin: "connector",
      reason,
      reason_code: null,
      remediation: null,
      sensitivity: "public",
      severity: reason === "complete" ? "info" : "blocked",
      status: reason === "complete" ? "true" : "false",
      type: "SourceCoverageComplete",
    };
    const result = evaluate(healthyConnection({ connection_health: { ...baseHealth, conditions: [condition] } }));
    assert.equal(result.perClass.unknown_vocabulary, 0, reason);
  }

  const historicalFacts = evaluate(
    healthyConnection({
      terminal_facts: { state: "stale", event_seq: 1, as_of: EVIDENCE_AT, reason_code: "terminal_facts_historical" },
    })
  );
  assert.equal(historicalFacts.perClass.unknown_vocabulary, 0, "terminal_facts_historical");

  const unknown = evaluate(
    healthyConnection({
      connection_health: {
        ...baseHealth,
        conditions: [
          {
            current: true,
            expires_at: null,
            id: "source-coverage-future",
            message: "Source coverage status",
            observed_at: EVIDENCE_AT,
            origin: "connector",
            reason: "future_provider_reason",
            reason_code: null,
            remediation: null,
            sensitivity: "public",
            severity: "info",
            status: "true",
            type: "SourceCoverageComplete",
          },
        ],
      },
    })
  );
  assert.ok(unknown.perClass.unknown_vocabulary > 0);
  assert.match(streamResult(unknown).reason, FUTURE_PROVIDER_REASON_PATTERN);
});

test("strategy-specific coverage proves both an empty source and a zero-delta refresh", () => {
  const connection = healthyConnection();
  const [report] = connection.collection_report as Json[];
  const [record] = connection.stream_records as Json[];
  assert.ok(report);
  assert.ok(record);
  report.considered = 0;
  report.covered = 0;
  record.record_count = 0;
  record.count_state = "known_zero";

  const result = evaluate(connection);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.score, { denominator: 1, numerator: 1, percentage: 100, ratio: "1/1" });
  assert.equal(streamResult(result).reason, "successful runtime evidence plus strategy-proven empty coverage");

  record.record_count = 7;
  record.count_state = "known";
  const zeroDelta = evaluate(connection);
  assert.equal(zeroDelta.status, "pass");
  assert.equal(streamResult(zeroDelta).reason, "successful runtime evidence plus strategy-proven zero-delta coverage");
});

test("healthy local-device receipts prove stream completion only after durable work drains", () => {
  const connection = healthyConnection({
    last_run: null,
    last_successful_run: null,
    local_device_progress: {
      last_heartbeat_at: "2026-08-11T12:00:02.000Z",
      last_heartbeat_status: "healthy",
      last_ingest_at: "2026-08-11T12:00:00.000Z",
      outbox_counts: {
        backlog_open: 0,
        dead_letter: 0,
        leased: 0,
        pending: 0,
        retrying: 0,
        stale_leases: 0,
        succeeded: 2,
        total: 2,
      },
      records_pending: 0,
      source_count: 1,
    },
  });
  const [report] = connection.collection_report as Json[];
  assert.ok(report);
  report.checkpoint = "unknown";
  report.considered = "unknown";
  report.covered = "unknown";
  report.coverage_strategy = "snapshot_import_receipt";
  report.forward_disposition = "complete";
  report.freshness_strategy = "device_heartbeat";

  const localManifest = manifest({
    streams: [
      {
        name: "messages",
        required: true,
        coverage_strategy: "snapshot_import_receipt",
        freshness_strategy: "device_heartbeat",
      },
    ],
  });
  const complete = evaluate(connection, localManifest);
  assert.equal(complete.status, "pass");
  assert.equal(streamResult(complete).reason, "healthy local-device receipt completed this stream with no queued work");

  ((connection.local_device_progress as Json).outbox_counts as Json).pending = 1;
  const pending = evaluate(connection, localManifest);
  assert.equal(pending.status, "fail");
  assert.match(streamResult(pending).reason, SUCCESSFUL_RUNTIME_EVIDENCE_PATTERN);
});

test("false-known-zero is unobserved, while records/checkpoints without a successful run never turn green", () => {
  const falseZero = healthyConnection();
  const [falseZeroReport] = falseZero.collection_report as Json[];
  const [falseZeroRecord] = falseZero.stream_records as Json[];
  assert.ok(falseZeroReport);
  assert.ok(falseZeroRecord);
  falseZeroReport.considered = 0;
  falseZeroReport.covered = 0;
  falseZeroReport.checkpoint = "unknown";
  falseZeroRecord.record_count = 0;
  falseZeroRecord.count_state = "known_zero";
  const falseZeroResult = evaluate(falseZero);
  assert.equal(streamResult(falseZeroResult).class, "unobserved");
  assert.equal(falseZeroResult.numerator, 0);
  assert.equal(falseZeroResult.status, "fail");

  const recordsNoProof = healthyConnection({ last_run: null, last_successful_run: null });
  const recordsNoProofResult = evaluate(recordsNoProof);
  assert.equal(streamResult(recordsNoProofResult).class, "unobserved");
  assert.match(streamResult(recordsNoProofResult).reason, SUCCESSFUL_RUNTIME_EVIDENCE_PATTERN);
  assert.equal(recordsNoProofResult.ok, false);

  const untiedRuntime = healthyConnection({
    last_run: { finished_at: EVIDENCE_AT, status: "succeeded", run_id: "run-2" },
    last_successful_run: { finished_at: EVIDENCE_AT, status: "succeeded", run_id: "run-1" },
  });
  const untiedRuntimeResult = evaluate(untiedRuntime);
  assert.equal(streamResult(untiedRuntimeResult).class, "unobserved");
  assert.match(streamResult(untiedRuntimeResult).reason, SUCCESSFUL_RUNTIME_EVIDENCE_PATTERN);
});

test("omitted authority inputs and an explicitly empty manifest fail closed", () => {
  const omitted = evaluateStreamHealthAuthority(unsafeAuthorityInput({ connections: [healthyConnection()] }));
  assert.equal(omitted.status, "inconclusive");
  assert.equal(omitted.gates.auth, "inconclusive");
  assert.equal(omitted.gates.dom, "inconclusive");
  assert.equal(omitted.gates.revision, "inconclusive");

  const emptyManifest = evaluateStreamHealthAuthority({
    ...fullyEvidencedInput(healthyConnection()),
    manifests: [],
  });
  assert.equal(emptyManifest.status, "inconclusive");
  assert.equal(emptyManifest.perClass.manifest_unavailable, 1);
  assert.equal(emptyManifest.score.denominator, 0);

  const { manifests: omittedManifests, ...omittedManifestInput } = fullyEvidencedInput(healthyConnection());
  assert.ok(omittedManifests);
  const omittedManifest = evaluateStreamHealthAuthority(unsafeAuthorityInput(omittedManifestInput));
  assert.equal(omittedManifest.status, "inconclusive");
  assert.equal(omittedManifest.perClass.manifest_unavailable, 1);
  assert.equal(omittedManifest.score.denominator, 0);
});

test("missing terminal or manifest projection evidence cannot inherit a green runtime result", () => {
  const missingTerminal = healthyConnection({ terminal_facts: null });
  const terminalResult = evaluate(missingTerminal);
  assert.equal(streamResult(terminalResult).class, "unknown_vocabulary");
  assert.match(streamResult(terminalResult).reason, PROJECTION_PATTERN);

  const missingManifestDeclaration = healthyConnection({ manifest_declaration: null });
  const manifestResult = evaluate(missingManifestDeclaration);
  assert.equal(streamResult(manifestResult).class, "unknown_vocabulary");
  assert.match(streamResult(manifestResult).reason, PROJECTION_PATTERN);
});

test("cancelled latest runs, duplicate declarations, and fractional counts are rejected", () => {
  const cancelled = evaluate(healthyConnection({ last_run: { status: "cancelled", run_id: "run-2" } }));
  assert.equal(streamResult(cancelled).class, "failed");

  const duplicateManifest = evaluate(
    healthyConnection(),
    manifest({
      streams: [
        { name: "messages", required: true },
        { name: "messages", required: true },
      ],
    })
  );
  assert.equal(duplicateManifest.perClass.manifest_unavailable, 1);
  assert.equal(duplicateManifest.status, "inconclusive");

  const duplicateManifestRows = evaluateStreamHealthAuthority({
    ...fullyEvidencedInput(healthyConnection()),
    manifests: [manifest(), manifest()],
  });
  assert.equal(duplicateManifestRows.status, "fail");
  assert.ok(duplicateManifestRows.perClass.projection_disagreement > 0);

  const duplicateConnectionStreams = evaluate(healthyConnection({ streams: ["messages", "messages"] }));
  assert.equal(streamResult(duplicateConnectionStreams).class, "projection_disagreement");

  const fractional = healthyConnection();
  const [fractionalReport] = fractional.collection_report as Json[];
  const [fractionalRecord] = fractional.stream_records as Json[];
  assert.ok(fractionalReport);
  assert.ok(fractionalRecord);
  fractionalReport.collected = 0.5;
  fractionalReport.considered = 1.5;
  fractionalReport.covered = 1.5;
  fractionalRecord.record_count = 3.5;
  const fractionalResult = evaluate(fractional);
  assert.equal(streamResult(fractionalResult).class, "projection_disagreement");
  assert.equal(fractionalResult.status, "fail");

  const fractionalCoverage = healthyConnection();
  const [fractionalCoverageReport] = fractionalCoverage.collection_report as Json[];
  assert.ok(fractionalCoverageReport);
  fractionalCoverageReport.considered = 1.5;
  fractionalCoverageReport.covered = 1.5;
  const fractionalCoverageResult = evaluate(fractionalCoverage);
  assert.equal(streamResult(fractionalCoverageResult).class, "unobserved");
  assert.equal(fractionalCoverageResult.status, "fail");
});

test("owner cancellation keeps the prior successful runtime proof authoritative", () => {
  const cancelled = evaluate(
    healthyConnection({
      last_run: {
        finished_at: "2026-05-19T12:05:00.000Z",
        run_id: "run-owner-cancelled",
        status: "cancelled",
        terminal_reason: "owner_cancelled",
      },
    })
  );

  assert.equal(streamResult(cancelled).class, "green");
});

test("stale projection is distinct from unobserved and cannot be laundered by a green pill", () => {
  const connection = healthyConnection();
  (connection.record_snapshot as Json).state = "stale";
  const result = evaluate(connection);

  assert.equal(streamResult(result).class, "stale");
  assert.equal(result.perClass.stale, 1);
  assert.equal(result.status, "fail");
});

test("distinguishes active work, owner interaction, provider/config blocked, failed, unobserved, optional unsupported, and revoked", () => {
  const cases: Array<{ expected: string; make: () => Json; connectorManifest?: Json }> = [
    {
      expected: "active_bounded_work",
      make: () => healthyConnection({ owner_state: { resolver: "collecting" } }),
    },
    {
      expected: "owner_interaction",
      make: () => healthyConnection({ owner_state: { resolver: "needs_owner" } }),
    },
    {
      expected: "provider_config_blocked",
      make: () =>
        healthyConnection({
          connection_health: { state: "blocked", axes: {} },
          rendered_verdict: { pill: { tone: "red" } },
        }),
    },
    {
      expected: "failed",
      make: () => healthyConnection({ last_run: { status: "failed" }, rendered_verdict: { pill: { tone: "red" } } }),
    },
    {
      expected: "unobserved",
      make: () => {
        const connection = healthyConnection();
        connection.collection_report = undefined;
        return connection;
      },
    },
    {
      expected: "optional_unsupported",
      make: () => healthyConnection(),
      connectorManifest: manifest({ streams: [{ name: "messages", required: false, coverage_policy: "unsupported" }] }),
    },
    {
      expected: "revoked",
      make: () => healthyConnection({ status: "revoked", revoked_at: "2026-08-11T00:00:00.000Z" }),
    },
  ];

  for (const item of cases) {
    const result = evaluate(item.make(), item.connectorManifest ?? manifest());
    assert.equal(streamResult(result).class, item.expected, item.expected);
  }
});

test("accepts a successful runtime-proven absence only for an optional stream", () => {
  const optionalUnavailable = healthyConnection();
  const [optionalReport] = optionalUnavailable.collection_report as Json[];
  assert.ok(optionalReport);
  optionalReport.coverage_condition = "unavailable";
  optionalReport.forward_disposition = "terminal";
  optionalReport.required = false;
  optionalReport.checkpoint = "not_staged";
  optionalReport.considered = null;
  optionalReport.covered = null;
  optionalReport.skipped = { reason: "provider_resource_unavailable", recovery_action: "upstream_unblock" };
  optionalUnavailable.stream_records = [
    { stream: "messages", record_count: 0, count_state: "unobserved", declaration_state: "declared" },
  ];

  const optionalManifest = manifest({
    streams: [
      {
        name: "messages",
        required: false,
        coverage_strategy: "full_inventory",
        freshness_strategy: "manual_as_of",
      },
    ],
  });
  assert.equal(streamResult(evaluate(optionalUnavailable, optionalManifest)).class, "green");

  const requiredUnavailable = structuredClone(optionalUnavailable);
  const [requiredReport] = requiredUnavailable.collection_report as Json[];
  assert.ok(requiredReport);
  requiredReport.required = true;
  assert.notEqual(streamResult(evaluate(requiredUnavailable)).class, "green");

  const optionalWithoutSkip = structuredClone(optionalUnavailable);
  const [reportWithoutSkip] = optionalWithoutSkip.collection_report as Json[];
  assert.ok(reportWithoutSkip);
  reportWithoutSkip.skipped = null;
  assert.equal(streamResult(evaluate(optionalWithoutSkip, optionalManifest)).class, "unobserved");
});

test("uses the collection-report forward disposition and fails closed on manifest vocabulary/contradictions", () => {
  const active = healthyConnection();
  const [activeReport] = active.collection_report as Json[];
  assert.ok(activeReport);
  activeReport.forward_disposition = "checking";
  assert.equal(streamResult(evaluate(active)).class, "active_bounded_work");

  const resumableFailure = healthyConnection();
  (resumableFailure.connection_health as Json).forward_disposition = "resumable";
  resumableFailure.last_run = { status: "failed" };
  (resumableFailure.rendered_verdict as Json).pill = { tone: "red" };
  assert.equal(
    streamResult(evaluate(resumableFailure)).class,
    "failed",
    "resumable means work may resume later, not that work is active now"
  );

  const ownerRefresh = healthyConnection();
  (ownerRefresh.connection_health as Json).forward_disposition = "awaiting_owner";
  assert.equal(streamResult(evaluate(ownerRefresh)).class, "owner_interaction");

  const terminal = healthyConnection();
  (terminal.connection_health as Json).forward_disposition = "terminal";
  assert.equal(streamResult(evaluate(terminal)).class, "failed");

  const unmeasured = healthyConnection();
  (unmeasured.connection_health as Json).forward_disposition = "unmeasured";
  assert.equal(streamResult(evaluate(unmeasured)).class, "unobserved");

  const contradictory = evaluate(
    healthyConnection(),
    manifest({ streams: [{ name: "messages", required: true, coverage_policy: "unsupported" }] })
  );
  assert.equal(streamResult(contradictory).class, "projection_disagreement");
  assert.equal(contradictory.status, "fail");

  const unknown = evaluate(
    healthyConnection(),
    manifest({ streams: [{ name: "messages", required: false, coverage_policy: "future_policy" }] })
  );
  assert.equal(streamResult(unknown).class, "unknown_vocabulary");
  assert.equal(unknown.status, "inconclusive");
});

test("all owner-health vocabulary surfaces reject unknown axes, actions, conditions, and rendered fields", () => {
  const mutations: [string, (connection: Json) => void][] = [
    [
      "remote surface axis",
      (connection) => {
        ((connection.connection_health as Json).axes as Json).remote_surface = "future";
      },
    ],
    [
      "next-action owner action",
      (connection) => {
        (connection.connection_health as Json).next_action = { owner_action: "future" };
      },
    ],
    [
      "next-action notification state",
      (connection) => {
        (connection.connection_health as Json).next_action = { notification_state: "future" };
      },
    ],
    [
      "condition type",
      (connection) => {
        (connection.connection_health as Json).conditions = [{ type: "FutureCondition" }];
      },
    ],
    [
      "condition status",
      (connection) => {
        (connection.connection_health as Json).conditions = [{ type: "ProjectionReliable", status: "future" }];
      },
    ],
    [
      "condition remediation action",
      (connection) => {
        (connection.connection_health as Json).conditions = [
          { type: "ProjectionReliable", status: "true", remediation: { action: "future" } },
        ];
      },
    ],
    [
      "rendered required action",
      (connection) => {
        (connection.rendered_verdict as Json).required_actions = [
          { kind: "future", audience: "future", urgency: "future", satisfied_when: { kind: "future" } },
        ];
      },
    ],
    [
      "rendered stream disposition",
      (connection) => {
        (connection.rendered_verdict as Json).streams = [{ coverage: "complete", disposition: "future" }];
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const connection = healthyConnection();
    mutate(connection);
    const result = evaluate(connection);
    assert.equal(result.status, "inconclusive", label);
    assert.ok(result.perClass.unknown_vocabulary > 0, label);
  }
});

test("catalog metadata excludes synthetic fixtures without excluding a production connector by name", () => {
  const connection = healthyConnection({ connector_id: "pg_runtime_demo" });
  const synthetic = manifest({ connector_id: "pg_runtime_demo", catalog: { kind: "test_fixture" } });
  const syntheticResult = evaluate(connection, synthetic);
  assert.equal(syntheticResult.score.denominator, 0);
  assert.equal(syntheticResult.score.numerator, 0);
  assert.equal(syntheticResult.syntheticFixtureCount, 1);
  assert.equal(syntheticResult.perClass.synthetic_fixture, 1);
  assert.equal(syntheticResult.domAgreement.status, "agree");

  const metadataOnly = evaluate(connection, { connector_id: "pg_runtime_demo", catalog: { kind: "test_fixture" } });
  assert.equal(metadataOnly.score.denominator, 0);
  assert.equal(metadataOnly.perClass.synthetic_fixture, 1);

  const production = manifest({ connector_id: "pg_runtime_demo", catalog: { kind: "production" } });
  const productionResult = evaluate(connection, production);
  assert.deepEqual(productionResult.score, { denominator: 1, numerator: 1, percentage: 100, ratio: "1/1" });
});

test("projection disagreement is visible instead of trusting the connection stream list", () => {
  const connection = healthyConnection({ streams: ["wrong_stream"] });
  const result = evaluate(connection);

  assert.equal(streamResult(result).class, "projection_disagreement");
  assert.equal(result.status, "fail");
  assert.match(streamResult(result).reason, DISAGREEMENT_PATTERN);
});

test("malformed owner inventory rows fail closed instead of disappearing from the score", () => {
  const result = evaluateStreamHealthAuthority(unsafeAuthorityInput({ connections: [null] }));

  assert.equal(result.connectionCount, 1);
  assert.equal(result.perClass.projection_disagreement, 1);
  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
});

test("resolved authenticated DOM must agree with every real owner connection", () => {
  const result = evaluateStreamHealthAuthority({
    auth: { authenticated: true, mode: "test", resolved: true },
    connections: [healthyConnection()],
    manifests: [manifest()],
    dom: {
      authenticated: true,
      connectionIds: [],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: null,
      streamKeys: [],
      suspense: false,
    },
    paginationComplete: true,
    revision: null,
  });

  assert.equal(result.domAgreement.status, "disagree");
  assert.deepEqual(result.domAgreement.missingConnectionIds, ["c1"]);
  assert.equal(result.perClass.projection_disagreement, 1);
  assert.equal(result.status, "fail");
});

test("auth, Suspense/loading, unknown vocabulary, and revision disagreement fail closed", () => {
  const auth = evaluateStreamHealthAuthority({
    auth: { authenticated: false, mode: "none", resolved: false },
    connections: [],
    dom: {
      authenticated: false,
      connectionIds: [],
      nextPageHrefs: [],
      paginationComplete: false,
      renderedRows: false,
      resolved: false,
      streamKeys: [],
      suspense: false,
    },
    manifests: [],
    paginationComplete: false,
    revision: { dom: null, expected: null, sha: null, summaries: null },
  });
  assert.equal(auth.status, "inconclusive");
  assert.ok(auth.perClass.inconclusive_auth > 0);

  const missingAuthIdentity = evaluateStreamHealthAuthority(
    unsafeAuthorityInput({
      ...fullyEvidencedInput(healthyConnection()),
      auth: { resolved: true },
    })
  );
  assert.equal(missingAuthIdentity.status, "inconclusive");
  assert.equal(missingAuthIdentity.gates.auth, "inconclusive");

  const suspense = evaluateStreamHealthAuthority({
    auth: { authenticated: true, mode: "test", resolved: true },
    connections: [],
    dom: {
      authenticated: true,
      connectionIds: [],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: false,
      resolved: false,
      streamKeys: [],
      suspense: true,
    },
    manifests: [],
    paginationComplete: true,
    revision: null,
  });
  assert.equal(suspense.status, "inconclusive");
  assert.ok(suspense.perClass.inconclusive_suspense > 0);

  const noRenderedStructure = evaluateStreamHealthAuthority({
    ...fullyEvidencedInput(healthyConnection()),
    dom: {
      authenticated: true,
      connectionIds: ["c1"],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: false,
      resolved: true,
      streamKeys: [{ connectionId: "c1", stream: "messages" }],
      suspense: false,
    },
  });
  assert.equal(noRenderedStructure.status, "inconclusive");
  assert.equal(noRenderedStructure.gates.dom, "inconclusive");
  assert.ok(noRenderedStructure.perClass.inconclusive_suspense > 0);

  const unknownConnection = healthyConnection({ owner_state: { resolver: "future_resolver" } });
  const unknown = evaluate(unknownConnection);
  assert.equal(unknown.status, "inconclusive");
  assert.ok(unknown.perClass.unknown_vocabulary > 0);

  const revision = evaluateStreamHealthAuthority({
    auth: { authenticated: true, mode: "test", resolved: true },
    connections: [healthyConnection()],
    manifests: [manifest()],
    dom: {
      authenticated: true,
      connectionIds: ["c1"],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      streamKeys: [{ connectionId: "c1", stream: "messages" }],
      suspense: false,
    },
    paginationComplete: true,
    revision: { dom: REVISION, expected: "different-revision", sha: "abcdef123456", summaries: REVISION },
  });
  assert.equal(revision.status, "inconclusive");
  assert.equal(revision.gates.revision, "inconclusive");
  assert.equal(revision.perClass.inconclusive_revision, 1);
});

test("exact revision and SHA receipt is accepted only when summary and authenticated DOM agree", () => {
  const result = evaluateStreamHealthAuthority({
    auth: { authenticated: true, mode: "test", resolved: true },
    connections: [healthyConnection()],
    manifests: [manifest()],
    dom: {
      authenticated: true,
      connectionIds: ["c1"],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      streamKeys: [{ connectionId: "c1", stream: "messages" }],
      suspense: false,
    },
    paginationComplete: true,
    revision: { dom: REVISION, expected: REVISION, sha: "abcdef123456", summaries: REVISION },
  });

  assert.equal(result.status, "pass", JSON.stringify({ gates: result.gates, findings: result.findings }));
  assert.equal(result.gates.revision, "exact");
  assert.deepEqual(result.revisionReceipt, {
    exact: true,
    observedDom: REVISION,
    observedSummaries: REVISION,
    sha: "abcdef123456",
  });
});

test("dirty revision receipts never become exact by stripping the dirty marker", () => {
  const dirtyRevision = `${REVISION}.dirty`;
  const result = evaluateStreamHealthAuthority({
    ...fullyEvidencedInput(healthyConnection()),
    revision: {
      dom: dirtyRevision,
      expected: dirtyRevision,
      sha: "abcdef123456",
      summaries: dirtyRevision,
    },
  });
  assert.equal(result.gates.revision, "inconclusive");
  assert.equal(result.status, "inconclusive");
  assert.equal(result.revisionReceipt.exact, false);
});

test("stream evidence must be bound to an expected rendered row and manifest stream", () => {
  const result = evaluateStreamHealthAuthority({
    ...fullyEvidencedInput(healthyConnection()),
    dom: {
      authenticated: true,
      connectionIds: ["c1"],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: "c1",
      streamKeys: [{ connectionId: "c1", stream: "not-declared" }],
      suspense: false,
    },
  });
  assert.equal(result.domAgreement.status, "disagree");
  assert.deepEqual(result.domAgreement.invalidStreamKeys, ["c1:not-declared"]);
  assert.equal(result.status, "fail");
});

test("the DOM parser recognizes source identities, pagination, empty state, and unresolved auth/loading", () => {
  const resolved = parseOwnerSourcesDom(
    '<a data-pdpp-source-row="c1" href="/sources/c1">one</a><a class="rr-s-stream-row" data-connection-id="c1" data-pdpp-stream-row="true" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages">messages</a><a href="/sources?page_cursor=next">Next</a>'
  );
  assert.equal(resolved.resolved, true);
  assert.deepEqual(resolved.connectionIds, ["c1"]);
  assert.deepEqual(resolved.streamKeys, [{ connectionId: "c1", stream: "messages" }]);
  assert.deepEqual(resolved.nextPageHrefs, ["/sources?page_cursor=next"]);

  assert.equal(parseOwnerSourcesDom('<div data-testid="sources-empty">No sources</div>').resolved, true);
  assert.equal(parseOwnerSourcesDom('<a href="/sources/c1">unrelated documentation</a>').resolved, false);
  assert.equal(
    parseOwnerSourcesDom(
      '<a data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages">orphan stream</a>'
    ).resolved,
    false
  );
  assert.equal(
    parseOwnerSourcesDom(
      '<script>const html = \'<a data-pdpp-source-row="c1" data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages"></a>\';</script>'
    ).resolved,
    false
  );
  assert.equal(
    parseOwnerSourcesDom(
      '<a data-pdpp-source-row="c1" href="/sources/c1">one</a><a data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/explore?connection=c1&amp;stream=other">bad</a>'
    ).resolved,
    false
  );
  assert.equal(
    parseOwnerSourcesDom(
      '<a data-pdpp-source-row="c1" href="/sources/c1">one</a><a data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/docs?connection=c1&amp;stream=messages">wrong route</a>'
    ).resolved,
    false
  );
  assert.equal(parseOwnerSourcesDom('<form><input name="password" /></form>').resolved, false);
  assert.equal(parseOwnerSourcesDom('<div aria-busy="true">Loading</div>').suspense, true);
  assert.equal(
    parseOwnerSourcesDom(
      '<header data-pdpp-reference-revision="pdpp-reference@1.0.0+abcdef123456"><a data-pdpp-source-row="c1" href="/sources/c1">one</a></header>'
    ).revision,
    REVISION
  );
  const hidden = parseOwnerSourcesDom(
    '<div data-pdpp-selected-source="c1"><a data-pdpp-source-row="c1"></a><a data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages"></a></div>' +
      '<template><a data-pdpp-source-row="c2"></a></template><noscript><a data-pdpp-source-row="c3"></a></noscript>' +
      '<div hidden><a data-pdpp-source-row="c4"></a></div><div style="display:none"><a data-pdpp-source-row="c5"></a></div>'
  );
  assert.deepEqual(hidden.connectionIds, ["c1"]);
  assert.deepEqual(hidden.streamKeys, [{ connectionId: "c1", stream: "messages" }]);
  assert.equal(hidden.selectedConnectionId, "c1");
});

test("green evidence requires causal runtime identity and complete terminal evidence", () => {
  const noRunIdentity = healthyConnection({
    last_run: { finished_at: EVIDENCE_AT, status: "succeeded" },
    last_successful_run: { finished_at: EVIDENCE_AT, status: "succeeded" },
  });
  assert.notEqual(streamResult(evaluate(noRunIdentity)).class, "green");

  const unknownReason = healthyConnection({
    terminal_facts: { state: "current", event_seq: 1, as_of: EVIDENCE_AT, reason_code: "future_reason" },
  });
  const unknownReasonResult = evaluate(unknownReason);
  assert.equal(unknownReasonResult.status, "inconclusive");
  assert.ok(unknownReasonResult.perClass.unknown_vocabulary > 0);

  const incompleteCondition = healthyConnection({
    connection_health: { ...(healthyConnection().connection_health as Json), conditions: [{}] },
  });
  const incompleteConditionResult = evaluate(incompleteCondition);
  assert.equal(incompleteConditionResult.status, "inconclusive");
  assert.ok(incompleteConditionResult.perClass.unknown_vocabulary > 0);
});

test("master-detail DOM evidence requires every stream row for the selected source", () => {
  const twoStreams = manifest({
    streams: [
      { name: "messages", required: true },
      { name: "contacts", required: true },
    ],
  });
  const connection = healthyConnection({ streams: ["messages", "contacts"] });
  const result = evaluateStreamHealthAuthority({
    ...fullyEvidencedInput(connection, twoStreams),
    dom: {
      authenticated: true,
      connectionIds: ["c1"],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: "c1",
      streamKeys: [{ connectionId: "c1", stream: "messages" }],
      suspense: false,
    },
  });
  assert.equal(result.domAgreement.status, "disagree");
  assert.equal(result.status, "fail");
});

test("live authority exhausts summary pages and catches a DOM that hides the second owner connection", async () => {
  const c1 = healthyConnection();
  const c2 = healthyConnection({ connection_id: "c2" });
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      if (parsed.searchParams.get("cursor") === "page-2") {
        return Promise.resolve(response({ data: [c2], has_more: false, object: "list" }));
      }
      return Promise.resolve(response({ data: [c1], has_more: true, next_cursor: "page-2", object: "list" }));
    }
    if (parsed.pathname === "/connectors/mail") {
      return Promise.resolve(response(manifest()));
    }
    if (parsed.pathname === "/sources") {
      return Promise.resolve(response('<a data-pdpp-source-row="c1" href="/sources/c1">one</a>'));
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.fetched, true);
  assert.equal(result.connectionCount, 2);
  assert.equal(result.score.denominator, 2);
  assert.deepEqual(result.domAgreement.missingConnectionIds, ["c2"]);
  assert.equal(result.perClass.projection_disagreement, 1);
  assert.equal(result.status, "fail");
});

test("live authority does not score a connection when its production manifest is missing", async () => {
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [healthyConnection()], has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/connectors/mail") {
      return Promise.resolve(response({ error: "not_found" }, 404));
    }
    if (parsed.pathname === "/sources") {
      return Promise.resolve(response('<a data-pdpp-source-row="c1" href="/sources/c1">one</a>'));
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.fetched, true);
  assert.deepEqual(result.score, { denominator: 0, numerator: 0, percentage: null, ratio: "0/0" });
  assert.equal(result.perClass.manifest_unavailable, 1);
  assert.equal(result.status, "inconclusive");
});

test("live authority isolates a malformed manifest to its revoked connection", async () => {
  const revoked = healthyConnection({
    connection_id: "c-revoked",
    connector_id: "retired-fixture",
    revoked_at: "2026-08-11T00:00:00.000Z",
    status: "revoked",
  });
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [healthyConnection(), revoked], has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/connectors/mail") {
      return Promise.resolve(response(manifest()));
    }
    if (parsed.pathname === "/connectors/retired-fixture") {
      return Promise.resolve(response({ error: "connector_invalid" }, 400));
    }
    if (parsed.pathname === "/sources") {
      return Promise.resolve(
        response(
          `<header data-pdpp-reference-revision="${REVISION}"><a data-pdpp-source-row="c1" href="/sources/c1">one</a><a data-pdpp-source-row="c-revoked" href="/sources/c-revoked">revoked</a><a data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages"></a></header>`
        )
      );
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.fetched, true);
  assert.deepEqual(result.score, { denominator: 1, numerator: 1, percentage: 100, ratio: "1/1" });
  assert.equal(result.perClass.manifest_unavailable, 0);
  assert.equal(result.status, "pass");
});

test("live authority accepts a resolved authenticated empty owner surface with an exact revision receipt", async () => {
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [], has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/sources") {
      return Promise.resolve(response('<div data-testid="sources-empty">No sources yet</div>'));
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.fetched, true);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.score, { denominator: 0, numerator: 0, percentage: null, ratio: "0/0" });
  assert.equal(result.domAgreement.status, "agree");
  assert.equal(result.gates.dom, "resolved");
  assert.equal(result.gates.revision, "exact");
  assert.equal(result.revisionReceipt.exact, true);
});

test("live authority accepts the authenticated DOM revision receipt when the HTML response header is absent", async () => {
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [], has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/sources") {
      return Promise.resolve(
        response(
          `<header data-pdpp-reference-revision="${REVISION}"><div data-testid="sources-empty">No sources yet</div></header>`,
          200,
          null
        )
      );
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.status, "pass");
  assert.equal(result.gates.revision, "exact");
  assert.equal(result.revisionReceipt.observedDom, REVISION);
});

test("live authority fails closed on a malformed/repeating summary cursor", async () => {
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [], has_more: true, next_cursor: "same", object: "list" }));
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.fetched, false);
  assert.equal(result.status, "inconclusive");
  assert.ok(result.perClass.inconclusive_pagination > 0);
});

test("summary pagination follows more than 200 pages without a fixed cap", async () => {
  const pageCount = 201;
  let calls = 0;
  const result = await fetchAllConnectorSummaries({
    base: "https://example.test",
    fetchImpl: (url) => {
      calls += 1;
      const cursor = new URL(url).searchParams.get("cursor");
      const page = cursor ? Number(cursor.replace("page-", "")) : 1;
      return Promise.resolve(
        response({
          data: [],
          has_more: page < pageCount,
          next_cursor: page < pageCount ? `page-${page + 1}` : null,
          object: "list",
        })
      );
    },
    headers: { accept: "application/json" },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, pageCount);
});

test("DOM pagination follows more than 200 rendered pages and preserves cycle detection", async () => {
  const pageCount = 201;
  let calls = 0;
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [healthyConnection()], has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/connectors/mail") {
      return Promise.resolve(response(manifest()));
    }
    if (parsed.pathname === "/sources") {
      calls += 1;
      const cursor = parsed.searchParams.get("page_cursor");
      const page = cursor ? Number(cursor.replace("page-", "")) : 1;
      const next = page < pageCount ? `<a href="/sources?page_cursor=page-${page + 1}">Next</a>` : "";
      return Promise.resolve(response(`<a data-pdpp-source-row="c1" href="/sources/c1">one</a>${next}`));
    }
    throw new Error(`unexpected test URL ${url}`);
  };
  const result = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });
  assert.equal(result.fetched, true);
  assert.equal(calls, pageCount);
  assert.equal(result.gates.pagination, "complete");
  assert.equal(result.status, "pass");

  const cycleResult = await runLiveForTest({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl: (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/_ref/connectors") {
        return Promise.resolve(response({ data: [healthyConnection()], has_more: false, object: "list" }));
      }
      if (parsed.pathname === "/connectors/mail") {
        return Promise.resolve(response(manifest()));
      }
      if (parsed.pathname === "/sources") {
        return Promise.resolve(
          response(
            '<a data-pdpp-source-row="c1" href="/sources/c1">one</a><a href="/sources?page_cursor=loop">Next</a>'
          )
        );
      }
      throw new Error(`unexpected test URL ${url}`);
    },
    origin: "https://example.test",
  });
  assert.equal(cycleResult.gates.pagination, "inconclusive");
  assert.equal(cycleResult.status, "inconclusive");
});

test("owner-auth transport errors return a structured inconclusive result", async () => {
  const result = await runLiveForTest({
    env: { PDPP_OWNER_PASSWORD: "owner-password" },
    fetchImpl: () => {
      throw new Error("socket failed");
    },
    origin: "https://example.test",
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.fetched, false);
  assert.match(result.error ?? "", SOCKET_FAILURE_PATTERN);
  assert.equal(result.gates.auth, "inconclusive");
});
