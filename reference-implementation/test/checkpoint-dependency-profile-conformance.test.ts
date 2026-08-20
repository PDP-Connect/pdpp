// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Profile-level conformance coverage for the checkpoint-dependency contract
 * defined in `spec-collection-profile.md` (§ Checkpoint dependency, § DONE:
 * Eligible-checkpoint algorithm). Distinct from the existing RI-internals
 * regression suites (`runtime-stream-collection-failed-commit.test.ts`,
 * `detail-coverage-shortfall-severity.test.ts`), which prove the algorithm's
 * shape; this file proves the scenarios an independent review found had NO
 * existing coverage anywhere in the repository:
 *
 *   1. Cancellation racing a certified stream-scoped failure — cancellation
 *      MUST take precedence over evaluating the exception, per the profile's
 *      "Cancellation precedence" rule.
 *   2. Partial checkpoint-store failure across multiple eligible checkpoints —
 *      an already-committed checkpoint must stay committed even if persisting
 *      a sibling checkpoint fails afterward, the run must fail (not report
 *      `succeeded`), and both the failing and the committed stream's identity
 *      must be recoverable (via the rejected error's message, the run
 *      timeline, and durable state — see spec step 5's distributed-identity
 *      contract) even though `checkpoint_summary` itself exposes only counts.
 *   3. `coverage_strategy` mismatch rejection at manifest registration —
 *      `state_stream`/`parent_streams` each require a specific
 *      `coverage_strategy` value on the same stream.
 *
 * Every assertion is wire-observable: connector JSONL input, HTTP-observable
 * `checkpoint_summary`, `/v1/state`, and run-timeline output. No RI-private
 * function or mock is asserted on directly, so this file exercises the same
 * contract an independent connector/runtime implementer would read from the
 * profile alone.
 *
 * The `runMultiParentScenario` test below runs the SAME scenario (same
 * manifest, same connector script, same assertions — imported from
 * `helpers/checkpoint-dependency-multi-parent-scenario.ts`) that
 * `checkpoint-dependency-profile-conformance-postgres.test.ts` runs against
 * Postgres, so the SQLite/Postgres parity claim compares one identical
 * scenario across both backends rather than two independently authored tests
 * that merely resemble each other.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import {
  runMultiParentScenario,
  runStaticParentEmitsCoverageScenario,
  runSubsetParentCoverageScenario,
  runUndeclaredParentScenario,
} from "./helpers/checkpoint-dependency-multi-parent-scenario.ts";

const FAILING_STREAM_NAME_PATTERN = /sibling_b/;

interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
}
interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
}
const startServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

type RunResult = RuntimeRunConnectorResult & {
  checkpoint_summary?: {
    commit_status?: string;
    state_streams_committed?: number;
    state_streams_staged?: number;
  };
  connector_error?: { code?: string; message?: string; retryable?: boolean | null } | null;
  known_gaps?: { message?: string; reason?: string; stream?: string }[];
};

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "u1"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokenBody.access_token;
}

function fakeAdmitRunConnection(
  ownerSubjectIdDefault = "u1"
): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || ownerSubjectIdDefault;
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

// Two independent, self-mapped sibling streams — no manifest checkpoint
// dependency needed to discriminate cancellation precedence: the point is
// that NEITHER sibling commits once cancellation is observed, even though
// one of them would otherwise be an "untouched sibling" eligible for the
// stream-scoped-failure exception (see runtime-stream-collection-failed-commit.test.ts
// for the un-cancelled counterpart of this exact shape).
function twoSiblingManifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "sibling_a",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "sibling_b",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

function writeConnectorStub(tmpDir: string, script: string): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  ${script}
});
`,
    "utf8"
  );
  return connectorPath;
}

test("a certified stream-scoped-failure DONE racing an owner cancellation commits nothing", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = twoSiblingManifest("checkpoint-profile-cancel-race-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-checkpoint-profile-cancel-"));
  // The stub commits sibling_a, certifies sibling_b's failure, and emits its
  // terminal DONE immediately — giving the runtime time to actually parse
  // and record it (`doneMessage` is set as soon as the JSONL line is read,
  // independent of process exit) — THEN idles so the test can request
  // cancellation while a fully-processed, structurally certified DONE is
  // already sitting in the runtime's state, before the process itself exits.
  // This proves the profile's precedence rule against the harder case: a
  // certified DONE the runtime has already parsed, not merely one racing in
  // transit.
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  // The runtime closes OUR stdin once it has consumed DONE (proc.stdin.end()),
  // which would otherwise auto-exit this process once readline's 'close'
  // fires and no other handle keeps the event loop alive. Hold an active
  // timer so the process idles instead of exiting, giving the test a real
  // window to request cancellation against an already-processed DONE. Exit
  // ONLY on SIGTERM (sent by terminateChild after cancellation is requested).
  const keepAlive = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    clearInterval(keepAlive);
    process.exit(1);
  });
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);
    const cancelSignal = new AbortController();

    const runPromise = runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      cancelSignal: cancelSignal.signal,
      collectionMode: "incremental",
      connectorId: manifest.connector_id,
      connectorPath,
      manifest,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl,
      state: null,
    } as Parameters<typeof runConnector>[0]) as Promise<RunResult>;

    // Give the child a moment to reach its SIGTERM handler registration and
    // emit its pre-DONE messages, then request cancellation. The runtime's
    // process-close precedence (owner cancellation checked before a terminal
    // DONE is evaluated for stream-scoped-failure certification) is the exact
    // rule under test.
    await new Promise((resolve) => setTimeout(resolve, 150));
    cancelSignal.abort();

    const result = await runPromise;

    assert.equal(result.status, "cancelled", "cancellation must win over a would-be certified failure");
    assert.equal(
      result.checkpoint_summary?.state_streams_committed,
      0,
      "no checkpoint commits once cancellation is observed, including the untouched sibling"
    );

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(stateResp.status, 200);
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state, {}, "sibling_a's cursor must not have advanced");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("a checkpoint-store failure mid-commit leaves the already-committed sibling committed and fails the run", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = twoSiblingManifest("checkpoint-profile-partial-store-failure-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-checkpoint-profile-partial-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_b', key: 'b-1', data: { id: 'b-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_b', cursor: { cursor: 'sibling_b_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    // Revoke the owner token's authority to write sibling_b's state (but not
    // sibling_a's, which the runtime commits first) by closing the RS server
    // partway through the run. Simpler and more deterministic: monkeypatch
    // fetch is unavailable here without a network proxy, so instead we drive
    // the failure by revoking the resource-server route for the SECOND
    // commit — achieved by shutting the RS server down between the two
    // `STATE` messages via a tiny proxy that fails every PUT after the first.
    let putCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "PUT" && url.includes("/v1/state/")) {
        putCount += 1;
        if (putCount === 2) {
          return Promise.resolve(new Response("simulated checkpoint-store failure", { status: 503 }));
        }
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    // A checkpoint-store failure mid-commit is a genuine runtime error:
    // `runConnector` REJECTS (rather than resolving with `status: "failed"`)
    // in exactly this case — a state-PUT that itself fails after terminal
    // validation succeeded. The rejected error carries the same
    // `checkpoint_summary` a resolved result would.
    let rejection: (Error & { checkpoint_summary?: RunResult["checkpoint_summary"] }) | null = null;
    try {
      await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      });
    } catch (err) {
      rejection = err as Error & { checkpoint_summary?: RunResult["checkpoint_summary"] };
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(rejection, "a mid-commit checkpoint-store failure must fail the run, not report succeeded");
    const confirmedRejection = rejection as Error & { checkpoint_summary?: RunResult["checkpoint_summary"] };
    // Bounded numeric summary (profile step 5, first clause): counts only, no
    // names required here — checkpoint_summary is not required to expose
    // per-stream identity, only that a caller has SOME path to it (below).
    assert.equal(confirmedRejection.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(
      confirmedRejection.checkpoint_summary?.state_streams_committed,
      1,
      "exactly the checkpoint committed before the store failure remains committed"
    );
    assert.equal(confirmedRejection.checkpoint_summary?.commit_status, "partially_committed");

    // Identity of the FAILING checkpoint stream (profile step 5, second
    // clause): recoverable from the rejected error's own diagnostic message,
    // not from checkpoint_summary.
    assert.match(
      confirmedRejection.message,
      FAILING_STREAM_NAME_PATTERN,
      "the rejected error must name the specific checkpoint stream whose persistence failed"
    );

    // Identity of each COMMITTED checkpoint stream (profile step 5, third
    // clause): recoverable by reading back durable state, independent of
    // checkpoint_summary's bounded counts.
    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(
      stateBody.state,
      { sibling_a: { cursor: "sibling_a_cursor" } },
      "the already-committed sibling_a checkpoint must survive the later failure, and its identity must be recoverable from durable state"
    );

    // Identity of both the failing and the committed stream via the run
    // timeline (an alternate, independent identity channel per the profile's
    // 'not necessarily from a single field' language): run.state_advanced
    // carries stream_id for the commit, run.state_commit_failed carries
    // stream_id for the failure.
    const runId = (confirmedRejection as unknown as { run_id?: string }).run_id;
    if (runId) {
      const { body: runTimeline } = await fetchJson<{ data: { event_type: string; stream_id?: string }[] }>(
        `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`
      );
      const advanced = (runTimeline.data || []).find((event) => event.event_type === "run.state_advanced");
      const commitFailed = (runTimeline.data || []).find((event) => event.event_type === "run.state_commit_failed");
      assert.equal(advanced?.stream_id, "sibling_a", "run.state_advanced identifies the committed stream by name");
      assert.equal(
        commitFailed?.stream_id,
        "sibling_b",
        "run.state_commit_failed identifies the failing stream by name"
      );
    }
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("a stream declaring state_stream/parent_streams without the matching coverage_strategy is rejected at registration", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    // state_stream requires coverage_strategy: "checkpoint_window" on the
    // SAME stream (spec Validation rule 7). Here it is entirely absent.
    const missingStrategyManifest = {
      capabilities: { human_interaction: [] },
      connector_id: "checkpoint-profile-coverage-strategy-missing-test",
      display_name: "checkpoint-profile-coverage-strategy-missing-test",
      manifest_uri: "https://sources.example/checkpoint-profile-coverage-strategy-missing-test",
      protocol_version: "0.1.0",
      streams: [
        {
          name: "parent",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
        {
          name: "child",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
          state_stream: "parent",
        },
      ],
      version: "0.1.0",
    };
    const missingStrategyResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(missingStrategyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(
      missingStrategyResp.status,
      400,
      "a state_stream declaration without coverage_strategy: checkpoint_window must be rejected at registration"
    );

    // parent_streams requires coverage_strategy: "parent_detail_accounting"
    // on the SAME stream. Here it is set to an unrelated valid value
    // ("full_inventory") instead of being absent, proving the mismatch
    // check — not merely an absence check.
    const mismatchedStrategyManifest = {
      capabilities: { human_interaction: [] },
      connector_id: "checkpoint-profile-coverage-strategy-mismatch-test",
      display_name: "checkpoint-profile-coverage-strategy-mismatch-test",
      manifest_uri: "https://sources.example/checkpoint-profile-coverage-strategy-mismatch-test",
      protocol_version: "0.1.0",
      streams: [
        {
          name: "parent_a",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
        {
          name: "parent_b",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
        {
          coverage_strategy: "full_inventory",
          name: "detail",
          parent_streams: ["parent_a", "parent_b"],
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
      version: "0.1.0",
    };
    const mismatchedStrategyResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(mismatchedStrategyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(
      mismatchedStrategyResp.status,
      400,
      "a parent_streams declaration with a coverage_strategy other than parent_detail_accounting must be rejected at registration"
    );

    // Positive control: the correct coverage_strategy on each shape registers successfully.
    const validManifest = {
      capabilities: { human_interaction: [] },
      connector_id: "checkpoint-profile-coverage-strategy-valid-test",
      display_name: "checkpoint-profile-coverage-strategy-valid-test",
      manifest_uri: "https://sources.example/checkpoint-profile-coverage-strategy-valid-test",
      protocol_version: "0.1.0",
      streams: [
        {
          name: "parent",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
        {
          coverage_strategy: "checkpoint_window",
          name: "child",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
          state_stream: "parent",
        },
      ],
      version: "0.1.0",
    };
    const validResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(validManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(
      validResp.status,
      201,
      "the matching coverage_strategy value must register successfully (positive control)"
    );
  } finally {
    await closeServer(server);
  }
});

test("SQLite/Postgres parity scenario (SQLite side): one detail stream independently proves two parent checkpoints", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await runMultiParentScenario({
      admitOwnerRunConnection,
      asUrl,
      connectorId: "checkpoint-profile-sqlite-parity-test",
      createRequestConnectorInstanceStore,
      rsUrl,
      runConnector,
    });
  } finally {
    await closeServer(server);
  }
});

// -----------------------------------------------------------------------
// Manifest-authority adversarial cases (P1-2): live DETAIL_COVERAGE evidence
// must never override or widen the manifest's declared checkpoint-parent
// shape. Case numbers reference the review's "Required adversarial tests"
// list under P1-2.
// -----------------------------------------------------------------------

test("case 1/5/6 (SQLite): a state_stream-declared stream emitting DETAIL_COVERAGE is rejected, preventing the unsafe commit", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await runStaticParentEmitsCoverageScenario({
      admitOwnerRunConnection,
      asUrl,
      connectorId: "checkpoint-profile-static-parent-violation-test",
      createRequestConnectorInstanceStore,
      rsUrl,
      runConnector,
    });
  } finally {
    await closeServer(server);
  }
});

test("case 2 (SQLite): a parent_streams stream emitting DETAIL_COVERAGE naming an undeclared parent is rejected", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await runUndeclaredParentScenario({
      admitOwnerRunConnection,
      asUrl,
      connectorId: "checkpoint-profile-undeclared-parent-test",
      createRequestConnectorInstanceStore,
      rsUrl,
      runConnector,
    });
  } finally {
    await closeServer(server);
  }
});

test("case 3/4 (SQLite): a declared parent with no live coverage report is withheld, not dropped or silently satisfied", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await runSubsetParentCoverageScenario({
      admitOwnerRunConnection,
      asUrl,
      connectorId: "checkpoint-profile-subset-parent-test",
      createRequestConnectorInstanceStore,
      rsUrl,
      runConnector,
    });
  } finally {
    await closeServer(server);
  }
});
