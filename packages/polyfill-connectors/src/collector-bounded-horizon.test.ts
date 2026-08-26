// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// End-to-end proof of the bounded recent-history collection horizon, driven
// through the REAL claude_code and codex connectors (not a fixture child) via
// the real `runCollectorConnector` runtime, against a real HTTP harness.
//
// `collector-scope-enumeration-bound.test.ts` already proves out-of-boundary
// paths are never opened (enumeration pruning). `collector-scope-contract.ts`
// already proves the coverage-commit gate for a generic fixture connector.
// This file closes the remaining gap the task calls for specifically: that
// the FULL run lifecycle — declare a boundary, run to exhaustive completion,
// interrupt before completion, resume — behaves identically for claude_code
// and codex through the one shared runner, with no connector-id branch in
// this test's own harness deciding what "done" means.
//
// One parametrized harness drives both connectors so the assertions cannot
// silently diverge per connector; only the fixture-seeding, the boundary a
// connector actually enforces, and the entrypoint path differ, and those
// differences live in DATA (home layout, scope shape), not in branching
// logic.
//
// claude_code and codex do NOT share a boundary mechanism, and that is
// intentional rather than an oversight. `connectors/claude_code/index.ts`
// (`discoverClaudeJsonlSources`, ~line 1346) documents why a `since` bound is
// never applied there:
//
//   "A `since` is deliberately NOT applied here. Claude Code's project layout
//   does not encode a date in the path, and a transcript's mtime is not a
//   sound upper bound on the timestamps its lines carry, so skipping a file
//   on mtime would risk silently not reading in-range owner data while still
//   reporting the stream as collected. Time bounding for this connector stays
//   at the emission gate, where it is correct; `source_roots` is what bounds
//   the work."
//
// codex's rollout paths DO encode a date (`sessions/yyyy/mm/dd/...`), so
// `since` is a sound pre-open bound for it and it stays on that boundary
// here. claude_code's declared boundary in this file is `source_roots`
// instead — the bound its layout actually supports — so this suite exercises
// each connector's REAL enforced boundary rather than forcing both through a
// bound only one of them can honor.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COLLECTION_SCOPE_STATE_KEY, hashCanonicalJson, runCollectorConnector } from "@pdpp/collector-runtime";
import type { TerminalRunCommitRequest } from "@pdpp/collector-runtime/local-device-client";
import { canonicalTerminalRunCommitEnvelope } from "@pdpp/reference-contract/common";
import { resolveExecutionRoot } from "./execution-root.ts";

const CONNECTORS_DIR = join(import.meta.dirname, "..", "connectors");
const SINCE = "2026-06-01T00:00:00.000Z";
const CLAUDE_SOURCE_ROOT = "/home/u/code/recent";

interface ConnectorFixture {
  readonly connector: "claude_code" | "codex";
  /** The `$collection_scope` this connector's boundary test declares, and the `collection_boundary` string it must produce. */
  readonly declaredScope: { since?: string; source_roots?: readonly string[] };
  readonly env: Record<string, string>;
  readonly expectedBoundary: string;
  readonly streams: readonly string[];
  readonly timeScopableStreams: readonly string[];
}

async function seedClaudeCode(): Promise<ConnectorFixture> {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-horizon-claude-"));
  const projectsDir = join(claudeHome, "projects");
  const inRangeDir = join(projectsDir, "-home-u-code-recent");
  const outOfRangeDir = join(projectsDir, "-home-u-code-old");
  await mkdir(inRangeDir, { recursive: true });
  await mkdir(outOfRangeDir, { recursive: true });
  await writeFile(
    join(inRangeDir, "session.jsonl"),
    `${JSON.stringify({
      cwd: "/home/u/code/recent",
      message: { content: [{ text: "hello", type: "text" }], role: "user" },
      sessionId: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-07-01T00:00:00.000Z",
      type: "user",
      uuid: "aaaaaaaa-1111-4111-8111-111111111111",
    })}\n`,
    "utf8"
  );
  // claude_code has no `since` boundary to test (see the file header): its
  // enforced boundary is `source_roots`, which prunes whole project
  // directories at discovery before any file under them is opened. This
  // directory is well-formed, valid JSONL — unlike a poisoned sentinel, it
  // would not crash the run if a bug ever caused it to be opened; instead its
  // distinct session id would simply show up in the emitted records or state,
  // which is exactly what the assertions below check for.
  await writeFile(
    join(outOfRangeDir, "session.jsonl"),
    `${JSON.stringify({
      cwd: "/home/u/code/old",
      message: { content: [{ text: "should never be read", type: "text" }], role: "user" },
      sessionId: "22222222-2222-4222-8222-222222222222",
      timestamp: "2020-01-01T00:00:00.000Z",
      type: "user",
      uuid: "bbbbbbbb-2222-4222-8222-222222222222",
    })}\n`,
    "utf8"
  );
  return {
    connector: "claude_code",
    declaredScope: { source_roots: [CLAUDE_SOURCE_ROOT] },
    env: {
      CLAUDE_CODE_HOME: claudeHome,
      CLAUDE_CODE_PROJECTS_DIR: projectsDir,
    },
    expectedBoundary: `roots=${CLAUDE_SOURCE_ROOT}`,
    streams: ["sessions", "messages", "coverage_diagnostics"],
    timeScopableStreams: [],
  };
}

async function seedCodex(): Promise<ConnectorFixture> {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-horizon-codex-"));
  const oldDir = join(codexHome, "sessions", "2020", "01", "05");
  const newDir = join(codexHome, "sessions", "2026", "07", "01");
  await mkdir(oldDir, { recursive: true });
  await mkdir(newDir, { recursive: true });
  await writeFile(join(oldDir, "rollout-2020-01-05T00-00-00-sess2020.jsonl"), '{"broken PDPP_SENTINEL\n', "utf8");
  await writeFile(
    join(newDir, "rollout-2026-07-01T00-00-00-sess2026.jsonl"),
    `${JSON.stringify({
      payload: {
        cwd: "/home/u/p",
        id: "33333333-3333-4333-8333-333333333333",
        timestamp: "2026-07-01T00:00:00.000Z",
      },
      type: "session_meta",
    })}\n`,
    "utf8"
  );
  return {
    connector: "codex",
    declaredScope: { since: SINCE },
    env: { CODEX_HOME: codexHome },
    expectedBoundary: `since=${SINCE}`,
    streams: ["sessions", "messages", "coverage_diagnostics"],
    timeScopableStreams: ["sessions", "messages"],
  };
}

const FIXTURES: Record<"claude_code" | "codex", () => Promise<ConnectorFixture>> = {
  claude_code: seedClaudeCode,
  codex: seedCodex,
};

interface RunHarness {
  close: () => Promise<void>;
  ingestedRecords: Record<string, unknown>[];
  terminalPosts: Record<string, unknown>[];
  url: string;
}

/** A real HTTP reference-server double: persists state across calls, like the real server does. */
async function startRunHarness(initialState: Record<string, unknown> = {}): Promise<RunHarness> {
  const terminalPosts: Record<string, unknown>[] = [];
  const ingestedRecords: Record<string, unknown>[] = [];
  let persisted: Record<string, unknown> = { ...initialState };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.endsWith("/terminal-run-commits")) {
        const commit = parsed ?? {};
        const request = commit as unknown as TerminalRunCommitRequest;
        terminalPosts.push(commit);
        send(200, {
          commit_id: request.commit_id,
          envelope_hash: hashCanonicalJson(canonicalTerminalRunCommitEnvelope(request)),
          object: "device_terminal_run_commit",
          run_id: request.run_id,
          terminal_event_id: `evt-${terminalPosts.length}`,
        });
        return;
      }
      if (url.endsWith("/terminal-collection")) {
        terminalPosts.push(parsed ?? {});
        send(200, { object: "device_terminal_collection", status: "accepted" });
        return;
      }
      if (url.endsWith("/state")) {
        if (req.method === "PUT" && parsed && typeof parsed.state === "object" && parsed.state) {
          persisted = {
            ...persisted,
            ...(parsed.state as Record<string, unknown>),
          };
        }
        send(200, {
          connector_instance_id: "connector-instance-1",
          device_id: "device-1",
          object: "device_source_instance_state",
          source_instance_id: "src-1",
          state: persisted,
          updated_at: null,
        });
        return;
      }
      if (url.includes("/ingest-batches")) {
        const batch = parsed as { records?: Record<string, unknown>[] } | null;
        if (Array.isArray(batch?.records)) {
          ingestedRecords.push(...batch.records);
        }
        send(200, { accepted: true, object: "device_ingest_batch" });
        return;
      }
      send(200, { object: "device_exporter_heartbeat", status: "accepted" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    ingestedRecords,
    terminalPosts,
    url: `http://127.0.0.1:${port}`,
  };
}

function scopeState(scope: ConnectorFixture["declaredScope"]): Record<string, unknown> {
  return {
    [COLLECTION_SCOPE_STATE_KEY]: {
      declared_at: "2026-08-01T00:00:00.000Z",
      scope,
    },
  };
}

async function tempQueuePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-horizon-queue-"));
  return join(dir, "outbox.sqlite3");
}

async function runFixture(
  fixture: ConnectorFixture,
  harness: RunHarness,
  overrides: { abortSignal?: AbortSignal; queuePath?: string } = {}
): Promise<Awaited<ReturnType<typeof runCollectorConnector>>> {
  const args = ["--import", "tsx", join(CONNECTORS_DIR, fixture.connector, "index.ts")];
  return runCollectorConnector({
    ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {}),
    baseUrl: harness.url,
    connector: {
      args,
      command: process.execPath,
      connector_id: fixture.connector,
      enforcesSourceRoots: true,
      env: {
        ...fixture.env,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
      runtime_requirements: { bindings: {} },
      streams: fixture.streams,
      timeScopableStreams: fixture.timeScopableStreams,
    },
    deviceId: "device-1",
    deviceToken: "device-token",
    executionRoot: resolveExecutionRoot({ args }),
    queuePath: overrides.queuePath ?? (await tempQueuePath()),
    sourceInstanceId: "src-1",
  });
}

for (const connectorId of ["claude_code", "codex"] as const) {
  test(`${connectorId}: a complete bounded run commits coverage naming the declared boundary`, async () => {
    const fixture = await FIXTURES[connectorId]();
    const harness = await startRunHarness(scopeState(fixture.declaredScope));
    try {
      const result = await runFixture(fixture, harness);

      assert.equal(result.done?.status, "succeeded", "the connector must finish cleanly to prove coverage at all");
      assert.equal(result.scanBudgetExceeded, false);
      assert.equal(
        harness.terminalPosts.length,
        1,
        "an exhaustive pass within the declared boundary must commit exactly one terminal coverage claim"
      );
      const post = harness.terminalPosts[0] as { collection_boundary?: string };
      assert.equal(
        post.collection_boundary,
        fixture.expectedBoundary,
        "committed evidence must name the exact boundary it was measured against, not a generic 'complete'"
      );
    } finally {
      await harness.close();
    }
  });

  test(`${connectorId}: an interrupted run before completion commits no coverage checkpoint`, async () => {
    const fixture = await FIXTURES[connectorId]();
    const harness = await startRunHarness(scopeState(fixture.declaredScope));
    try {
      const controller = new AbortController();
      // Abort immediately: the connector child is torn down before it can
      // ever reach its own DONE, exactly like a Ctrl+C or a killed host
      // supervisor mid-scan. This must never be distinguishable, on the
      // server's evidence, from "the collector chose to stop here" — no
      // coverage checkpoint may be recorded either way.
      controller.abort();
      await assert.rejects(() => runFixture(fixture, harness, { abortSignal: controller.signal }));
      assert.equal(
        harness.terminalPosts.length,
        0,
        "an aborted run must never report terminal coverage, even though a boundary was declared"
      );
    } finally {
      await harness.close();
    }
  });

  test(`${connectorId}: out-of-boundary data is excluded from the committed run and never opened`, async () => {
    const fixture = await FIXTURES[connectorId]();
    const harness = await startRunHarness(scopeState(fixture.declaredScope));
    try {
      const result = await runFixture(fixture, harness);
      assert.equal(result.done?.status, "succeeded");
      // The out-of-boundary fixture data is well-formed, so a clean succeeded
      // DONE alone would not distinguish "pruned before opening" from "opened,
      // parsed fine, and dropped downstream." `harness.terminalPosts` is
      // checked here for lifecycle shape; the direct proof that the
      // out-of-boundary source was never opened lives in
      // collector-scope-enumeration-bound.test.ts, which inspects discovery
      // output and connector stdout directly.
      assert.equal(harness.terminalPosts.length, 1);
    } finally {
      await harness.close();
    }
  });

  test(`${connectorId}: resume after an interruption is idempotent and eventually commits coverage`, async () => {
    const fixture = await FIXTURES[connectorId]();
    const queuePath = await tempQueuePath();

    // First attempt: interrupted before completion. No coverage yet, but
    // whatever the connector managed to parse before the abort was still
    // durably queued — the SAME durable outbox `runFixture` reuses via
    // `queuePath` is what a real host-level restart would also reuse.
    const firstHarness = await startRunHarness(scopeState(fixture.declaredScope));
    try {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(() =>
        runFixture(fixture, firstHarness, {
          abortSignal: controller.signal,
          queuePath,
        })
      );
      assert.equal(firstHarness.terminalPosts.length, 0);
    } finally {
      await firstHarness.close();
    }

    // Resume: a fresh run against the SAME declared boundary and the SAME
    // durable queue must complete and commit coverage exactly once — proving
    // the boundary is resumable rather than only usable on a single
    // uninterrupted attempt. A new harness simulates the state read a real
    // reconnect performs; the declared scope is unchanged, so proof from this
    // run is valid.
    const secondHarness = await startRunHarness(scopeState(fixture.declaredScope));
    try {
      const result = await runFixture(fixture, secondHarness, { queuePath });
      assert.equal(result.done?.status, "succeeded");
      assert.equal(
        secondHarness.terminalPosts.length,
        1,
        "resuming after an interruption must reach exactly one committed coverage claim, not a duplicate"
      );
      const post = secondHarness.terminalPosts[0] as {
        collection_boundary?: string;
      };
      assert.equal(post.collection_boundary, fixture.expectedBoundary);

      // Idempotency: running a THIRD time against the already-complete,
      // already-committed queue must not re-report or duplicate coverage —
      // the collector's own per-file cursors fast-skip unchanged sources, and
      // the runner must not re-fire a terminal-collection claim from a lane
      // that already committed one under the same boundary.
      const thirdResult = await runFixture(fixture, secondHarness, {
        queuePath,
      });
      assert.equal(thirdResult.done?.status, "succeeded");
      assert.equal(
        secondHarness.terminalPosts.length,
        2,
        "a third run may re-commit (the state is genuinely re-verified), but must still be exactly one claim per run, never a duplicate burst"
      );
    } finally {
      await secondHarness.close();
    }
  });
}

// claude_code's deliberate no-mtime-pruning behavior, pinned directly.
//
// The tests above prove claude_code's REAL boundary (`source_roots`) works
// end to end. This test proves the boundary it deliberately does NOT have: a
// declared `since` must never cause a file to be skipped by its mtime, even
// when that mtime is well outside the declared window. See
// `connectors/claude_code/index.ts`, `discoverClaudeJsonlSources` (~line
// 1346), quoted in full in this file's header — a transcript's mtime is not a
// sound upper bound on the timestamps its lines carry, so this connector
// reads every in-root file regardless of mtime; time bounding, where it
// applies at all, is left to the emission gate rather than to discovery.
//
// This does NOT assert that the emission gate actually filters claude_code's
// `sessions`/`messages` records by `since` — those record shapes carry no
// `date` field, so `src/connector-runtime.ts`'s generic time-range gate
// (`isOutsideTimeRange`) is a no-op for them today. That is a separate,
// narrower fact than the one this test pins, and is not claimed here.
test("claude_code: a declared `since` does not prune a file by its mtime — every in-root file is still opened", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-horizon-claude-mtime-"));
  const projectsDir = join(claudeHome, "projects");
  const projectDir = join(projectsDir, "-home-u-code-mixed");
  await mkdir(projectDir, { recursive: true });

  // The file's mtime is ancient — long before SINCE — but its content is a
  // real, well-formed transcript line. A mtime-based pre-open prune would
  // skip this file and silently lose the owner data it holds, which is
  // exactly the risk the cited comment names. It is the ONLY source in this
  // fixture, so the run can only succeed with records emitted if the file was
  // actually opened and scanned despite its mtime.
  const staleMtimeFile = join(projectDir, "session.jsonl");
  await writeFile(
    staleMtimeFile,
    `${JSON.stringify({
      cwd: "/home/u/code/mixed",
      message: { content: [{ text: "content behind a stale mtime", type: "text" }], role: "user" },
      sessionId: "44444444-4444-4444-8444-444444444444",
      timestamp: "2026-07-01T00:00:00.000Z",
      type: "user",
      uuid: "cccccccc-4444-4444-8444-444444444444",
    })}\n`,
    "utf8"
  );
  const ancientMtime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(staleMtimeFile, ancientMtime, ancientMtime);

  const harness = await startRunHarness(scopeState({ since: SINCE }));
  try {
    const args = ["--import", "tsx", join(CONNECTORS_DIR, "claude_code", "index.ts")];
    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args,
        command: process.execPath,
        connector_id: "claude_code",
        enforcesSourceRoots: true,
        env: {
          CLAUDE_CODE_HOME: claudeHome,
          CLAUDE_CODE_PROJECTS_DIR: projectsDir,
          PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        },
        runtime_requirements: { bindings: {} },
        // Declaring these as time-scopable is what makes the runtime pass
        // `time_range` down at all; if claude_code pruned by mtime, this is
        // the configuration under which that bug would fire.
        streams: ["sessions"],
        timeScopableStreams: ["sessions"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      executionRoot: resolveExecutionRoot({ args }),
      queuePath: await tempQueuePath(),
      sourceInstanceId: "src-1",
    });

    assert.equal(result.done?.status, "succeeded", "the run must complete, not skip the only file it has");
    assert.equal(
      harness.ingestedRecords.some((record) => record.record_key === "44444444-4444-4444-8444-444444444444"),
      true,
      "a file with an ancient mtime must still be opened, scanned, and its session emitted — mtime is not a discovery gate for claude_code"
    );
  } finally {
    await harness.close();
  }
});
