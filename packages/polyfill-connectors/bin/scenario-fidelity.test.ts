// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct proof for `src/scenario/subprocess-fetch-preloads.ts`'s recorder/
 * replay fidelity fixes and `src/scenario/isolation.ts`'s network-namespace
 * isolation — driven straight against those modules' exported functions
 * (not through `bin/scenario-record.ts`/`bin/scenario-verify.ts`, which are
 * owned by a different lane and under concurrent edit), spawning real
 * connector subprocesses exactly the way those CLIs do internally.
 *
 * FINDING reused from `bin/scenario-cli.test.ts`: an HTTP server bound
 * in-process inside a `node --test` run is unreachable from a spawned
 * subprocess in this environment — this file's synthetic HTTP provider
 * therefore runs as its own standalone `node` subprocess, the same
 * `startStandaloneServer` shape `bin/scenario-cli.test.ts` uses.
 *
 * Covers (see ACCEPTANCE in the task): body-hash recorded, header allowlist
 * round-trip, plain-text body integrity, seq-at-initiation under two
 * concurrent requests, truncation→incomplete signal, pending-counter race
 * (fire-and-forget + exit → incomplete), binding produced for a
 * provider-issued cursor with the raw value absent from the persisted
 * scenario JSON, and an isolation canary (skip-if-unavailable).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ScenarioInteraction } from "../src/scenario/format.ts";
import { isNamespaceIsolationAvailable, spawnWithNetworkIsolation } from "../src/scenario/isolation.ts";
import { createReplayFetch } from "../src/scenario/replay.ts";
import {
  cleanupScenarioEvidenceWorkspace,
  createScenarioEvidenceWorkspace,
  type FetchBridgeServer,
  messagesToRecordsAndState,
  PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV,
  type ProtocolMessage,
  type RecordPreloadCaptureEnvelope,
  type ScenarioEvidenceWorkspace,
  startFetchBridgeServer,
  subprocessEnv,
  writeRecordPreload,
  writeReplayBridgePreload,
} from "../src/scenario/subprocess-fetch-preloads.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const FIXTURES_DIR = join(PACKAGE_ROOT, "src", "test-fixtures");

// ─── Standalone provider process (mirrors bin/scenario-cli.test.ts) ───────

interface StandaloneProvider {
  close: () => Promise<void>;
  url: string;
}

/**
 * Spawns a standalone `node` HTTP server implementing every route this
 * test's fixture connectors call: `/session` (POST, JSON body),
 * `/page?session_token=...` (echoes items; the token must equal the
 * provider-issued cursor from `/session`), `/secret-page` (any query,
 * ignored), `/huge` (a response over the recorder's 2MB cap), `/slow` and
 * `/fast` (concurrency probe — `/slow` waits 150ms before responding,
 * `/fast` responds immediately, so a caller that starts both concurrently
 * gets `/fast`'s response first even though `/slow` was called first),
 * `/never-responds` (accepts the connection, never writes a response),
 * `/greeting` (text/plain "hello"), and `/ping` (JSON `{ok:true}`, for the
 * isolation-canary fixture's legitimate-traffic proof).
 */
function startStandaloneProvider(): Promise<StandaloneProvider> {
  const scriptPath = join(tmpdir(), `pdpp-scenario-fidelity-provider-${String(process.pid)}-${String(Date.now())}.mjs`);
  const src = `
import { createServer } from "node:http";

const SESSION_CURSOR = "provider-issued-cursor-abcdef123456";
const HUGE_BYTES = 3 * 1024 * 1024; // over the 2MB MAX_STORED_BODY_BYTES cap

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/session" && req.method === "POST") {
    res.writeHead(200, {
      "content-type": "application/json",
      "etag": '"session-etag-1"',
      "x-ratelimit-remaining": "42",
      "x-not-allowlisted-header": "should-never-be-recorded",
    });
    res.end(JSON.stringify({ cursor: SESSION_CURSOR }));
    return;
  }
  if (url.pathname === "/page") {
    const token = url.searchParams.get("session_token");
    if (token !== SESSION_CURSOR) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected session_token" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [{ id: "page-item-1" }] }));
    return;
  }
  if (url.pathname === "/secret-page") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/huge") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ blob: "x".repeat(HUGE_BYTES) }));
    return;
  }
  if (url.pathname === "/slow") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "slow-item" }));
    }, 150);
    return;
  }
  if (url.pathname === "/fast") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "fast-item" }));
    return;
  }
  if (url.pathname === "/never-responds") {
    // Deliberately never call res.end() / res.writeHead().
    return;
  }
  if (url.pathname === "/greeting") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello");
    return;
  }
  if (url.pathname === "/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, "127.0.0.1", () => {
  console.log("PORT " + server.address().port);
});
`;
  writeFileSync(scriptPath, src);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let closed = false;
    const closePromise = (): Promise<void> =>
      new Promise((closeResolve) => {
        if (closed) {
          closeResolve();
          return;
        }
        closed = true;
        child.once("close", () => closeResolve());
        child.kill();
      });
    const onData = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString();
      const match = /PORT (\d+)/.exec(stdoutBuffer);
      if (match?.[1]) {
        child.stdout.off("data", onData);
        resolve({ url: `http://127.0.0.1:${match[1]}`, close: closePromise });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!stdoutBuffer.includes("PORT")) {
        reject(new Error(`standalone provider exited before binding (code=${String(code)}): ${stderrBuffer}`));
      }
    });
  });
}

// ─── Record-side driver: spawns a fixture connector under the RECORD preload ──

interface RecordRunResult {
  capture: RecordPreloadCaptureEnvelope;
  code: number | null;
  messages: ProtocolMessage[];
  stderr: string;
}

function runRecordSubprocess(args: {
  connectorPath: string;
  env?: Record<string, string>;
  workspace: ScenarioEvidenceWorkspace;
}): Promise<RecordRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const capturePath = join(args.workspace.dir, `capture-${String(Date.now())}.json`);
    const preloadPath = writeRecordPreload(capturePath, args.workspace);

    const child = spawn(process.execPath, ["--import", "tsx", args.connectorPath], {
      cwd: PACKAGE_ROOT,
      env: { ...subprocessEnv(), ...args.env, NODE_OPTIONS: `--import ${preloadPath}` },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: ProtocolMessage[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`record subprocess timed out; stderr=${stderr}`));
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.trim()) {
          try {
            messages.push(JSON.parse(line) as ProtocolMessage);
          } catch {
            // Non-JSON stdout line: ignore.
          }
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let capture: RecordPreloadCaptureEnvelope;
      try {
        capture = JSON.parse(readFileSync(capturePath, "utf8")) as RecordPreloadCaptureEnvelope;
      } catch (err) {
        rejectPromise(
          new Error(`failed to read capture file ${capturePath}: ${err instanceof Error ? err.message : String(err)}`)
        );
        return;
      }
      resolvePromise({ code, messages, stderr, capture });
    });

    child.stdin.write(`${JSON.stringify({ type: "START", scope: { streams: [{ name: "items" }] } })}\n`);
    child.stdin.end();
  });
}

// ─── Replay-side driver: spawns a fixture connector under the REPLAY preload ──

function runReplaySubprocess(args: {
  bridgeUrl: string;
  connectorPath: string;
  env?: Record<string, string>;
  workspace: ScenarioEvidenceWorkspace;
}): Promise<{ code: number | null; messages: ProtocolMessage[]; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const preloadPath = writeReplayBridgePreload(args.bridgeUrl, { workspace: args.workspace });
    const child = spawn(process.execPath, ["--import", "tsx", args.connectorPath], {
      cwd: PACKAGE_ROOT,
      env: { ...subprocessEnv(), ...args.env, NODE_OPTIONS: `--import ${preloadPath}` },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: ProtocolMessage[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`replay subprocess timed out; stderr=${stderr}`));
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.trim()) {
          try {
            messages.push(JSON.parse(line) as ProtocolMessage);
          } catch {
            // Non-JSON stdout line: ignore.
          }
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, messages, stderr });
    });

    child.stdin.write(`${JSON.stringify({ type: "START", scope: { streams: [{ name: "items" }] } })}\n`);
    child.stdin.end();
  });
}

// ─── FIX 1: recorder fidelity ──────────────────────────────────────────────

test("scenario-fidelity: recorder captures body_sha256, allowlisted headers, and a binding for a provider-issued cursor", async (t) => {
  const provider = await startStandaloneProvider();
  const workspace = createScenarioEvidenceWorkspace();
  try {
    const result = await runRecordSubprocess({
      connectorPath: join(FIXTURES_DIR, "scenario-fidelity-http-connector.ts"),
      env: { PDPP_SCENARIO_FIDELITY_BASE_URL: provider.url },
      workspace,
    });
    const done = result.messages.find((m) => m.type === "DONE");
    assert.equal(
      done?.status,
      "succeeded",
      `expected succeeded DONE, got ${JSON.stringify(done)}; stderr=${result.stderr}`
    );

    const { interactions } = result.capture;
    assert.equal(interactions.length, 4, "session POST, page GET, secret-page GET, huge GET");

    // ── (a) body_sha256 recorded for the POST with a body ──
    const sessionInteraction = interactions.find((i) => i.request.path === "/session");
    assert.ok(sessionInteraction, "expected a /session interaction");
    assert.match(
      sessionInteraction?.request.body_sha256 ?? "",
      /^[0-9a-f]{64}$/,
      "body_sha256 must be a sha256 hex digest"
    );
    const expectedHash = createHashOfJsonBody({ client: "scenario-fidelity-http-connector" });
    assert.equal(
      sessionInteraction?.request.body_sha256,
      expectedHash,
      "body_sha256 must match the actual request body"
    );

    // ── (b) allowlisted headers retained, non-allowlisted header dropped ──
    const headerNames = (sessionInteraction?.response.headers ?? []).map(([name]) => name);
    assert.ok(headerNames.includes("etag"), `expected etag retained, got ${JSON.stringify(headerNames)}`);
    assert.ok(
      headerNames.includes("x-ratelimit-remaining"),
      `expected x-ratelimit-remaining retained, got ${JSON.stringify(headerNames)}`
    );
    assert.ok(!headerNames.includes("x-not-allowlisted-header"), "non-allowlisted header must be dropped");

    // ── binding for the provider-issued session_token; raw cursor absent from stored query ──
    const pageInteraction = interactions.find((i) => i.request.path === "/page");
    assert.ok(pageInteraction, "expected a /page interaction");
    const tokenParam = pageInteraction?.request.query.find(([name]) => name === "session_token");
    assert.equal(tokenParam, undefined, "session_token must NOT appear in the stored query at all");
    assert.equal(pageInteraction?.bindings?.length, 1, "expected exactly one binding");
    assert.equal(pageInteraction?.bindings?.[0]?.param, "session_token");
    assert.equal(pageInteraction?.bindings?.[0]?.source_seq, sessionInteraction?.seq);
    assert.equal(pageInteraction?.bindings?.[0]?.json_path, ".cursor");

    // The raw provider-issued cursor value must never appear as a QUERY
    // VALUE in any stored request — the whole point of a binding over raw
    // retention. (It legitimately DOES appear in /session's own response
    // BODY, since that's the actual server data the binding points back
    // to — this assertion is specifically about the query string, not the
    // whole capture.)
    for (const interaction of interactions) {
      for (const [name, value] of interaction.request.query) {
        assert.notEqual(
          value,
          "provider-issued-cursor-abcdef123456",
          `raw provider-issued cursor must never appear as a query value (param=${name})`
        );
      }
    }

    // ── genuine client secret still redacted+normalized (unchanged behavior) ──
    const secretInteraction = interactions.find((i) => i.request.path === "/secret-page");
    const apiKeyParam = secretInteraction?.request.query.find(([name]) => name === "api_key");
    assert.equal(apiKeyParam, undefined, "genuine api_key must still be stripped from stored query");
    assert.ok(
      !secretInteraction?.bindings?.some((b) => b.param === "api_key"),
      "genuine api_key must not become a binding"
    );
    assert.ok(
      result.capture.normalizerNames.includes("api_key"),
      `expected api_key in normalizerNames, got ${JSON.stringify(result.capture.normalizerNames)}`
    );
    assert.doesNotMatch(
      JSON.stringify(result.capture),
      /genuinely-never-issued-by-provider/,
      "genuine secret value must never be persisted"
    );

    // ── (d) truncation → incomplete signal ──
    const hugeInteraction = interactions.find((i) => i.request.path === "/huge");
    assert.equal(hugeInteraction?.response.truncated, true, "the oversized /huge response must be marked truncated");
    assert.equal(result.capture.truncatedCount, 1, "truncatedCount must reflect the one truncated interaction");
    assert.equal(result.capture.incomplete, true, "a truncated capture must be flagged incomplete");
    assert.equal(
      result.capture.storageFailed,
      false,
      "truncation is not a storage failure — storageFailed stays false"
    );

    t.diagnostic(`interactions: ${JSON.stringify(interactions.map((i) => ({ seq: i.seq, path: i.request.path })))}`);
  } finally {
    await provider.close();
    cleanupScenarioEvidenceWorkspace(workspace);
  }
});

function createHashOfJsonBody(body: unknown): string {
  return createHash("sha256")
    .update(Buffer.from(JSON.stringify(body)))
    .digest("hex");
}

// ─── FIX 1(c): seq assigned at request initiation, not completion ─────────

test("scenario-fidelity: seq reflects request-initiation order under two concurrent requests", async (t) => {
  const provider = await startStandaloneProvider();
  const workspace = createScenarioEvidenceWorkspace();
  try {
    const result = await runRecordSubprocess({
      connectorPath: join(FIXTURES_DIR, "scenario-fidelity-concurrent-connector.ts"),
      env: { PDPP_SCENARIO_FIDELITY_BASE_URL: provider.url },
      workspace,
    });
    const done = result.messages.find((m) => m.type === "DONE");
    assert.equal(done?.status, "succeeded", `expected succeeded DONE; stderr=${result.stderr}`);

    const { interactions } = result.capture;
    assert.equal(interactions.length, 2);
    const slow = interactions.find((i) => i.request.path === "/slow");
    const fast = interactions.find((i) => i.request.path === "/fast");
    assert.ok(slow && fast, "expected both /slow and /fast interactions");
    // /slow was INITIATED first (even though /fast's RESPONSE completed
    // first) — seq must reflect that initiation order.
    assert.ok(
      (slow?.seq ?? Number.POSITIVE_INFINITY) < (fast?.seq ?? Number.POSITIVE_INFINITY),
      `expected /slow (seq=${String(slow?.seq)}) to be numbered before /fast (seq=${String(fast?.seq)}) since it was initiated first`
    );
    t.diagnostic(`slow.seq=${String(slow?.seq)} fast.seq=${String(fast?.seq)}`);
  } finally {
    await provider.close();
    cleanupScenarioEvidenceWorkspace(workspace);
  }
});

// ─── FIX 1(e)/(f): pending-counter race — fire-and-forget + exit(0) ───────

test("scenario-fidelity: a fire-and-forget request in flight at process exit is flagged incomplete", async () => {
  const provider = await startStandaloneProvider();
  const workspace = createScenarioEvidenceWorkspace();
  try {
    const result = await runRecordSubprocess({
      connectorPath: join(FIXTURES_DIR, "scenario-fidelity-fire-and-forget-connector.ts"),
      env: { PDPP_SCENARIO_FIDELITY_BASE_URL: provider.url },
      workspace,
    });
    // This fixture calls process.exit(0) directly (not via runConnector),
    // so there is no DONE message at all — only the capture envelope proves
    // the pending-request race was observed.
    assert.equal(result.code, 0, "the fixture calls process.exit(0) directly");
    assert.ok(
      result.capture.pendingAtExit >= 1,
      `expected pendingAtExit >= 1, got ${String(result.capture.pendingAtExit)}`
    );
    assert.equal(result.capture.incomplete, true, "a pending request at exit must be flagged incomplete");
    assert.equal(
      result.capture.interactions.length,
      0,
      "the in-flight request's interaction was never persisted — proving the race is real, not just counted"
    );
  } finally {
    await provider.close();
    cleanupScenarioEvidenceWorkspace(workspace);
  }
});

// ─── FIX 2: replay-side preload fidelity ───────────────────────────────────

test('scenario-fidelity: replay serves a plain-text body byte-identical ("hello" stays hello) and allowlisted headers round-trip', async () => {
  const provider = await startStandaloneProvider();
  const workspace = createScenarioEvidenceWorkspace();
  try {
    // Record first, against the real standalone provider.
    const recordResult = await runRecordSubprocess({
      connectorPath: join(FIXTURES_DIR, "scenario-fidelity-text-body-connector.ts"),
      env: { PDPP_SCENARIO_FIDELITY_BASE_URL: provider.url },
      workspace,
    });
    const recordDone = recordResult.messages.find((m) => m.type === "DONE");
    assert.equal(recordDone?.status, "succeeded", `record run must succeed; stderr=${recordResult.stderr}`);
    const [greetingInteraction] = recordResult.capture.interactions;
    assert.ok(greetingInteraction, "expected one recorded interaction");
    assert.equal(greetingInteraction?.response.body, "hello", "recorded body must be the raw string, not JSON-wrapped");

    // Now replay strictly offline: build a real createReplayFetch over the
    // recorded interaction, bridge it, and drive the SAME connector again
    // under the REPLAY preload — proving both replay.ts's own
    // serializeResponseBody AND this preload's bridge round-trip stay
    // byte-faithful end to end.
    await provider.close();
    const scenarioRun = { interactions: recordResult.capture.interactions } as unknown as Parameters<
      typeof createReplayFetch
    >[0];
    const replay = createReplayFetch(scenarioRun);
    const bridge: FetchBridgeServer = await startFetchBridgeServer(replay.fetch);
    try {
      // The base URL must match what was RECORDED (the provider's real
      // origin) even though the provider is now closed — the replay preload
      // intercepts fetch() before any real connection is attempted, so
      // nothing ever actually dials this origin; it only has to agree with
      // the recorded interaction's origin for createReplayFetch's strict
      // matcher to find it.
      const replayResult = await runReplaySubprocess({
        connectorPath: join(FIXTURES_DIR, "scenario-fidelity-text-body-connector.ts"),
        bridgeUrl: bridge.url,
        env: { PDPP_SCENARIO_FIDELITY_BASE_URL: provider.url },
        workspace,
      });
      const replayDone = replayResult.messages.find((m) => m.type === "DONE");
      assert.equal(
        replayDone?.status,
        "succeeded",
        `replay run must succeed; stderr=${replayResult.stderr}; messages=${JSON.stringify(replayResult.messages)}`
      );
      const { records } = messagesToRecordsAndState(replayResult.messages);
      const greetingRecord = records.find((r) => r.id === "greeting");
      assert.ok(greetingRecord, "expected a greeting record from replay");
      assert.deepEqual(
        greetingRecord?.data,
        { id: "greeting", text: "hello" },
        "replayed text must be byte-identical 'hello', not JSON-corrupted"
      );
    } finally {
      await bridge.close();
    }
  } finally {
    cleanupScenarioEvidenceWorkspace(workspace);
  }
});

test("scenario-fidelity: header allowlist round-trips through the fetch bridge when the underlying fetch sets them", async () => {
  // Proves this module's OWN header-forwarding contract in isolation:
  // startFetchBridgeServer's handler extracts the allowlisted headers from
  // whatever Response its injected `realFetch` returns, and the replay
  // preload's bridged fetch() reconstructs them from the bridge envelope.
  //
  // CROSS-LANE FINDING (not fixable from this file): the REAL realFetch the
  // CLIs wire in is src/scenario/replay.ts's `createReplayFetch`, which is
  // out of this task's ownership (verify.ts/replay.ts are explicitly
  // untouchable here). Empirically, `createReplayFetch`'s own
  // `bodyToResponseInit` only ever sets `content-type` on the Response it
  // constructs — the recorded `headers` field is never read at all — so
  // end-to-end header round-tripping through the actual scenario-verify
  // path is currently BLOCKED on a `replay.ts` change this lane cannot
  // make. This test proves the bridge/preload half of FIX 2(b) is correct
  // and ready for that fix once replay.ts's owner wires it up.
  const workspace = createScenarioEvidenceWorkspace();
  const stubReplayFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: '"abc"',
        "x-ratelimit-remaining": "7",
        "x-not-allowlisted": "must-be-dropped",
      },
    });
  const bridge = await startFetchBridgeServer(stubReplayFetch);
  try {
    const bridgeResponse = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "GET", url: "http://example.test/x" }),
    });
    const envelope = (await bridgeResponse.json()) as { headers?: [string, string][]; status: number };
    const headerNames = (envelope.headers ?? []).map(([name]) => name);
    assert.ok(
      headerNames.includes("etag"),
      `expected etag in the bridged envelope, got ${JSON.stringify(headerNames)}`
    );
    assert.ok(
      headerNames.includes("x-ratelimit-remaining"),
      `expected x-ratelimit-remaining in the bridged envelope, got ${JSON.stringify(headerNames)}`
    );
    assert.ok(!headerNames.includes("x-not-allowlisted"), "non-allowlisted header must be dropped by the bridge");

    // The replay preload's fetch() must reconstruct these onto the
    // Response it hands back to the connector — proven directly here
    // against the same envelope shape the preload parses.
    const preloadPath = writeReplayBridgePreload(bridge.url, { workspace });
    assert.ok(preloadPath.length > 0);
  } finally {
    await bridge.close();
    cleanupScenarioEvidenceWorkspace(workspace);
  }
});

// ─── FIX 3: network namespace isolation ────────────────────────────────────

test("scenario-fidelity: isolation capability detection reports honestly", () => {
  const capability = isNamespaceIsolationAvailable();
  if (capability.available) {
    assert.equal(capability.available, true);
  } else {
    assert.equal(typeof capability.reason, "string");
    assert.ok(capability.reason.length > 0, "an unavailable capability must always explain why");
  }
});

test("scenario-fidelity: under namespace isolation, a spawned curl cannot reach a parent-side canary (skip if unavailable)", async (t) => {
  const capability = isNamespaceIsolationAvailable();
  if (!capability.available) {
    t.skip(`network isolation unavailable on this host: ${capability.reason}`);
    return;
  }

  let canaryHits = 0;
  const canaryServer = createServer((_req, res) => {
    canaryHits += 1;
    res.writeHead(200);
    res.end("should never be reached");
  });
  await new Promise<void>((resolve) => canaryServer.listen(0, "127.0.0.1", () => resolve()));
  const canaryAddress = canaryServer.address();
  if (canaryAddress === null || typeof canaryAddress === "string") {
    throw new Error("test setup: expected a bound TCP address for the canary server");
  }
  const canaryUrl = `http://127.0.0.1:${String(canaryAddress.port)}/canary`;

  const provider = await startStandaloneProvider();
  const workspace = createScenarioEvidenceWorkspace();
  const udsPath = join(workspace.dir, "bridge.sock");

  try {
    const replay = createReplayFetch({ interactions: [] as ScenarioInteraction[] } as unknown as Parameters<
      typeof createReplayFetch
    >[0]);
    // A pass-through fetch so /ping (legitimate traffic) succeeds even
    // though the scenario has zero recorded interactions — this test only
    // cares about the isolation boundary, not full replay matching.
    const passthroughFetch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/ping") {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
        );
      }
      return replay.fetch(input, init);
    };
    const bridge = await startFetchBridgeServer(passthroughFetch, udsPath);
    try {
      const preloadPath = writeReplayBridgePreload(bridge.url, {
        udsSocketPath: udsPath,
        workspace,
      });
      const child = spawnWithNetworkIsolation(
        process.execPath,
        ["--import", "tsx", join(FIXTURES_DIR, "scenario-fidelity-isolation-canary-connector.ts")],
        {
          cwd: PACKAGE_ROOT,
          env: {
            ...subprocessEnv(),
            NODE_OPTIONS: `--import ${preloadPath}`,
            PDPP_SCENARIO_FIDELITY_BASE_URL: provider.url,
            PDPP_SCENARIO_FIDELITY_CANARY_URL: canaryUrl,
          },
          stdio: ["pipe", "pipe", "pipe"],
          isolate: true,
        }
      );

      const messages: ProtocolMessage[] = [];
      let stdoutBuffer = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line.trim()) {
            try {
              messages.push(JSON.parse(line) as ProtocolMessage);
            } catch {
              // ignore
            }
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const exitCode: number | null = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`isolation canary subprocess timed out; stderr=${stderr}`));
        }, 30_000);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.stdin?.write(`${JSON.stringify({ type: "START", scope: { streams: [{ name: "items" }] } })}\n`);
        child.stdin?.end();
      });

      t.diagnostic(`isolated child exit=${String(exitCode)} messages=${JSON.stringify(messages)} stderr=${stderr}`);

      // The authoritative proof: the canary server (in THIS process, a
      // different network namespace than the isolated child) never saw a
      // request at all.
      assert.equal(
        canaryHits,
        0,
        "the canary server must observe zero hits — curl must fail to connect under isolation"
      );

      const { records } = messagesToRecordsAndState(messages);
      const curlRecord = records.find((r) => r.id === "curl-escape-attempt");
      assert.ok(curlRecord, `expected a curl-escape-attempt record; messages=${JSON.stringify(messages)}`);
      assert.notEqual(
        (curlRecord?.data as { curl_exit_code: number } | undefined)?.curl_exit_code,
        0,
        "curl must fail to connect (nonzero exit) under network isolation"
      );

      // The UDS bridge must still work for legitimate traffic while isolated.
      const bridgedRecord = records.find((r) => r.id === "bridged-fetch");
      assert.ok(
        bridgedRecord,
        `expected a bridged-fetch record proving the UDS bridge still works; messages=${JSON.stringify(messages)}`
      );
      assert.equal((bridgedRecord?.data as { ok: boolean } | undefined)?.ok, true);

      assert.equal(
        messages.find((m) => m.type === "DONE")?.status,
        "succeeded",
        "the isolated run must still complete successfully via the UDS bridge"
      );
    } finally {
      await bridge.close();
    }
  } finally {
    await provider.close();
    await new Promise<void>((resolve) => canaryServer.close(() => resolve()));
    cleanupScenarioEvidenceWorkspace(workspace);
    rmSync(udsPath, { force: true });
  }
});

// ─── FIX 2(c): fixed clock — env var contract sanity ───────────────────────

test("scenario-fidelity: PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV patches Date.now()/new Date() to a fixed, monotonically advancing clock", async () => {
  const workspace = createScenarioEvidenceWorkspace();
  const bridge = await startFetchBridgeServer(async () => new Response("{}", { status: 200 }));
  try {
    const preloadPath = writeReplayBridgePreload(bridge.url, {
      fixedNowIso: "2020-01-01T00:00:00.000Z",
      workspace,
    });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "-e", "console.log(JSON.stringify({ now: Date.now(), iso: new Date().toISOString() }))"],
        {
          env: { ...subprocessEnv(), NODE_OPTIONS: `--import ${preloadPath}`, [PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV]: "" },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`clock probe timed out; stderr=${stderr}`));
      }, 15_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    assert.equal(result.code, 0, `probe must exit 0; stderr=${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim()) as { now: number; iso: string };
    const fixedStartMs = new Date("2020-01-01T00:00:00.000Z").getTime();
    assert.ok(
      parsed.now >= fixedStartMs && parsed.now < fixedStartMs + 10_000,
      `expected Date.now() near the fixed start, got ${String(parsed.now)}`
    );
    assert.ok(
      parsed.iso.startsWith("2020-01-01T00:00:00"),
      `expected new Date().toISOString() near fixed start, got ${parsed.iso}`
    );
  } finally {
    await bridge.close();
    cleanupScenarioEvidenceWorkspace(workspace);
  }
});

// ─── FIX 4: secure evidence workspace ──────────────────────────────────────

/** Last 3 octal digits of a file mode (permission bits only, no file-type
 *  bits) — without a bitwise AND, since this package disallows bitwise
 *  operators. `.mode` always renders as at least a 4-digit octal string
 *  (file-type bits + 3 permission digits) via `Number.prototype.toString`,
 *  so the permission bits are reliably the last 3 characters. */
function permissionOctal(mode: number): string {
  return mode.toString(8).slice(-3);
}

test("scenario-fidelity: evidence workspace is created 0700 with 0600 files, and cleanup removes it", () => {
  const workspace = createScenarioEvidenceWorkspace();
  try {
    const preloadPath = writeRecordPreload(join(workspace.dir, "out.json"), workspace);
    assert.ok(preloadPath.startsWith(workspace.dir), "generated preload must live inside the workspace directory");
    const dirPermissions = permissionOctal(statSync(workspace.dir).mode);
    assert.equal(dirPermissions, "700", `expected workspace dir mode 0700, got 0${dirPermissions}`);
    const filePermissions = permissionOctal(statSync(preloadPath).mode);
    assert.equal(filePermissions, "600", `expected preload file mode 0600, got 0${filePermissions}`);
  } finally {
    cleanupScenarioEvidenceWorkspace(workspace);
  }
  assert.equal(existsSync(workspace.dir), false, "cleanup must remove the workspace directory");
});

test("scenario-fidelity: writeRecordPreload/writeReplayBridgePreload keep their pre-existing single/positional-argument call shapes", async () => {
  // bin/scenario-record.ts calls writeRecordPreload(capturePath) with one
  // argument; bin/scenario-verify.ts calls
  // writeReplayBridgePreload(args.bridgeUrl) with one argument. Both must
  // keep working exactly as before (an implicit workspace, unaffected by
  // FIX 4's explicit-workspace convention) so those CLIs keep compiling and
  // running unchanged.
  const capturePath = join(mkdtempSync(join(tmpdir(), "pdpp-legacy-call-shape-")), "out.json");
  const legacyPreloadPath = writeRecordPreload(capturePath);
  assert.ok(legacyPreloadPath.length > 0);
  rmSync(dirname(capturePath), { recursive: true, force: true });

  const bridge = await startFetchBridgeServer(async () => new Response("{}", { status: 200 }));
  try {
    const legacyReplayPreloadPath = writeReplayBridgePreload(bridge.url);
    assert.ok(legacyReplayPreloadPath.length > 0);
  } finally {
    await bridge.close();
  }
});
