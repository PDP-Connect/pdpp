// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { FetchImpl } from "../lib/owner-session.ts";
import { fetchAllConnectorSummaries } from "../lib/ref-connectors-page-follow.ts";
import {
  evaluateStreamHealthAuthority,
  type OwnerSourcesDomEvidence,
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
      sourceScopes: synthetic ? [] : [{ connectionId: String(connection.connection_id), scope: "active" }],
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
  const resolved = `<header data-pdpp-reference-revision="${REVISION}"><a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a><a data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages"></a></header>`;
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
      sourceScopes: [
        { connectionId: "c1", scope: "active" },
        { connectionId: "c2", scope: "active" },
      ],
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

/**
 * Four reasons the runtime genuinely emits that this vocabulary never learned.
 * Measured against the DEPLOYED projection on 2026-08-28: four of six live
 * reason codes scored as `unknown_vocabulary` on connections that were fine —
 * the audit was reporting its own ignorance as a finding.
 *
 * One case per reason, and each is named with its PRODUCER so a future reader
 * can re-verify it rather than trust this list. Two were source-proven before
 * being added; the owner's rule was that a reason present only in a fixture
 * does not qualify:
 *
 *   history_ended_before_provider_count  groupme/index.ts:2189  SKIP_RESULT
 *   statement_unreconciled               usaa/index.ts:2732     SKIP_RESULT
 *   interaction_cancelled                cancelled owner interaction — the
 *                                        vocabulary had `interaction_timeout`
 *                                        but never its cancelled sibling
 *   connector_child_failure              a child collector failed
 *
 * These pin RECOGNITION only. Severity is not asserted here and is not changed
 * by the vocabulary: `owner-action-gate.ts`'s
 * AUTOMATION_BLOCKING_OWNER_ACTION_KINDS ({add_info, reauth}) remains the sole
 * arbiter of what blocks an owner. Of these four only
 * `connector_child_failure` carries `add_info`; the others carry
 * wait/code_fix/retry_gap and stay non-blocking.
 */
test("recognises the four live producer reasons that previously scored as unknown vocabulary", () => {
  const baseHealth = healthyConnection().connection_health as Json;
  for (const reason of [
    "connector_child_failure",
    "history_ended_before_provider_count",
    "interaction_cancelled",
    "statement_unreconciled",
  ]) {
    const condition = {
      current: false,
      expires_at: null,
      id: `source-coverage-${reason}`,
      message: "Source coverage status",
      observed_at: EVIDENCE_AT,
      origin: "connector",
      reason,
      reason_code: null,
      remediation: null,
      sensitivity: "public",
      severity: "blocked",
      status: "false",
      type: "SourceCoverageComplete",
    };
    const result = evaluate(healthyConnection({ connection_health: { ...baseHealth, conditions: [condition] } }));
    assert.equal(
      result.perClass.unknown_vocabulary,
      0,
      `${reason} is emitted by a real producer; scoring it unknown reports the audit's ignorance as a defect`
    );
  }
});

test("accepts canonical RI producer reasons but rejects unknown reasons", () => {
  const baseHealth = healthyConnection().connection_health as Json;
  for (const reason of [
    "complete",
    "terminal_gap",
    "interaction_timeout",
    "connector_reported_failed",
    "credentials_required",
    "collection_succeeded_import_complete",
    "coverage_complete_unfillable_accounted",
    "coverage_unknown_stale_collector",
    "credentials_not_applicable_file_import",
    "freshness_not_applicable_complete",
    "projection_superseded_by_definition_change",
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

test("keeps a settled healthy stream green when later bookkeeping is skipped", () => {
  const base = healthyConnection();
  const result = evaluate({
    ...base,
    connection_health: {
      ...(base.connection_health as Json),
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" },
      conditions: [
        {
          current: false,
          expires_at: null,
          id: "attention-clear",
          message: "Owner attention is required",
          observed_at: EVIDENCE_AT,
          origin: "connector",
          reason: "needs_human_attention",
          reason_code: null,
          remediation: null,
          sensitivity: "public",
          severity: "warning",
          status: "false",
          type: "AttentionClear",
        },
        ...((base.connection_health as Json).conditions as Json[]),
      ],
    },
    last_run: { finished_at: EVIDENCE_AT, status: "skipped", run_id: "run-skipped" },
  });

  assert.equal(result.gates.vocabulary, "known");
  assert.equal(streamResult(result).class, "green");
  assert.equal(streamResult(result).green, true);
  assert.equal(result.status, "pass");
});

test("keeps a skipped stream non-green when it has no settled collection evidence", () => {
  const result = evaluate(
    healthyConnection({
      collection_report: [],
      last_run: { finished_at: EVIDENCE_AT, status: "skipped", run_id: "run-skipped" },
      last_successful_run: null,
      stream_records: [],
    })
  );

  assert.equal(result.gates.vocabulary, "known");
  assert.equal(streamResult(result).class, "unobserved");
  assert.equal(streamResult(result).green, false);
  assert.equal(result.status, "fail");
});

test("accepts every closed-vocabulary rendered pill label RI actually serves, but rejects an unlisted label", () => {
  const baseVerdict = healthyConnection().rendered_verdict as Json;
  for (const label of [
    "Archived",
    "Can't collect",
    "Checking",
    "Expired while waiting for you",
    "Healthy",
    "Import complete",
    "Missing data",
    "Missing optional data",
    "Needs refresh",
    "Not measured",
    "Setup never completed",
    "Some records stuck",
    "Syncing",
  ]) {
    const result = evaluate(healthyConnection({ rendered_verdict: { ...baseVerdict, pill: { label, tone: "grey" } } }));
    assert.equal(result.perClass.unknown_vocabulary, 0, label);
  }

  const unknownLabel = evaluate(
    healthyConnection({ rendered_verdict: { ...baseVerdict, pill: { label: "Future pill label", tone: "grey" } } })
  );
  assert.ok(unknownLabel.perClass.unknown_vocabulary > 0);
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

test("carried-forward coverage evidence proves green only when strictly older than the latest terminal success", () => {
  const OLDER_EVIDENCE_AT = "2026-08-10T12:00:00.000Z";
  const FUTURE_EVIDENCE_AT = "2999-01-01T00:00:00.000Z";

  function carriedForward(overrides: Json = {}): Json {
    const connection = healthyConnection({
      last_run: {
        finished_at: "2026-08-11T12:05:00.000Z",
        run_id: "run-owner-cancelled",
        status: "cancelled",
        terminal_reason: "owner_cancelled",
      },
    });
    const [report] = connection.collection_report as Json[];
    assert.ok(report);
    Object.assign(report, overrides);
    return connection;
  }

  const olderEvidence = evaluate(carriedForward({ evidence_as_of: OLDER_EVIDENCE_AT }));
  assert.equal(streamResult(olderEvidence).class, "green");

  // Same instant as the latest terminal success, expressed differently, so it
  // is not the exact-string current-proof match: equal is not strictly
  // older, so it fails closed rather than being treated as carried-forward.
  const equalEvidence = evaluate(carriedForward({ evidence_as_of: "2026-08-11T12:00:00+00:00" }));
  assert.equal(streamResult(equalEvidence).class, "unobserved");

  const futureEvidence = evaluate(carriedForward({ evidence_as_of: FUTURE_EVIDENCE_AT }));
  assert.equal(streamResult(futureEvidence).class, "unobserved");

  const unparseableEvidence = evaluate(carriedForward({ evidence_as_of: "not-a-timestamp" }));
  assert.equal(streamResult(unparseableEvidence).class, "unobserved");

  const missingEvidence = evaluate(carriedForward({ evidence_as_of: undefined }));
  assert.equal(streamResult(missingEvidence).class, "unobserved");

  const pastButNewerThanLatestSuccess = evaluate(carriedForward({ evidence_as_of: "2026-08-11T18:00:00.000Z" }));
  assert.equal(streamResult(pastButNewerThanLatestSuccess).class, "unobserved");
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

test("a stream with its own committed-complete report is not provider_config_blocked merely because a sibling stream degraded the connection (production GroupMe shape: cin_5804a2ff36cd303e22762745)", () => {
  const groupMeManifest = manifest({
    connector_id: "groupme",
    version: "0.1.0",
    streams: [
      { name: "groups", required: true, coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window" },
      {
        name: "group_messages",
        required: true,
        coverage_strategy: "checkpoint_window",
        freshness_strategy: "scheduled_window",
      },
    ],
  });
  const connection = healthyConnection({
    connector_id: "groupme",
    streams: ["groups", "group_messages"],
    manifest_version: "0.1.0",
    owner_state: { resolver: "system_degraded", owner_of_state: "system", posture: "observed" },
    rendered_verdict: { pill: { tone: "amber", label: "Some records stuck" } },
    connection_health: {
      state: "degraded",
      axes: { coverage: "retryable_gap", freshness: "stale", attention: "none", outbox: "unknown" },
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
    collection_report: [
      {
        stream: "groups",
        coverage_condition: "complete",
        coverage_strategy: "full_inventory",
        freshness_strategy: "scheduled_window",
        checkpoint: "committed",
        considered: 156,
        covered: 156,
        forward_disposition: "complete",
        evidence_as_of: EVIDENCE_AT,
      },
      {
        stream: "group_messages",
        coverage_condition: "retryable_gap",
        coverage_strategy: "checkpoint_window",
        freshness_strategy: "scheduled_window",
        checkpoint: "committed",
        considered: 0,
        covered: 0,
        forward_disposition: "resumable",
        evidence_as_of: EVIDENCE_AT,
        skipped: { reason: "history_ended_before_provider_count", recovery_action: "retry_by_runtime" },
      },
    ],
    stream_records: [
      { stream: "groups", record_count: 156, count_state: "known", declaration_state: "declared" },
      { stream: "group_messages", record_count: 88_743, count_state: "known", declaration_state: "declared" },
    ],
  });
  const result = evaluate(connection, groupMeManifest);
  const groups = result.streams.find((item) => item.stream === "groups");
  const groupMessages = result.streams.find((item) => item.stream === "group_messages");
  assert.ok(groups, "expected a groups stream finding");
  assert.ok(groupMessages, "expected a group_messages stream finding");
  assert.notEqual(
    groups.class,
    "provider_config_blocked",
    `a stream with its own committed-complete report must not inherit a sibling's provider_config_blocked verdict (got ${groups.class})`
  );
  assert.equal(
    groups.class,
    "stale",
    "the honest classification for this real production shape is stale (connection_health.axes.freshness is stale), not blocked"
  );
  assert.equal(
    groupMessages.class,
    "provider_config_blocked",
    "the genuinely degraded stream itself is still correctly classified as blocked"
  );
});

test("a hard block (blocked_maintainer) still covers every sibling, even one with its own committed-complete report (production Gmail shape: cin_5804a2ff36cd303e22762745-style maintainer defect)", () => {
  const gmailManifest = manifest({
    connector_id: "gmail",
    version: "manifest-1",
    streams: [
      {
        name: "messages",
        required: true,
        coverage_strategy: "checkpoint_window",
        freshness_strategy: "scheduled_window",
      },
      {
        name: "attachments",
        required: true,
        coverage_strategy: "parent_detail_accounting",
        freshness_strategy: "scheduled_window",
      },
    ],
  });
  const connection = healthyConnection({
    connector_id: "gmail",
    streams: ["messages", "attachments"],
    owner_state: { resolver: "blocked_maintainer", owner_of_state: "maintainer", posture: "observed" },
    rendered_verdict: { pill: { tone: "red", label: "Can't collect" } },
    connection_health: {
      state: "degraded",
      axes: { coverage: "terminal_gap", freshness: "fresh", attention: "none", outbox: "unknown" },
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
    collection_report: [
      {
        stream: "messages",
        coverage_condition: "complete",
        coverage_strategy: "checkpoint_window",
        freshness_strategy: "scheduled_window",
        checkpoint: "committed",
        considered: 1,
        covered: 1,
        forward_disposition: "complete",
        evidence_as_of: EVIDENCE_AT,
      },
      {
        stream: "attachments",
        coverage_condition: "terminal_gap",
        coverage_strategy: "parent_detail_accounting",
        freshness_strategy: "scheduled_window",
        checkpoint: "committed",
        considered: 0,
        covered: 0,
        forward_disposition: "terminal",
        evidence_as_of: EVIDENCE_AT,
      },
    ],
    stream_records: [
      { stream: "messages", record_count: 1, count_state: "known", declaration_state: "declared" },
      { stream: "attachments", record_count: 0, count_state: "known_zero", declaration_state: "declared" },
    ],
  });
  const result = evaluate(connection, gmailManifest);
  const messages = result.streams.find((item) => item.stream === "messages");
  const attachments = result.streams.find((item) => item.stream === "attachments");
  assert.ok(messages, "expected a messages stream finding");
  assert.ok(attachments, "expected an attachments stream finding");
  assert.equal(
    messages.class,
    "provider_config_blocked",
    "a maintainer-audience hard block invalidates every sibling report, including one that looks committed-complete"
  );
  assert.equal(
    attachments.class,
    "provider_config_blocked",
    "the genuinely blocked stream itself is still correctly classified as blocked"
  );
});

test("a stream with its own committed-complete report is not failed merely because a sibling stream's terminal gap set the connection-wide coverage axis (production Gmail sibling shape)", () => {
  const gmailManifest = manifest({
    connector_id: "gmail",
    version: "manifest-1",
    streams: [
      {
        name: "messages",
        required: true,
        coverage_strategy: "checkpoint_window",
        freshness_strategy: "scheduled_window",
      },
      {
        name: "attachments",
        required: true,
        coverage_strategy: "parent_detail_accounting",
        freshness_strategy: "scheduled_window",
      },
    ],
  });
  const connection = healthyConnection({
    connector_id: "gmail",
    streams: ["messages", "attachments"],
    owner_state: { resolver: "healthy", owner_of_state: "system", posture: "observed" },
    rendered_verdict: { pill: { tone: "amber", label: "Missing optional data" } },
    connection_health: {
      state: "degraded",
      axes: { coverage: "terminal_gap", freshness: "fresh", attention: "none", outbox: "unknown" },
      forward_disposition: "resumable",
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
    collection_report: [
      {
        stream: "messages",
        coverage_condition: "complete",
        coverage_strategy: "checkpoint_window",
        freshness_strategy: "scheduled_window",
        checkpoint: "committed",
        considered: 1,
        covered: 1,
        forward_disposition: "complete",
        evidence_as_of: EVIDENCE_AT,
      },
      {
        stream: "attachments",
        coverage_condition: "terminal_gap",
        coverage_strategy: "parent_detail_accounting",
        freshness_strategy: "scheduled_window",
        checkpoint: "committed",
        considered: 0,
        covered: 0,
        forward_disposition: "terminal",
        evidence_as_of: EVIDENCE_AT,
      },
    ],
    stream_records: [
      { stream: "messages", record_count: 1, count_state: "known", declaration_state: "declared" },
      { stream: "attachments", record_count: 0, count_state: "known_zero", declaration_state: "declared" },
    ],
  });
  const result = evaluate(connection, gmailManifest);
  const messages = result.streams.find((item) => item.stream === "messages");
  const attachments = result.streams.find((item) => item.stream === "attachments");
  assert.ok(messages, "expected a messages stream finding");
  assert.ok(attachments, "expected an attachments stream finding");
  assert.equal(
    messages.class,
    "green",
    `a stream with its own committed-complete report must not inherit a sibling's terminal-gap failed verdict (got ${messages.class})`
  );
  assert.equal(
    attachments.class,
    "failed",
    "the genuinely terminal-gapped stream itself is still correctly classified as failed"
  );
});

test("a red pill without a hard block still fails every sibling stream, even one with its own committed-complete report (negative control: connection-wide render fact, not a coverage rollup)", () => {
  const connection = healthyConnection({
    rendered_verdict: { pill: { tone: "red", label: "Some records stuck" } },
  });
  const result = evaluate(connection);
  assert.equal(
    streamResult(result).class,
    "failed",
    "a red pill without connection_health.state === 'blocked' is a connection-wide render fact, so it still fails every stream"
  );
});

test("a failed latest run still fails every sibling stream, even one with its own committed-complete report (negative control: connection-wide run fact, not a coverage rollup)", () => {
  const connection = healthyConnection({
    last_run: { status: "failed", run_id: "run-2" },
  });
  const result = evaluate(connection);
  assert.equal(
    streamResult(result).class,
    "failed",
    "the latest run's own status is a connection-wide fact independent of any stream's report, so it still fails every stream"
  );
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

for (const accepted of ["deferred", "inventory_only"]) {
  test(`an accepted ${accepted} coverage axis does not disagree with an entirely complete required report`, () => {
    const connection = healthyConnection({
      connection_health: {
        state: "healthy",
        axes: { coverage: accepted, freshness: "fresh", attention: "none", outbox: "idle" },
        conditions: healthyConnection().connection_health.conditions,
      },
    });
    const result = evaluate(connection);

    assert.equal(streamResult(result).class, "green");
  });
}

for (const accepted of ["unavailable", "unsupported"]) {
  test(`an accepted ${accepted} coverage axis still disagrees with an entirely complete required report (excluded from the narrow accepted set)`, () => {
    // Counterweight: `unavailable`/`unsupported` are accepted-absence
    // manifest policies too, but `hasOutstandingGap`
    // (runtime/connection-health.ts:3494-3503) treats BOTH as outstanding
    // gaps at the connection-health axis level. Excusing them here would put
    // this predicate in disagreement with that in-tree authority, so the
    // accepted set stays narrow to `inventory_only`/`deferred` only — this
    // must still fail.
    const connection = healthyConnection({
      connection_health: {
        state: "degraded",
        axes: { coverage: accepted, freshness: "fresh", attention: "none", outbox: "idle" },
        conditions: healthyConnection().connection_health.conditions,
      },
      rendered_verdict: { pill: { tone: "amber", label: "Some records stuck" } },
    });
    const result = evaluate(connection);

    assert.equal(streamResult(result).class, "projection_disagreement");
    assert.equal(
      streamResult(result).reason,
      "health coverage disagrees with an entirely complete collection report"
    );
  });
}

test("a genuinely degrading coverage axis still disagrees with an entirely complete required report", () => {
  // Counterweight: `retryable_gap` is not in the accepted-absence set, so this
  // must still fail — proves the new exception is scoped to the narrow
  // accepted vocabulary, not "any non-complete axis".
  const connection = healthyConnection({
    connection_health: {
      state: "degraded",
      axes: { coverage: "retryable_gap", freshness: "fresh", attention: "none", outbox: "idle" },
      conditions: healthyConnection().connection_health.conditions,
    },
    rendered_verdict: { pill: { tone: "amber", label: "Some records stuck" } },
  });
  const result = evaluate(connection);

  assert.equal(streamResult(result).class, "projection_disagreement");
  assert.equal(streamResult(result).reason, "health coverage disagrees with an entirely complete collection report");
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
      sourceScopes: [],
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
      sourceScopes: [],
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
      sourceScopes: [],
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
      sourceScopes: [{ connectionId: "c1", scope: "active" }],
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
      sourceScopes: [{ connectionId: "c1", scope: "active" }],
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
      sourceScopes: [{ connectionId: "c1", scope: "active" }],
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
      sourceScopes: [{ connectionId: "c1", scope: "active" }],
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

test("DOM scope contract keeps active completeness strict while allowing explicit inactive lifecycles", () => {
  const active = healthyConnection({
    owner_state: { resolver: "collecting", owner_of_state: "system", posture: "observed" },
  });
  const revoked = healthyConnection({ connection_id: "c-revoked", status: "revoked", revoked_at: EVIDENCE_AT });
  const draft = healthyConnection({ connection_id: "c-draft", status: "draft" });
  const input = fullyEvidencedInput(active);
  const result = evaluateStreamHealthAuthority({
    ...input,
    connections: [active, revoked, draft],
    dom: {
      authenticated: true,
      connectionIds: ["c-revoked", "c-draft"],
      sourceScopes: [
        { connectionId: "c-revoked", scope: "revoked" },
        { connectionId: "c-draft", scope: "draft" },
      ],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: null,
      streamKeys: [],
      suspense: false,
    },
  });
  assert.equal(result.domAgreement.status, "disagree");
  assert.deepEqual(result.domAgreement.missingConnectionIds, ["c1"]);
  assert.equal(result.domAgreement.extraConnectionIds.length, 0);

  const complete = evaluateStreamHealthAuthority({
    ...input,
    connections: [active, revoked, draft],
    dom: {
      authenticated: true,
      connectionIds: ["c1", "c-revoked", "c-draft"],
      sourceScopes: [
        { connectionId: "c1", scope: "active" },
        { connectionId: "c-revoked", scope: "revoked" },
        { connectionId: "c-draft", scope: "draft" },
      ],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: "c1",
      streamKeys: [{ connectionId: "c1", stream: "messages" }],
      suspense: false,
    },
  });
  assert.equal(complete.domAgreement.status, "agree");
});

test("DOM scope contract rejects unmarked and contradictory source rows", () => {
  const base = fullyEvidencedInput(healthyConnection());
  const unmarked = evaluateStreamHealthAuthority({
    ...base,
    dom: {
      ...(base.dom as OwnerSourcesDomEvidence),
      connectionIds: ["c1", "c-extra"],
      sourceScopes: [{ connectionId: "c1", scope: "active" }],
    },
  });
  assert.equal(unmarked.domAgreement.status, "disagree");
  assert.deepEqual(unmarked.domAgreement.extraConnectionIds, ["c-extra"]);

  const contradictory = evaluateStreamHealthAuthority({
    ...base,
    dom: {
      ...(base.dom as OwnerSourcesDomEvidence),
      sourceScopes: [{ connectionId: "c1", scope: "revoked" }],
    },
  });
  assert.equal(contradictory.domAgreement.status, "disagree");
  assert.deepEqual(contradictory.domAgreement.invalidSourceScopes, ["c1:revoked"]);
});

test("DOM scope contract accepts paused and rejected lifecycles and fails closed on an unknown status", () => {
  const active = healthyConnection({
    owner_state: { resolver: "collecting", owner_of_state: "system", posture: "observed" },
  });
  const paused = healthyConnection({ connection_id: "c-paused", status: "paused" });
  const rejected = healthyConnection({ connection_id: "c-rejected", status: "rejected" });
  const input = fullyEvidencedInput(active);
  const agreeing = evaluateStreamHealthAuthority({
    ...input,
    connections: [active, paused, rejected],
    dom: {
      authenticated: true,
      connectionIds: ["c1", "c-paused", "c-rejected"],
      sourceScopes: [
        { connectionId: "c1", scope: "active" },
        { connectionId: "c-paused", scope: "paused" },
        { connectionId: "c-rejected", scope: "rejected" },
      ],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: "c1",
      streamKeys: [{ connectionId: "c1", stream: "messages" }],
      suspense: false,
    },
  });
  assert.equal(agreeing.domAgreement.status, "agree");
  assert.deepEqual(agreeing.domAgreement.missingSourceScopes, []);
  assert.deepEqual(agreeing.domAgreement.invalidSourceScopes, []);

  const unknownStatus = healthyConnection({ connection_id: "c-unknown", status: "some_future_status" });
  const disagreeing = evaluateStreamHealthAuthority({
    ...input,
    connections: [active, unknownStatus],
    dom: {
      authenticated: true,
      connectionIds: ["c1", "c-unknown"],
      sourceScopes: [
        { connectionId: "c1", scope: "active" },
        { connectionId: "c-unknown", scope: "active" },
      ],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: "c1",
      streamKeys: [{ connectionId: "c1", stream: "messages" }],
      suspense: false,
    },
  });
  assert.equal(disagreeing.domAgreement.status, "disagree");
  assert.deepEqual(disagreeing.domAgreement.invalidSourceScopes, ["c-unknown:active"]);
});

test("a contradictory duplicate connection id in the canonical inventory fails DOM agreement closed", () => {
  const active = healthyConnection({
    owner_state: { resolver: "collecting", owner_of_state: "system", posture: "observed" },
  });
  const firstDeclaration = healthyConnection({ connection_id: "c-dup", status: "active" });
  const secondDeclaration = healthyConnection({ connection_id: "c-dup", status: "revoked" });
  const input = fullyEvidencedInput(active);

  const observedAsRevoked = evaluateStreamHealthAuthority({
    ...input,
    connections: [active, firstDeclaration, secondDeclaration],
    dom: {
      authenticated: true,
      connectionIds: ["c1", "c-dup"],
      sourceScopes: [
        { connectionId: "c1", scope: "active" },
        { connectionId: "c-dup", scope: "revoked" },
      ],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: "c1",
      streamKeys: [{ connectionId: "c1", stream: "messages" }],
      suspense: false,
    },
  });
  assert.equal(
    observedAsRevoked.domAgreement.status,
    "disagree",
    "a contradictory canonical lifecycle must not silently collapse to whichever declaration was seen last"
  );
  assert.deepEqual(observedAsRevoked.domAgreement.invalidSourceScopes, ["c-dup:revoked"]);

  const observedAsActive = evaluateStreamHealthAuthority({
    ...input,
    connections: [active, firstDeclaration, secondDeclaration],
    dom: {
      authenticated: true,
      connectionIds: ["c1", "c-dup"],
      sourceScopes: [
        { connectionId: "c1", scope: "active" },
        { connectionId: "c-dup", scope: "active" },
      ],
      nextPageHrefs: [],
      paginationComplete: true,
      renderedRows: true,
      resolved: true,
      selectedConnectionId: "c1",
      streamKeys: [{ connectionId: "c1", stream: "messages" }],
      suspense: false,
    },
  });
  assert.equal(
    observedAsActive.domAgreement.status,
    "disagree",
    "the contradictory canonical entry must fail closed even when the DOM matches one of the two declared scopes"
  );
  assert.deepEqual(observedAsActive.domAgreement.invalidSourceScopes, ["c-dup:active"]);
});

test("the DOM parser fails closed instead of resolving when a rendered source row omits its lifecycle scope", () => {
  const missingScope = parseOwnerSourcesDom('<a data-pdpp-source-row="c1" href="/sources/c1">one</a>');
  assert.equal(missingScope.resolved, false);

  const contradictoryScope = parseOwnerSourcesDom(
    '<a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a>' +
      '<a data-pdpp-source-row="c1" data-pdpp-source-scope="revoked" href="/sources/c1">one again</a>'
  );
  assert.equal(contradictoryScope.resolved, false);

  const consistentDuplicateRows = parseOwnerSourcesDom(
    '<a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a>' +
      '<a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one repeated</a>'
  );
  assert.equal(consistentDuplicateRows.resolved, true);
  assert.deepEqual(consistentDuplicateRows.connectionIds, ["c1"]);
  assert.deepEqual(consistentDuplicateRows.sourceScopes, [{ connectionId: "c1", scope: "active" }]);
});

test("the DOM parser recognizes source identities, pagination, empty state, and unresolved auth/loading", () => {
  const resolved = parseOwnerSourcesDom(
    '<a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a><a class="rr-s-stream-row" data-connection-id="c1" data-pdpp-stream-row="true" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages">messages</a><a href="/sources?page_cursor=next">Next</a>'
  );
  assert.equal(resolved.resolved, true);
  assert.deepEqual(resolved.connectionIds, ["c1"]);
  assert.deepEqual(resolved.sourceScopes, [{ connectionId: "c1", scope: "active" }]);
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
      sourceScopes: [{ connectionId: "c1", scope: "active" }],
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
      return Promise.resolve(
        response('<a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a>')
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
      return Promise.resolve(
        response('<a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a>')
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
          `<header data-pdpp-reference-revision="${REVISION}"><a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a><a data-pdpp-source-row="c-revoked" data-pdpp-source-scope="revoked" href="/sources/c-revoked">revoked</a><a data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages"></a></header>`
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

test("live authority requests the Sources-visible inventory so a never-succeeded revoked setup shell is not extra", async () => {
  // Mirrors the real reference: `/_ref/connectors` without `sources_visibility=1`
  // excludes a revoked, never-succeeded browser_enrollment_shell row entirely
  // (`listOwnerVisibleConnectorInstancePage`); the `/sources` page (and this
  // authority, which reconciles against it) must ask for the same
  // `sources_visibility=1` superset the Sources-only escape
  // (`listSourcesVisibleConnectorInstancePage`) serves, or a legitimately
  // rendered row reads as a spurious "extra" connection.
  const setupFailedShell = healthyConnection({
    connection_id: "c-setup-failed",
    connector_id: "venmo",
    revoked_at: "2026-08-24T04:13:59.280Z",
    source_visibility: "setup_failed",
    status: "revoked",
  });
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      const data =
        parsed.searchParams.get("sources_visibility") === "1"
          ? [healthyConnection(), setupFailedShell]
          : [healthyConnection()];
      return Promise.resolve(response({ data, has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/connectors/mail") {
      return Promise.resolve(response(manifest()));
    }
    if (parsed.pathname === "/sources") {
      return Promise.resolve(
        response(
          `<header data-pdpp-reference-revision="${REVISION}"><a data-pdpp-selected-source="c1" data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a><a data-pdpp-source-row="c-setup-failed" data-pdpp-source-scope="revoked" href="/sources/c-setup-failed">setup failed</a><a data-pdpp-stream-row="true" data-connection-id="c1" data-stream-name="messages" href="/explore?connection=c1&amp;stream=messages"></a></header>`
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

  assert.equal(result.connectionCount, 2);
  assert.deepEqual(result.domAgreement.extraConnectionIds, []);
  assert.deepEqual(result.domAgreement.missingConnectionIds, []);
  assert.equal(result.domAgreement.status, "agree");
  assert.equal(result.status, "pass");
});

test("fetchAllConnectorSummaries forwards sources_visibility=1 only when the caller opts in", async () => {
  const seenParams: string[] = [];
  const fetchImpl: FetchImpl = (url) => {
    seenParams.push(new URL(url).searchParams.get("sources_visibility") ?? "<absent>");
    return Promise.resolve(response({ data: [], has_more: false, object: "list" }));
  };

  await fetchAllConnectorSummaries({ base: "https://example.test", fetchImpl, headers: {} });
  await fetchAllConnectorSummaries({ base: "https://example.test", fetchImpl, headers: {}, sourcesVisibility: true });

  assert.deepEqual(seenParams, ["<absent>", "1"]);
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
      return Promise.resolve(
        response(`<a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a>${next}`)
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
            '<a data-pdpp-source-row="c1" data-pdpp-source-scope="active" href="/sources/c1">one</a><a href="/sources?page_cursor=loop">Next</a>'
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

test("vocabulary: `skipped` is a RECOGNISED run status, and still not green", () => {
  // `runtime/scheduler/pre-run-gate.ts` emits `status: "skipped"` when an
  // automatic run is withheld. Leaving it unknown made the strict audit fail
  // closed on a value the runtime intentionally produces — which reads to the
  // owner as a broken connection rather than a gap in the audit's vocabulary.
  const skipped = evaluate(
    healthyConnection({
      last_run: { finished_at: EVIDENCE_AT, run_id: "run-skip", status: "skipped" },
      last_successful_run: null,
    })
  );
  assert.equal(skipped.perClass.unknown_vocabulary, 0, "the runtime emits it; the audit must recognise it");

  // ...and recognising it must not make it count as success on its own. With
  // no independent successful evidence to fall back on ("keeps a skipped
  // stream non-green when it has no settled collection evidence" covers this
  // same contract), a withheld run collected nothing and cannot be green.
  assert.notEqual(
    skipped.status,
    "pass",
    "KNOWN means recognised, never green without independent successful evidence"
  );
});

test("vocabulary: an UNRECOGNISED run status still fails closed", () => {
  // The control. Adding two known values must not turn the audit permissive.
  const invented = evaluate(
    healthyConnection({ last_run: { finished_at: EVIDENCE_AT, run_id: "run-x", status: "future_status" } })
  );
  assert.ok(invented.perClass.unknown_vocabulary > 0, "unknown vocabulary must still be caught");
});
