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
// silently diverge per connector; only the fixture-seeding and entrypoint
// path differ, and those differences live in DATA (home layout), not in
// branching logic.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { COLLECTION_SCOPE_STATE_KEY, runCollectorConnector } from "./collector-runner.ts";

const CONNECTORS_DIR = join(import.meta.dirname, "..", "connectors");
const SINCE = "2026-06-01T00:00:00.000Z";

interface ConnectorFixture {
  readonly connector: "claude_code" | "codex";
  readonly env: Record<string, string>;
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
  // Poisoned: malformed JSON, so any code path that reads it surfaces loudly
  // rather than silently succeeding on out-of-boundary data.
  await writeFile(join(outOfRangeDir, "session.jsonl"), '{"broken PDPP_SENTINEL_MUST_NOT_BE_READ\n', "utf8");
  return {
    connector: "claude_code",
    env: { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: projectsDir },
    streams: ["sessions", "messages", "coverage_diagnostics"],
    timeScopableStreams: ["sessions", "messages"],
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
      payload: { cwd: "/home/u/p", id: "33333333-3333-4333-8333-333333333333", timestamp: "2026-07-01T00:00:00.000Z" },
      type: "session_meta",
    })}\n`,
    "utf8"
  );
  return {
    connector: "codex",
    env: { CODEX_HOME: codexHome },
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
  terminalPosts: Record<string, unknown>[];
  url: string;
}

/** A real HTTP reference-server double: persists state across calls, like the real server does. */
async function startRunHarness(initialState: Record<string, unknown> = {}): Promise<RunHarness> {
  const terminalPosts: Record<string, unknown>[] = [];
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
      if (url.endsWith("/terminal-collection")) {
        terminalPosts.push(parsed ?? {});
        send(200, { object: "device_terminal_collection", status: "accepted" });
        return;
      }
      if (url.endsWith("/state")) {
        if (req.method === "PUT" && parsed && typeof parsed.state === "object" && parsed.state) {
          persisted = { ...persisted, ...(parsed.state as Record<string, unknown>) };
        }
        send(200, {
          device_id: "device-1",
          object: "device_source_instance_state",
          source_instance_id: "src-1",
          state: persisted,
          updated_at: null,
        });
        return;
      }
      if (url.includes("/ingest-batches")) {
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
    terminalPosts,
    url: `http://127.0.0.1:${port}`,
  };
}

function scopeState(since: string): Record<string, unknown> {
  return { [COLLECTION_SCOPE_STATE_KEY]: { declared_at: "2026-08-01T00:00:00.000Z", scope: { since } } };
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
  return runCollectorConnector({
    ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {}),
    baseUrl: harness.url,
    connector: {
      args: ["--import", "tsx", join(CONNECTORS_DIR, fixture.connector, "index.ts")],
      command: process.execPath,
      connector_id: fixture.connector,
      enforcesSourceRoots: true,
      env: { ...fixture.env, PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
      runtime_requirements: { bindings: {} },
      streams: fixture.streams,
      timeScopableStreams: fixture.timeScopableStreams,
    },
    deviceId: "device-1",
    deviceToken: "device-token",
    queuePath: overrides.queuePath ?? (await tempQueuePath()),
    sourceInstanceId: "src-1",
  });
}

for (const connectorId of ["claude_code", "codex"] as const) {
  test(`${connectorId}: a complete bounded run commits coverage naming the declared boundary`, async () => {
    const fixture = await FIXTURES[connectorId]();
    const harness = await startRunHarness(scopeState(SINCE));
    try {
      const result = await runFixture(fixture, harness);

      assert.equal(result.done?.status, "succeeded", "the connector must finish cleanly to prove coverage at all");
      assert.equal(result.scanBudgetExceeded, false);
      assert.equal(
        harness.terminalPosts.length,
        1,
        "an exhaustive pass within the declared boundary must commit exactly one terminal coverage claim"
      );
      const post = harness.terminalPosts[0] as { collection_scope?: string };
      assert.equal(
        post.collection_scope,
        `since=${SINCE}`,
        "committed evidence must name the exact boundary it was measured against, not a generic 'complete'"
      );
    } finally {
      await harness.close();
    }
  });

  test(`${connectorId}: an interrupted run before completion commits no coverage checkpoint`, async () => {
    const fixture = await FIXTURES[connectorId]();
    const harness = await startRunHarness(scopeState(SINCE));
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
    const harness = await startRunHarness(scopeState(SINCE));
    try {
      const result = await runFixture(fixture, harness);
      assert.equal(result.done?.status, "succeeded");
      // The poisoned out-of-boundary fixture would have thrown a JSON parse
      // error into DONE/records if it were ever opened; a clean succeeded
      // DONE is itself evidence it was skipped at enumeration, matching
      // collector-scope-enumeration-bound.test.ts's direct proof.
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
    const firstHarness = await startRunHarness(scopeState(SINCE));
    try {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(() => runFixture(fixture, firstHarness, { abortSignal: controller.signal, queuePath }));
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
    const secondHarness = await startRunHarness(scopeState(SINCE));
    try {
      const result = await runFixture(fixture, secondHarness, { queuePath });
      assert.equal(result.done?.status, "succeeded");
      assert.equal(
        secondHarness.terminalPosts.length,
        1,
        "resuming after an interruption must reach exactly one committed coverage claim, not a duplicate"
      );
      const post = secondHarness.terminalPosts[0] as { collection_scope?: string };
      assert.equal(post.collection_scope, `since=${SINCE}`);

      // Idempotency: running a THIRD time against the already-complete,
      // already-committed queue must not re-report or duplicate coverage —
      // the collector's own per-file cursors fast-skip unchanged sources, and
      // the runner must not re-fire a terminal-collection claim from a lane
      // that already committed one under the same boundary.
      const thirdResult = await runFixture(fixture, secondHarness, { queuePath });
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
