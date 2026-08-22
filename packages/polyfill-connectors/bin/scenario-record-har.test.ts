// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proof for `bin/scenario-record.ts`'s `--record-har` flag (browser-driven
 * HAR + storageState capture) and its plumbing into
 * `src/browser-launch.ts`'s env-var contract (`HAR_RECORD_PATH_ENV`/
 * `STORAGE_STATE_RECORD_PATH_ENV`), driven as a REAL subprocess (mirrors
 * `bin/scenario-cli.test.ts`'s shape) but WITHOUT a real Chromium — see
 * `src/test-fixtures/scenario-record-har-stub-connector.ts`'s doc comment
 * for why: this suite's job is proving the RECORD CLI's own plumbing
 * (env-var threading, file finalization, redaction invocation, honest
 * driver stamping, crash honesty), not Playwright's `recordHar` itself
 * (which has no meaningful hermetic fixture — see
 * `src/browser-launch.test.ts` for the pure-unit coverage of the actual
 * redaction transform and flush-outcome check this file's fixture doesn't
 * exercise).
 *
 * No live network anywhere in this file: the stub connector's one `fetch`
 * call targets a loopback-only synthetic provider this test starts as its
 * own `node` process (same "node --test process isolation sandboxes loopback
 * from other processes" finding `bin/scenario-cli.test.ts`'s module doc
 * documents — reused here rather than re-derived).
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ConnectorScenario, ScenarioBrowserNetworkDriver } from "../src/scenario/format.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const RECORD_CLI_PATH = join(PACKAGE_ROOT, "bin", "scenario-record.ts");
const HAR_STUB_CONNECTOR_PATH = join(PACKAGE_ROOT, "src", "test-fixtures", "scenario-record-har-stub-connector.ts");

interface StubProvider {
  close: () => Promise<void>;
  url: string;
}

/** Minimal loopback GET /items provider — spawned as a standalone `node`
 *  process for the same reachability reason `bin/scenario-cli.test.ts`'s
 *  `startStubProvider` documents (a `node --test`-owned in-process listener
 *  is unreachable from the spawned CLI subprocess in this environment). */
function startStubProvider(): Promise<StubProvider> {
  const scriptPath = join(
    tmpdir(),
    `pdpp-scenario-record-har-test-provider-${String(process.pid)}-${String(Date.now())}.mjs`
  );
  const src = `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/items") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ items: [{ id: "item-1" }] }));
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
        reject(new Error(`stub provider exited before binding (code=${String(code)}): ${stderrBuffer}`));
      }
    });
  });
}

function runRecordCli(
  args: readonly string[],
  extraEnv: Record<string, string>
): { code: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", RECORD_CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function browserNetwork(scenario: ConnectorScenario, runIndex: number): ScenarioBrowserNetworkDriver {
  const network = scenario.runs[runIndex]?.environment?.network;
  assert.ok(
    network && network.driver === "recorded-browser",
    `run ${String(runIndex)} should declare recorded-browser`
  );
  return network as ScenarioBrowserNetworkDriver;
}

// ─── recording OFF by default ──────────────────────────────────────────────

test("scenario-record: without --record-har, no HAR/storageState files are produced and every run stays recorded-http", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-record-har-off-test-"));
  const scenarioPath = join(tmpDir, "no-har.scenario.json");
  const provider = await startStubProvider();
  try {
    const result = runRecordCli(
      ["har-stub", "--entrypoint", HAR_STUB_CONNECTOR_PATH, "--runs", "1", "--out", scenarioPath],
      { PDPP_SCENARIO_STUB_BASE_URL: provider.url }
    );
    assert.equal(result.code, 0, `expected success; stdout=${result.stdout} stderr=${result.stderr}`);
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as ConnectorScenario;
    assert.equal(scenario.runs.length, 1);
    assert.equal(scenario.runs[0]?.environment?.network?.driver, "recorded-http");
    assert.doesNotMatch(
      result.stdout,
      /browser HAR capture:/,
      "no HAR summary should print when --record-har is absent"
    );
    // No .har/.storage-state.json sibling files anywhere near the scenario.
    const dirEntries = readFileSync(scenarioPath, "utf8"); // sanity: scenario itself is readable
    assert.ok(dirEntries.length > 0);
    assert.ok(!existsSync(join(tmpDir, "no-har.scenario.run1.har")));
    assert.ok(!existsSync(join(tmpDir, "no-har.scenario.run1.storage-state.json")));
  } finally {
    await provider.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── recording ON produces a HAR + storageState at the requested path ─────

test("scenario-record --record-har: produces a redacted HAR and a storageState file next to the scenario, stamped recorded-browser", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-record-har-on-test-"));
  const scenarioPath = join(tmpDir, "with-har.scenario.json");
  const provider = await startStubProvider();
  try {
    const result = runRecordCli(
      ["har-stub", "--entrypoint", HAR_STUB_CONNECTOR_PATH, "--runs", "1", "--out", scenarioPath, "--record-har"],
      { PDPP_SCENARIO_STUB_BASE_URL: provider.url }
    );
    assert.equal(result.code, 0, `expected success; stdout=${result.stdout} stderr=${result.stderr}`);

    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as ConnectorScenario;
    const network = browserNetwork(scenario, 0);
    assert.equal(network.har_entry_count, 1);
    assert.match(network.har_path, /^with-har\.scenario\.run1\.har$/);
    assert.match(network.storage_state_path, /^with-har\.scenario\.run1\.storage-state\.json$/);

    const harFullPath = join(tmpDir, network.har_path);
    const storageStateFullPath = join(tmpDir, network.storage_state_path);
    assert.ok(existsSync(harFullPath), "HAR file should exist next to the scenario");
    assert.ok(existsSync(storageStateFullPath), "storageState file should exist next to the scenario");

    // clock.fixed_now (the capture instant) is stamped, ISO 8601 UTC.
    assert.match(scenario.runs[0]?.clock?.fixed_now ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // stdout reports where the HAR landed and what was/was not redacted.
    assert.match(result.stdout, /browser HAR capture:/);
    assert.match(result.stdout, /run 1: HAR=.*with-har\.scenario\.run1\.har/);
    assert.match(result.stdout, /redacted from the HAR:/);
    assert.match(result.stdout, /NOT redacted:/);

    // ── redaction actually removed the sensitive fields from the written file ──
    const har = JSON.parse(readFileSync(harFullPath, "utf8")) as {
      log: { entries: Array<{ request: Record<string, unknown>; response: Record<string, unknown> }> };
    };
    const [entry] = har.log.entries;
    assert.ok(entry, "HAR should contain the one recorded entry");
    const reqHeaders = entry.request.headers as Array<{ name: string; value: string }>;
    const resHeaders = entry.response.headers as Array<{ name: string; value: string }>;
    const cookieHeader = reqHeaders.find((h) => h.name.toLowerCase() === "cookie");
    const authHeader = reqHeaders.find((h) => h.name.toLowerCase() === "authorization");
    const setCookieHeader = resHeaders.find((h) => h.name.toLowerCase() === "set-cookie");
    assert.ok(
      cookieHeader && !cookieHeader.value.includes("super-secret-session-value"),
      "Cookie header value must be redacted"
    );
    assert.ok(
      authHeader && !authHeader.value.includes("super-secret-bearer-token"),
      "Authorization header value must be redacted"
    );
    assert.ok(
      setCookieHeader && !setCookieHeader.value.includes("super-secret-session-value"),
      "Set-Cookie header value must be redacted"
    );
    const reqCookies = entry.request.cookies as Array<{ name: string; value: string }>;
    const resCookies = entry.response.cookies as Array<{ name: string; value: string }>;
    assert.ok(
      !reqCookies.some((c) => c.value.includes("super-secret-session-value")),
      "request cookies[] must be redacted"
    );
    assert.ok(
      !resCookies.some((c) => c.value.includes("super-secret-session-value")),
      "response cookies[] must be redacted"
    );
    const postData = entry.request.postData as { params: Array<{ name: string; value: string }>; text: string };
    assert.ok(!postData.text.includes("hunter2"), "postData.text must be redacted for a credential-shaped form post");
    assert.ok(
      !postData.params.some((p) => p.value === "hunter2"),
      "postData.params must be redacted for a credential-shaped form post"
    );

    // ── residual exposure is honest: response BODY content is untouched ──
    const responseContent = (entry.response as { content: { text: string } }).content;
    assert.match(
      responseContent.text,
      /acct_12345/,
      "response body content must NOT be redacted (stated residual exposure)"
    );

    // ── storageState is deliberately UNREDACTED (it's the live session) ──
    const storageState = JSON.parse(readFileSync(storageStateFullPath, "utf8")) as {
      cookies: Array<{ value: string }>;
    };
    assert.equal(
      storageState.cookies[0]?.value,
      "super-secret-session-value",
      "storageState must remain usable for replay"
    );
  } finally {
    await provider.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── a context-close failure never claims a HAR was written ──────────────

test("scenario-record --record-har: a subprocess killed before it writes the HAR produces no scenario and no HAR/storageState files", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-record-har-crash-test-"));
  const scenarioPath = join(tmpDir, "crashed.scenario.json");
  try {
    // PDPP_TEST_HAR_STUB_SKIP_WRITE makes the fixture hang forever right
    // after PROGRESS, without ever writing the HAR/storageState — the same
    // "context.close() never ran" shape a real SIGKILL produces (see
    // browser-launch.ts's `HarRecordingOutcome` doc comment: Playwright only
    // flushes HAR content during context close, so a killed run leaves NO
    // file at all, never a truncated one). The CLI's own --timeout
    // inactivity watchdog is what kills it here.
    const result = runRecordCli(
      [
        "har-stub",
        "--entrypoint",
        HAR_STUB_CONNECTOR_PATH,
        "--runs",
        "1",
        "--out",
        scenarioPath,
        "--record-har",
        "--timeout",
        "2",
      ],
      { PDPP_TEST_HAR_STUB_SKIP_WRITE: "1" }
    );
    assert.notEqual(result.code, 0, "a killed run must exit nonzero");
    assert.match(result.stderr, /subprocess inactive for 2s - killed/, "the inactivity watchdog should have fired");
    assert.ok(!existsSync(scenarioPath), "no scenario file should be written when the watchdog kills the run");
    assert.ok(
      !existsSync(join(tmpDir, "crashed.scenario.run1.har")),
      "no HAR file should exist — the run never reached context.close()"
    );
    assert.ok(
      !existsSync(join(tmpDir, "crashed.scenario.run1.storage-state.json")),
      "no storageState file should exist — the run never reached context.close()"
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("scenario-record --record-har: a connector that never launches a browser (--record-har requested but nothing produced) stays recorded-http, not a false recorded-browser claim", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "scenario-record-har-fetch-only-test-"));
  const scenarioPath = join(tmpDir, "fetch-only.scenario.json");
  const provider = await startStubProvider();
  try {
    const result = runRecordCli(
      ["har-stub", "--entrypoint", HAR_STUB_CONNECTOR_PATH, "--runs", "1", "--out", scenarioPath, "--record-har"],
      { PDPP_SCENARIO_STUB_BASE_URL: provider.url, PDPP_TEST_HAR_STUB_NO_BROWSER: "1" }
    );
    assert.equal(result.code, 0, `expected success; stdout=${result.stdout} stderr=${result.stderr}`);
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as ConnectorScenario;
    assert.equal(
      scenario.runs[0]?.environment?.network?.driver,
      "recorded-http",
      "a run that requested --record-har but produced no usable HAR must not be stamped recorded-browser"
    );
    assert.doesNotMatch(
      result.stdout,
      /browser HAR capture:/,
      "no HAR summary should print when no run actually declares recorded-browser"
    );
    assert.ok(!existsSync(join(tmpDir, "fetch-only.scenario.run1.har")), "no HAR file should have been finalized");
  } finally {
    await provider.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
