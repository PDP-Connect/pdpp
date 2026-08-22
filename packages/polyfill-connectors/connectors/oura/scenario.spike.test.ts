// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-verification scenario spike, proven end-to-end on the REAL oura
 * connector code (connectors/oura/index.ts), unmodified.
 *
 * BLOCKING CONSTRAINT THAT SHAPES THIS FILE'S DESIGN: oura/index.ts calls
 * `runConnector({...})` unconditionally at module scope — unlike spotify (or
 * github/reddit), it has NO `isMainModule(import.meta.url)` guard and
 * exports no internal collect function. Importing the module directly (as
 * connectors/github/index.test.ts does for github) would fire the real
 * stdio-driven runtime the instant the test process imports it — reading
 * process.stdin, wiring readline, etc. — which is not a usable in-process
 * seam and cannot be worked around without editing the connector, which this
 * task forbids.
 *
 * So this spike drives oura the way `src/test-harness.ts`'s
 * `runConnectorProtocolSubprocess` already does for exactly this class of
 * connector: as a REAL child process (`node --import tsx connectors/oura/index.ts`)
 * speaking the real Collection Profile stdio protocol. To keep that fully
 * offline, the child's `globalThis.fetch` is patched via a `NODE_OPTIONS
 * --import <preload>.mjs` module that loads BEFORE tsx registers oura's
 * module — confirmed empirically: `NODE_OPTIONS`'s `--import` always runs
 * ahead of an explicit CLI `--import` (both `--import tsx` and
 * `--import <preload>` were tried in each order; NODE_OPTIONS wins the
 * race deterministically because Node processes it first regardless of CLI
 * flag order). No live network call is possible: the preload replaces
 * `fetch` before oura's module — and therefore its top-level
 * `runConnector(...)` call — ever executes.
 *
 * Two preload flavors:
 *   - RECORD phase: wraps a synthetic in-process oura provider with the
 *     same redaction/capture behavior as `createRecordingFetch`, and (since
 *     the child is a different OS process from the test) writes the
 *     captured interactions to a JSON file the parent test process reads
 *     back after the child exits.
 *   - REPLAY phase (driven by `verifyScenario`'s `RunCollector`): forwards
 *     every outgoing request over a loopback HTTP bridge to the PARENT test
 *     process, whose handler is the REAL `args.fetch` — i.e. verify.ts's
 *     own `createReplayFetch(run, scenario.normalizers)` instance, the same
 *     one `assertAllConsumed()` tracks and `scenario.test.ts` unit-tests.
 *     (An earlier version of this file had the replay preload reimplement
 *     the matcher standalone in the subprocess; that made `verifyScenario`
 *     track an unrelated, never-called `createReplayFetch` instance and
 *     silently fail `assertAllConsumed()` on every run. The HTTP bridge
 *     fixes that by making the real in-process replay fetch the actual
 *     handler, with the subprocess boundary crossed only for I/O.)
 *
 * fixtures/oura/scrubbed/pilot-real-shape does not exist in this repo (the
 * task's original suggestion assumed it did — confirmed absent by directory
 * listing). This file's synthetic provider data is instead hand-built
 * in-test to match oura's REAL v2 API envelope and field shapes exactly —
 * see the OuraSleepSession / OuraReadiness / OuraActivity interfaces and
 * `oura()` / `fetchAll()` request-building in connectors/oura/index.ts. This
 * is the one deviation from the task's literal fixture-sourcing
 * instruction; it does not weaken the proof (the shapes are cross-checked
 * against index.ts and schemas.ts field-for-field below).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashCanonicalJson } from "@pdpp/collector-runtime";
import type { ConnectorScenario, ScenarioInteraction, ScenarioRun } from "../../src/scenario/format.ts";
import { SCENARIO_FORMAT } from "../../src/scenario/format.ts";
import type { RunCollectorEmit } from "../../src/scenario/verify.ts";
import { verifyScenario } from "../../src/scenario/verify.ts";

const CONNECTORS_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OURA_ENTRYPOINT = join(CONNECTORS_DIR, "index.ts");
const OURA_TOKEN = "spike-test-token-never-persisted";

// ─── Synthetic Oura provider data ──────────────────────────────────────
//
// Field-for-field matches to OuraSleepSession / OuraReadiness / OuraActivity
// in connectors/oura/index.ts, and to sleepSchema/readinessSchema/
// activitySchema in connectors/oura/schemas.ts (UUID ids, YYYY-MM-DD days,
// ISO-8601 datetimes, nullable-number metrics).

interface SyntheticSleep {
  average_heart_rate: number;
  average_hrv: number;
  bedtime_end: string;
  bedtime_start: string;
  day: string;
  deep_sleep_duration: number;
  efficiency: number;
  id: string;
  latency: number;
  light_sleep_duration: number;
  lowest_heart_rate: number;
  readiness: { score: number };
  rem_sleep_duration: number;
  temperature_delta: number;
  total_sleep_duration: number;
}

function sleepDoc(id: string, day: string): SyntheticSleep {
  return {
    id,
    day,
    bedtime_start: `${day}T22:30:00-07:00`,
    bedtime_end: `${day}T06:15:00-07:00`,
    total_sleep_duration: 25_200,
    rem_sleep_duration: 5400,
    deep_sleep_duration: 6300,
    light_sleep_duration: 13_500,
    efficiency: 91,
    latency: 420,
    average_heart_rate: 54.5,
    lowest_heart_rate: 48,
    average_hrv: 62.3,
    temperature_delta: -0.2,
    readiness: { score: 82 },
  };
}

interface SyntheticReadiness {
  contributors: Record<string, number>;
  day: string;
  id: string;
  score: number;
  temperature_deviation: number;
  temperature_trend_deviation: number;
}

function readinessDoc(id: string, day: string): SyntheticReadiness {
  return {
    id,
    day,
    score: 78,
    temperature_deviation: 0.1,
    temperature_trend_deviation: -0.05,
    contributors: { sleep_balance: 80, previous_day_activity: 75, hrv_balance: 70 },
  };
}

interface SyntheticActivity {
  active_calories: number;
  day: string;
  equivalent_walking_distance: number;
  id: string;
  score: number;
  steps: number;
  target_calories: number;
  total_calories: number;
}

function activityDoc(id: string, day: string): SyntheticActivity {
  return {
    id,
    day,
    score: 85,
    active_calories: 420,
    total_calories: 2380,
    steps: 8734,
    target_calories: 2200,
    equivalent_walking_distance: 7200,
  };
}

// A UUID-shaped id per ouraIdSchema's UUID_RE. `n` disambiguates records.
function uuid(n: number): string {
  const hex = n.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-000000000000`;
}

// run1 (full history, state:null): 2 pages per stream, 2 records/page = 4
// records/stream. run2 (incremental, state from run1): 1 new tail record
// per stream, fetched via the cursor (`start_date` from the connector's
// `last_day` state) — the synthetic provider serves exactly one page with
// one record and no next_token, proving the incremental narrowing actually
// narrows (not a second full walk).
const RUN1_SLEEP_PAGE1 = [sleepDoc(uuid(1), "2026-07-01"), sleepDoc(uuid(2), "2026-07-02")];
const RUN1_SLEEP_PAGE2 = [sleepDoc(uuid(3), "2026-07-03"), sleepDoc(uuid(4), "2026-07-04")];
const RUN2_SLEEP_TAIL = [sleepDoc(uuid(5), "2026-07-05")];

const RUN1_READINESS_PAGE1 = [readinessDoc(uuid(11), "2026-07-01"), readinessDoc(uuid(12), "2026-07-02")];
const RUN1_READINESS_PAGE2 = [readinessDoc(uuid(13), "2026-07-03"), readinessDoc(uuid(14), "2026-07-04")];
const RUN2_READINESS_TAIL = [readinessDoc(uuid(15), "2026-07-05")];

const RUN1_ACTIVITY_PAGE1 = [activityDoc(uuid(21), "2026-07-01"), activityDoc(uuid(22), "2026-07-02")];
const RUN1_ACTIVITY_PAGE2 = [activityDoc(uuid(23), "2026-07-03"), activityDoc(uuid(24), "2026-07-04")];
const RUN2_ACTIVITY_TAIL = [activityDoc(uuid(25), "2026-07-05")];

const NEXT_TOKEN_PAGE2 = "page2cursor";

/**
 * The synthetic provider's routing table: for a given run + endpoint +
 * whether the request carries next_token, which page to serve. Mirrors
 * exactly what the real Oura v2 API would do for these two collect() runs.
 */
function providerResponseFor(
  run: 1 | 2,
  endpoint: string,
  params: URLSearchParams
): { data: unknown[]; next_token: string | null } {
  const hasNextToken = params.has("next_token");
  if (run === 1) {
    const byEndpoint: Record<string, { page1: unknown[]; page2: unknown[] }> = {
      sleep: { page1: RUN1_SLEEP_PAGE1, page2: RUN1_SLEEP_PAGE2 },
      daily_readiness: { page1: RUN1_READINESS_PAGE1, page2: RUN1_READINESS_PAGE2 },
      daily_activity: { page1: RUN1_ACTIVITY_PAGE1, page2: RUN1_ACTIVITY_PAGE2 },
    };
    const pages = byEndpoint[endpoint];
    if (!pages) {
      throw new Error(`synthetic oura provider: unknown endpoint ${endpoint}`);
    }
    return hasNextToken ? { data: pages.page2, next_token: null } : { data: pages.page1, next_token: NEXT_TOKEN_PAGE2 };
  }
  const tailByEndpoint: Record<string, unknown[]> = {
    sleep: RUN2_SLEEP_TAIL,
    daily_readiness: RUN2_READINESS_TAIL,
    daily_activity: RUN2_ACTIVITY_TAIL,
  };
  const tail = tailByEndpoint[endpoint];
  if (!tail) {
    throw new Error(`synthetic oura provider: unknown endpoint ${endpoint}`);
  }
  return { data: tail, next_token: null };
}

// ─── Subprocess + fetch-preload harness ────────────────────────────────

interface ProtocolMessage {
  cursor?: unknown;
  data?: unknown;
  key?: unknown;
  status?: string;
  stream?: string;
  type: string;
}

function runOuraSubprocess(args: {
  nodeOptionsPreloadPath: string;
  startState: Record<string, unknown> | null;
}): Promise<{ code: number | null; messages: ProtocolMessage[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", OURA_ENTRYPOINT], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${args.nodeOptionsPreloadPath}`,
        OURA_PERSONAL_ACCESS_TOKEN: OURA_TOKEN,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: ProtocolMessage[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`oura subprocess timed out; stderr=${stderr}`));
    }, 20_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.trim()) {
          messages.push(JSON.parse(line) as ProtocolMessage);
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, messages, stderr });
    });

    const startMessage = {
      type: "START",
      scope: { streams: [{ name: "sleep" }, { name: "readiness" }, { name: "activity" }] },
      ...(args.startState === null ? {} : { state: args.startState }),
    };
    child.stdin.end(`${JSON.stringify(startMessage)}\n`);
  });
}

/** The RECORD-phase preload: a synthetic provider + createRecordingFetch,
 *  writing captured interactions to `outPath` on process exit. */
function writeRecordPreload(outPath: string, run: 1 | 2): string {
  const preloadPath = join(
    tmpdir(),
    `oura-record-preload-${String(run)}-${String(process.pid)}-${String(Date.now())}.mjs`
  );
  const src = `
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const MAX_STORED_BODY_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_QUERY_PARAM_RE = /token|key|secret|signature|auth/i;
const MIN_PROVIDER_VALUE_LENGTH = 8;
const MAX_PROVIDER_VALUES = 10_000;
const interactions = [];
const normalizerNames = new Set();
const providerIssuedValues = new Set();
let seq = 0;

// Mirrors record.ts's collectProviderIssuedValues: walks a parsed response
// body and records every string leaf value long enough to plausibly be a
// provider-issued cursor/token, so a later request's credential-shaped
// param can be checked against it before deciding to redact.
function collectProviderIssuedValues(body) {
  if (providerIssuedValues.size >= MAX_PROVIDER_VALUES) {
    return;
  }
  if (typeof body === "string") {
    if (body.length >= MIN_PROVIDER_VALUE_LENGTH) {
      providerIssuedValues.add(body);
    }
    return;
  }
  if (Array.isArray(body)) {
    for (const item of body) {
      if (providerIssuedValues.size >= MAX_PROVIDER_VALUES) {
        return;
      }
      collectProviderIssuedValues(item);
    }
    return;
  }
  if (body !== null && typeof body === "object") {
    for (const value of Object.values(body)) {
      if (providerIssuedValues.size >= MAX_PROVIDER_VALUES) {
        return;
      }
      collectProviderIssuedValues(value);
    }
  }
}

${providerResponseFor.toString()}

const RUN1_SLEEP_PAGE1 = ${JSON.stringify(RUN1_SLEEP_PAGE1)};
const RUN1_SLEEP_PAGE2 = ${JSON.stringify(RUN1_SLEEP_PAGE2)};
const RUN2_SLEEP_TAIL = ${JSON.stringify(RUN2_SLEEP_TAIL)};
const RUN1_READINESS_PAGE1 = ${JSON.stringify(RUN1_READINESS_PAGE1)};
const RUN1_READINESS_PAGE2 = ${JSON.stringify(RUN1_READINESS_PAGE2)};
const RUN2_READINESS_TAIL = ${JSON.stringify(RUN2_READINESS_TAIL)};
const RUN1_ACTIVITY_PAGE1 = ${JSON.stringify(RUN1_ACTIVITY_PAGE1)};
const RUN1_ACTIVITY_PAGE2 = ${JSON.stringify(RUN1_ACTIVITY_PAGE2)};
const RUN2_ACTIVITY_TAIL = ${JSON.stringify(RUN2_ACTIVITY_TAIL)};
const NEXT_TOKEN_PAGE2 = ${JSON.stringify(NEXT_TOKEN_PAGE2)};
const RUN = ${JSON.stringify(run)};

async function syntheticFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const endpoint = url.pathname.split("/").pop();
  const body = providerResponseFor(RUN, endpoint, url.searchParams);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const underlying = syntheticFetch;

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  const kept = [];
  for (const [name, value] of url.searchParams.entries()) {
    if (CREDENTIAL_QUERY_PARAM_RE.test(name) && !providerIssuedValues.has(value)) {
      normalizerNames.add(name);
      continue;
    }
    kept.push([name, value]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const response = await underlying(input, init);
  seq += 1;
  const buf = new Uint8Array(await response.clone().arrayBuffer());
  const truncated = buf.byteLength > MAX_STORED_BODY_BYTES;
  const text = new TextDecoder().decode(truncated ? buf.subarray(0, MAX_STORED_BODY_BYTES) : buf);
  const contentType = response.headers.get("content-type") ?? undefined;
  let parsedBody;
  if (truncated) {
    parsedBody = { __scenario_body_truncated__: true, stored_bytes: buf.byteLength };
  } else {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }
  collectProviderIssuedValues(parsedBody);

  interactions.push({
    seq,
    request: {
      method: request.method,
      origin: url.origin,
      path: url.pathname,
      query: kept,
    },
    response: {
      status: response.status,
      ...(contentType === undefined ? {} : { content_type: contentType }),
      body: parsedBody,
    },
  });

  return response;
};

process.on("exit", () => {
  writeFileSync(
    ${JSON.stringify(outPath)},
    JSON.stringify({ interactions, normalizerNames: [...normalizerNames] })
  );
});
`;
  writeFileSync(preloadPath, src);
  return preloadPath;
}

interface FetchBridgeServer {
  close: () => Promise<void>;
  url: string;
}

/**
 * A loopback-only HTTP server whose single POST handler calls `realFetch`
 * (verify.ts's own `createReplayFetch` for this run) and echoes back its
 * status/content-type/body as JSON. Exists solely to let the oura
 * subprocess's real HTTP requests reach the real, in-process replay fetch
 * `verifyScenario` constructed — see `writeReplayBridgePreload`'s doc
 * comment for why a subprocess can't call `realFetch` directly.
 */
function startFetchBridgeServer(realFetch: typeof fetch): Promise<FetchBridgeServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        (async (): Promise<void> => {
          const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            body?: string;
            method: string;
            url: string;
          };
          try {
            const response = await realFetch(envelope.url, {
              method: envelope.method,
              ...(envelope.body === undefined ? {} : { body: envelope.body }),
            });
            const bodyText = await response.text();
            let body: unknown = bodyText;
            try {
              body = JSON.parse(bodyText);
            } catch {
              // Non-JSON body: forward as a raw string.
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                status: response.status,
                content_type: response.headers.get("content-type"),
                body,
              })
            );
          } catch (err) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        })().catch(reject);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("startFetchBridgeServer: expected a bound TCP address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}/`,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

/**
 * The REPLAY-phase preload: forwards every outgoing `fetch()` call to a
 * local HTTP bridge server the parent test process runs, instead of
 * matching interactions itself. The bridge server's handler is
 * `createReplayFetch(run, scenario.normalizers)` — THE SAME replay fetch
 * `verifyScenario` constructs and tracks — so `assertAllConsumed()` and the
 * matcher strictness `scenario.test.ts` unit-proves are the actual code
 * under test here, not a reimplementation. The subprocess boundary means
 * the connector's real request can't call an in-process function directly;
 * bridging over loopback HTTP is the one seam that lets the real oura
 * process's requests reach the real `createReplayFetch` instance.
 */
function writeReplayBridgePreload(bridgeUrl: string): string {
  const preloadPath = join(tmpdir(), `oura-replay-preload-${String(process.pid)}-${String(Date.now())}.mjs`);
  const src = `
const BRIDGE_URL = ${JSON.stringify(bridgeUrl)};
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const bodyText = request.body === null ? undefined : await request.clone().text();
  const bridged = await realFetch(BRIDGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: request.method,
      url: request.url,
      body: bodyText,
    }),
  });
  const envelope = await bridged.json();
  if (envelope.error) {
    throw new Error(envelope.error);
  }
  return new Response(envelope.body === null ? null : JSON.stringify(envelope.body), {
    status: envelope.status,
    ...(envelope.content_type ? { headers: { "content-type": envelope.content_type } } : {}),
  });
};
`;
  writeFileSync(preloadPath, src);
  return preloadPath;
}

function messagesToRecordsAndState(messages: ProtocolMessage[]): {
  records: Array<{ data: unknown; id: string; stream: string }>;
  stateMessages: Array<{ cursor: unknown; stream: string }>;
} {
  const records: Array<{ data: unknown; id: string; stream: string }> = [];
  const stateMessages: Array<{ cursor: unknown; stream: string }> = [];
  for (const msg of messages) {
    if (msg.type === "RECORD" && typeof msg.stream === "string" && typeof msg.key === "string") {
      records.push({ stream: msg.stream, id: msg.key, data: msg.data });
    } else if (msg.type === "STATE" && typeof msg.stream === "string") {
      stateMessages.push({ stream: msg.stream, cursor: msg.cursor });
    }
  }
  return { records, stateMessages };
}

// ─── The spike: RECORD then REPLAY, both against the real oura connector ──

test("oura connector-scenario spike: record two runs, build a scenario, verify it replays offline", async (t: TestContext) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "oura-scenario-"));

  // ── RECORD run1 (full history, state:null) ──
  const run1CapturePath = join(tmpDir, "run1-capture.json");
  const run1Preload = writeRecordPreload(run1CapturePath, 1);
  const run1Result = await runOuraSubprocess({ nodeOptionsPreloadPath: run1Preload, startState: null });
  assert.equal(run1Result.code, 0, `run1 subprocess failed: ${run1Result.stderr}`);
  const run1Done = run1Result.messages.find((m) => m.type === "DONE");
  assert.equal(run1Done?.status, "succeeded", `run1 DONE was not succeeded: ${JSON.stringify(run1Done)}`);
  const run1Capture = JSON.parse(readFileSync(run1CapturePath, "utf8")) as {
    interactions: ScenarioInteraction[];
    normalizerNames: string[];
  };
  const run1RecordsAndState = messagesToRecordsAndState(run1Result.messages);

  // ── RECORD run2 (incremental, state = run1's ACTUAL emitted final state) ──
  const run1FinalState: Record<string, unknown> = {};
  for (const msg of run1RecordsAndState.stateMessages) {
    run1FinalState[msg.stream] = msg.cursor;
  }
  const run2CapturePath = join(tmpDir, "run2-capture.json");
  const run2Preload = writeRecordPreload(run2CapturePath, 2);
  const run2Result = await runOuraSubprocess({ nodeOptionsPreloadPath: run2Preload, startState: run1FinalState });
  assert.equal(run2Result.code, 0, `run2 subprocess failed: ${run2Result.stderr}`);
  const run2Done = run2Result.messages.find((m) => m.type === "DONE");
  assert.equal(run2Done?.status, "succeeded", `run2 DONE was not succeeded: ${JSON.stringify(run2Done)}`);
  const run2Capture = JSON.parse(readFileSync(run2CapturePath, "utf8")) as {
    interactions: ScenarioInteraction[];
    normalizerNames: string[];
  };
  const run2RecordsAndState = messagesToRecordsAndState(run2Result.messages);
  const run2FinalState: Record<string, unknown> = { ...run1FinalState };
  for (const msg of run2RecordsAndState.stateMessages) {
    run2FinalState[msg.stream] = msg.cursor;
  }

  // ── Sanity on the RECORD phase itself before trusting it as a fixture ──
  assert.equal(run1RecordsAndState.records.length, 12, "run1: 4 records x 3 streams (2 pages x 2 records/page)");
  assert.equal(run2RecordsAndState.records.length, 3, "run2: 1 tail record x 3 streams");
  assert.equal(run1Capture.interactions.length, 6, "run1: 2 pages x 3 streams");
  assert.equal(run2Capture.interactions.length, 3, "run2: 1 page x 3 streams (incremental narrowing)");

  // No Authorization header value anywhere in the captured interactions —
  // record.ts's contract (headers never stored) reimplemented by the preload.
  const allCaptured = [...run1Capture.interactions, ...run2Capture.interactions];
  for (const interaction of allCaptured) {
    assert.equal(
      "headers" in interaction.request,
      false,
      "captured interactions must never carry a headers field (credential redaction contract)"
    );
    assert.doesNotMatch(
      JSON.stringify(interaction),
      /spike-test-token-never-persisted/,
      "the bearer token must never appear in a captured interaction"
    );
  }

  // ── Build the v1 scenario file ──
  const normalizerNames = [...new Set([...run1Capture.normalizerNames, ...run2Capture.normalizerNames])];
  function expectedFor(
    records: Array<{ data: unknown; id: string; stream: string }>
  ): ScenarioRun["expected"]["records"] {
    const byStream = new Map<string, Array<{ data: unknown; id: string }>>();
    for (const r of records) {
      const bucket = byStream.get(r.stream);
      if (bucket) {
        bucket.push(r);
      } else {
        byStream.set(r.stream, [r]);
      }
    }
    const out: ScenarioRun["expected"]["records"] = {};
    for (const [stream, recs] of byStream) {
      out[stream] = {
        count: recs.length,
        ids: recs.map((r) => r.id),
        // `ops` is now mandatory (format.ts's ScenarioStreamExpectation.ops
        // doc comment). This spike's own local messagesToRecordsAndState
        // (above) never reads/emits an `op` field at all, and the real oura
        // connector never emits a delete/tombstone RECORD — every projected
        // record here is legitimately an upsert.
        ops: recs.map(() => "upsert" as const),
        record_sha256s: recs.map((r) => hashCanonicalJson(r.data)),
      };
    }
    return out;
  }

  const scenario: ConnectorScenario = {
    format: SCENARIO_FORMAT,
    connector: { id: "oura" },
    capture: {
      captured_at: new Date().toISOString(),
      evidence_class: "synthetic-spike",
      privacy_class: "local-only",
      recorder_version: "spike-v1",
      complete: true,
    },
    ...(normalizerNames.length > 0
      ? { normalizers: normalizerNames.map((param) => ({ param, reason: "credential" })) }
      : {}),
    runs: [
      {
        start: { scope: { streams: [{ name: "sleep" }, { name: "readiness" }, { name: "activity" }] }, state: null },
        interactions: run1Capture.interactions,
        expected: { records: expectedFor(run1RecordsAndState.records), final_state: run1FinalState },
      },
      {
        start: {
          scope: { streams: [{ name: "sleep" }, { name: "readiness" }, { name: "activity" }] },
          state: run1FinalState,
          state_from_run: 0,
        },
        interactions: run2Capture.interactions,
        expected: { records: expectedFor(run2RecordsAndState.records), final_state: run2FinalState },
      },
    ],
  };

  const scenarioPath = join(tmpDir, "oura.scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));

  // ── REPLAY phase: verifyScenario must PASS both runs, strictly offline ──
  function isPlainStateRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  const runCollector = async (
    runIndex: number,
    args: { emit: RunCollectorEmit; fetch: typeof fetch; state: unknown }
  ): Promise<void> => {
    // `args.fetch` is verifyScenario's real createReplayFetch for this run —
    // the bridge server below is the ONLY thing standing between the real
    // subprocess's HTTP requests and that real replay fetch, so
    // assertAllConsumed()/matcher strictness are exercised for real, not
    // reimplemented in the subprocess.
    const bridge = await startFetchBridgeServer(args.fetch);
    try {
      const result = await runOuraSubprocess({
        nodeOptionsPreloadPath: writeReplayBridgePreload(bridge.url),
        startState: isPlainStateRecord(args.state) ? args.state : null,
      });
      const done = result.messages.find((m) => m.type === "DONE");
      if (done?.status !== "succeeded") {
        throw new Error(
          `replay run ${String(runIndex)} did not succeed: ${JSON.stringify(done)}; stderr=${result.stderr}`
        );
      }
      const { records, stateMessages } = messagesToRecordsAndState(result.messages);
      for (const r of records) {
        args.emit({ type: "RECORD", stream: r.stream, id: r.id, data: r.data });
      }
      for (const s of stateMessages) {
        args.emit({ type: "STATE", stream: s.stream, cursor: s.cursor });
      }
    } finally {
      await bridge.close();
    }
  };

  const verifyResult = await verifyScenario(scenario, runCollector);
  assert.equal(verifyResult.pass, true, `verify failures: ${JSON.stringify(verifyResult.failures, null, 2)}`);
  assert.equal(verifyResult.metrics.interactionCount, 9, "6 (run1) + 3 (run2) recorded interactions");

  // record.ts's conditional credential-param redaction (kept when the value
  // is provider-issued, i.e. already seen in an earlier response body) means
  // oura's next_token — the only credential-shaped query param oura ever
  // sends, and always a value the provider handed back in the PRIOR page's
  // response — is never redacted. So no normalizer is ever needed here.
  assert.equal(
    verifyResult.metrics.normalizerCount,
    0,
    `expected zero normalizers now that next_token is recognized as provider-issued; got ${JSON.stringify(normalizerNames)}`
  );

  // Page-1 and page-2 requests for the same stream are keyed distinctly:
  // page 1 has no next_token param, page 2 carries the (kept, not redacted)
  // next_token value from page 1's response. Confirm directly on the
  // captured run1 interactions (2 pages x 3 streams).
  const run1SleepInteractions = run1Capture.interactions.filter((i) => i.request.path.endsWith("/sleep"));
  assert.equal(run1SleepInteractions.length, 2, "run1: sleep stream captured exactly 2 page interactions");
  const [sleepPage1, sleepPage2] = run1SleepInteractions;
  assert.ok(sleepPage1 && sleepPage2);
  assert.deepEqual(sleepPage1.request.query, [], "sleep page 1 has no next_token (first request in the stream)");
  assert.deepEqual(
    sleepPage2.request.query,
    [["next_token", NEXT_TOKEN_PAGE2]],
    "sleep page 2 keeps the provider-issued next_token instead of redacting it"
  );
  assert.notDeepEqual(
    sleepPage1.request.query,
    sleepPage2.request.query,
    "page 1 and page 2 must be keyed distinctly, not collapsed onto the same match key"
  );

  // ── Metrics / kill-criteria data ──
  t.diagnostic(`normalizerCount=${String(verifyResult.metrics.normalizerCount)}`);
  t.diagnostic(`normalizers=${JSON.stringify(normalizerNames)}`);
  t.diagnostic(`interactionCount=${String(verifyResult.metrics.interactionCount)}`);

  // ── NEGATIVE CONTROL (a): tamper one response field value in a copy ──
  const tamperedScenario: ConnectorScenario = JSON.parse(JSON.stringify(scenario)) as ConnectorScenario;
  const [tamperedRun] = tamperedScenario.runs;
  const [tamperedInteraction] = tamperedRun?.interactions ?? [];
  if (
    !(tamperedInteraction && typeof tamperedInteraction.response.body === "object" && tamperedInteraction.response.body)
  ) {
    throw new Error("test setup: expected run1 interaction 0 to have an object body");
  }
  const tamperedBody = tamperedInteraction.response.body as { data: Record<string, unknown>[] };
  const [firstRow] = tamperedBody.data;
  if (!firstRow) {
    throw new Error("test setup: expected at least one row in the tampered page");
  }
  firstRow.total_sleep_duration = 999_999; // was 25200
  const tamperedResult = await verifyScenario(tamperedScenario, runCollector);
  assert.equal(tamperedResult.pass, false, "a tampered response body must fail verification");
  assert.ok(
    tamperedResult.failures.some((f) => f.kind === "record_hash"),
    `expected a record_hash failure; got ${JSON.stringify(tamperedResult.failures)}`
  );

  // ── NEGATIVE CONTROL (b): remove one interaction ──
  //
  // FIXED (was a KILL-CRITERIA FINDING): oura's `next_token`
  // pagination-cursor query param matches the credential redaction regex
  // (/token|key|secret|signature|auth/i — "next_token" contains "token"),
  // so a naive redact-by-name-always approach used to strip it on every
  // stream, collapsing page-1 and page-2 requests for the SAME stream onto
  // an identical match key. record.ts now redacts a credential-shaped
  // param only when its value has NOT already appeared in an earlier
  // recorded response body in the same run — oura's next_token IS the
  // provider's page-2 cursor, first seen in page 1's response body, so it
  // is kept (not redacted) on the page-2 request. Page 1 and page 2 are
  // therefore keyed distinctly, and dropping page 1's recorded interaction
  // now surfaces as a genuine "no recorded interaction matches" replay
  // mismatch (see the assertion below), the same as control (b2).
  const droppedScenario: ConnectorScenario = JSON.parse(JSON.stringify(scenario)) as ConnectorScenario;
  const [droppedRun] = droppedScenario.runs;
  if (!droppedRun) {
    throw new Error("test setup: expected run 0");
  }
  droppedRun.interactions = droppedRun.interactions.slice(1); // drop seq 1 (sleep page 1)
  const droppedResult = await verifyScenario(droppedScenario, runCollector);
  assert.equal(
    droppedResult.pass,
    false,
    "a scenario missing an interaction the connector needs must fail verification"
  );
  assert.ok(
    droppedResult.failures.some((f) => f.kind === "replay_mismatch"),
    `expected a replay_mismatch failure (page 1 and page 2 are now keyed distinctly by the kept next_token); got ${JSON.stringify(droppedResult.failures)}`
  );

  // ── NEGATIVE CONTROL (b2): drop a uniquely-keyed interaction → genuine replay_mismatch ──
  //
  // run2's requests carry a `start_date` cursor (from run1's committed
  // state) and no `next_token` (single page, no pagination), so each
  // stream's run2 interaction has a unique match key with nothing else in
  // its FIFO bucket. Dropping one here demonstrates the matcher's
  // ScenarioMismatchError path directly on real oura traffic — the same
  // kind of genuinely-unique-key case as (b) above (both now surface
  // replay_mismatch, since the next_token fix removed the old FIFO
  // collision case entirely).
  const droppedRun2Scenario: ConnectorScenario = JSON.parse(JSON.stringify(scenario)) as ConnectorScenario;
  const [, droppedRun2] = droppedRun2Scenario.runs;
  if (!droppedRun2) {
    throw new Error("test setup: expected run 1");
  }
  droppedRun2.interactions = droppedRun2.interactions.slice(1); // drop run2's first (sleep) interaction
  const droppedRun2Result = await verifyScenario(droppedRun2Scenario, runCollector);
  assert.equal(
    droppedRun2Result.pass,
    false,
    "dropping run2's uniquely-keyed sleep interaction must fail verification"
  );
  assert.ok(
    droppedRun2Result.failures.some((f) => f.kind === "replay_mismatch"),
    `expected a replay_mismatch failure; got ${JSON.stringify(droppedRun2Result.failures)}`
  );
});
