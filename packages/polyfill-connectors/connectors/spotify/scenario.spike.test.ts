// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-verification scenario spike, proven end-to-end on the REAL
 * spotify connector code (connectors/spotify/index.ts), unmodified.
 *
 * This mirrors connectors/oura/scenario.spike.test.ts's architecture exactly:
 * spotify (unlike oura) DOES have an `isMainModule(import.meta.url)` guard
 * and exports its collect function (`spotifyCollect`), so an in-process
 * import + direct call would be possible in principle. This file
 * deliberately does NOT take that shortcut — the task specifies driving the
 * connector "the way oura's spike does": as a REAL child process (`node
 * --import tsx connectors/spotify/index.ts`) speaking the real Collection
 * Profile stdio protocol, with `globalThis.fetch` patched via a `NODE_OPTIONS
 * --import <preload>.mjs` module that loads BEFORE tsx registers spotify's
 * module. That keeps the proof end-to-end through the ACTUAL runtime
 * bootstrap (`isMainModule` true, `runConnector({...})` wired for real) not
 * just the pure collect function, and keeps this spike's harness identical in
 * shape to oura's so the two are directly comparable evidence.
 *
 * Two preload flavors (verbatim architecture from oura's spike):
 *   - RECORD phase: wraps a synthetic in-process spotify provider with the
 *     same redaction/capture behavior as `createRecordingFetch`, and (since
 *     the child is a different OS process from the test) writes the
 *     captured interactions to a JSON file the parent test process reads
 *     back after the child exits.
 *   - REPLAY phase (driven by `verifyScenario`'s `RunCollector`): forwards
 *     every outgoing request over a loopback HTTP bridge to the PARENT test
 *     process, whose handler is the REAL `args.fetch` — i.e. verify.ts's own
 *     `createReplayFetch(run, scenario.normalizers)` instance, the same one
 *     `assertAllConsumed()` tracks and `scenario.test.ts` unit-tests.
 *
 * SCOPE: this spike exercises `saved_tracks` and `recently_played` only —
 * the two incremental (cursor-bearing) streams, deliberately including
 * `recently_played` because its `after` param derivation
 * (`recentlyPlayedAfterCursor`, connectors/spotify/index.ts ~L132: subtracts
 * 1ms from the saved `last_played_at_unix` cursor) is the task's flagged
 * matching hazard. `playlists` (no cursor) and `top_artists` (three fixed
 * time-range windows, no pagination cursor either) would each add real
 * request volume without adding a new SHAPE of hazard already covered by the
 * two included streams, so they are left out of this spike's synthetic
 * provider (spotify's real `spotifyCollect` gates each stream strictly on
 * `requested.has(...)`, so the START message's `scope.streams` selects
 * exactly the two streams this spike synthesizes for).
 *
 * fixtures/spotify/scrubbed/pilot-real-shape does not exist in this repo
 * (confirmed absent by directory listing, same as oura's spike found for
 * oura). This file's synthetic provider data is instead hand-built in-test
 * to match spotify's REAL v1 API envelope and field shapes exactly — see the
 * SpotifySavedTrack / SpotifyPlayHistory / SpotifyTrack interfaces and
 * `collectSavedTracks` / `collectRecentlyPlayed` in connectors/spotify/index.ts,
 * cross-checked against savedTracksSchema / recentlyPlayedSchema in
 * connectors/spotify/schemas.ts field-for-field below.
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
const SPOTIFY_ENTRYPOINT = join(CONNECTORS_DIR, "index.ts");
const SPOTIFY_TOKEN = "spike-test-token-never-persisted";
const STREAMS = [{ name: "saved_tracks" }, { name: "recently_played" }];

// ─── Synthetic Spotify provider data ───────────────────────────────────
//
// Field-for-field matches to SpotifyTrack / SpotifySavedTrack /
// SpotifyPlayHistory in connectors/spotify/index.ts, and to
// savedTracksSchema / recentlyPlayedSchema in connectors/spotify/schemas.ts
// (base-62 ids, ISO-8601 datetimes, nullable optional fields).

interface SyntheticTrack {
  album: { name: string | null };
  artists: { id: string; name: string }[];
  duration_ms: number;
  external_ids: { isrc: string };
  id: string;
  name: string;
  popularity: number;
}

function track(id: string, name: string): SyntheticTrack {
  return {
    id,
    name,
    artists: [{ id: `artist${id}`, name: `Artist ${id}` }],
    album: { name: `Album ${id}` },
    duration_ms: 210_000,
    popularity: 55,
    external_ids: { isrc: "USRC17607839" },
  };
}

interface SyntheticSavedTrack {
  added_at: string;
  track: SyntheticTrack;
}

function savedTrackDoc(id: string, addedAt: string): SyntheticSavedTrack {
  return { added_at: addedAt, track: track(id, `Saved Track ${id}`) };
}

interface SyntheticPlayHistory {
  context: { type: string } | null;
  played_at: string;
  track: SyntheticTrack;
}

function playHistoryDoc(id: string, playedAt: string): SyntheticPlayHistory {
  return { played_at: playedAt, context: { type: "playlist" }, track: track(id, `Played Track ${id}`) };
}

// A base-62 Spotify-id-shaped string per SPOTIFY_ID_RE (`^[0-9A-Za-z]{1,40}$`).
function spotifyId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(6, "0")}`;
}

// run1 (full history, state:null): 2 pages per stream, 2 records/page = 4
// records/stream. run2 (incremental, state from run1): 1 new tail record per
// stream, fetched via the cursor (saved_tracks' `added_at` gate /
// recently_played's `after` derived from `last_played_at_unix`) — the
// synthetic provider serves exactly one page with one record and no `next`,
// proving the incremental narrowing actually narrows (not a second full walk).
//
// recently_played uses UNIX-MS timestamps (played_at ISO strings whose
// Date.parse() values are monotonic) so `recentlyPlayedAfterCursor`'s
// "subtract 1ms from the saved cursor" boundary has real millisecond
// resolution to exercise, matching index.ts's `after=<unix_ms>` construction.
const RUN1_SAVED_PAGE1 = [
  savedTrackDoc(spotifyId("st", 1), "2026-07-01T10:00:00Z"),
  savedTrackDoc(spotifyId("st", 2), "2026-07-02T10:00:00Z"),
];
const RUN1_SAVED_PAGE2 = [
  savedTrackDoc(spotifyId("st", 3), "2026-07-03T10:00:00Z"),
  savedTrackDoc(spotifyId("st", 4), "2026-07-04T10:00:00Z"),
];
const RUN2_SAVED_TAIL = [savedTrackDoc(spotifyId("st", 5), "2026-07-05T10:00:00Z")];

const RUN1_RECENT_PAGE1 = [
  playHistoryDoc(spotifyId("rp", 1), "2026-07-01T10:00:00.000Z"),
  playHistoryDoc(spotifyId("rp", 2), "2026-07-02T10:00:00.000Z"),
];
const RUN1_RECENT_PAGE2 = [
  playHistoryDoc(spotifyId("rp", 3), "2026-07-03T10:00:00.000Z"),
  playHistoryDoc(spotifyId("rp", 4), "2026-07-04T10:00:00.000Z"),
];
const RUN2_RECENT_TAIL = [playHistoryDoc(spotifyId("rp", 5), "2026-07-05T10:00:00.000Z")];

/**
 * The synthetic provider's routing table: for a given run + endpoint +
 * whether the request carries an `offset` (saved_tracks, playlists-style
 * offset pagination) or is the second page of recently_played (identified by
 * `before`, which Spotify's real API adds to `next` for cursor pagination),
 * which page to serve. Mirrors exactly what the real Spotify Web API would
 * do for these two collect() runs.
 *
 * saved_tracks pages via `offset` (offset=0 -> page1, offset=50 -> page2,
 * matching index.ts's `/me/tracks?limit=50` + `spotifyNextPath`-normalized
 * `next` link). recently_played pages via `before` (Spotify's own cursor
 * link relation for this endpoint) on page 2.
 */
function providerResponseFor(
  run: 1 | 2,
  pathname: string,
  params: URLSearchParams
): { items: unknown[]; next: string | null } {
  const isSavedTracks = pathname === "/v1/me/tracks";
  const isRecentlyPlayed = pathname === "/v1/me/player/recently-played";
  if (!(isSavedTracks || isRecentlyPlayed)) {
    throw new Error(`synthetic spotify provider: unknown path ${pathname}`);
  }

  if (run === 1) {
    if (isSavedTracks) {
      const offset = params.get("offset");
      if (!offset || offset === "0") {
        return { items: RUN1_SAVED_PAGE1, next: "https://api.spotify.com/v1/me/tracks?limit=50&offset=50" };
      }
      return { items: RUN1_SAVED_PAGE2, next: null };
    }
    // recently_played: page 1 has no `before`; page 2 is reached via `before`.
    if (!params.has("before")) {
      return {
        items: RUN1_RECENT_PAGE1,
        next: "https://api.spotify.com/v1/me/player/recently-played?limit=50&before=1751536800000",
      };
    }
    return { items: RUN1_RECENT_PAGE2, next: null };
  }

  // run 2: incremental — exactly one page, no further pagination.
  return { items: isSavedTracks ? RUN2_SAVED_TAIL : RUN2_RECENT_TAIL, next: null };
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

function runSpotifySubprocess(args: {
  nodeOptionsPreloadPath: string;
  startState: Record<string, unknown> | null;
}): Promise<{ code: number | null; messages: ProtocolMessage[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SPOTIFY_ENTRYPOINT], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${args.nodeOptionsPreloadPath}`,
        SPOTIFY_ACCESS_TOKEN: SPOTIFY_TOKEN,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: ProtocolMessage[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`spotify subprocess timed out; stderr=${stderr}`));
    }, 30_000);

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
      scope: { streams: STREAMS },
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
    `spotify-record-preload-${String(run)}-${String(process.pid)}-${String(Date.now())}.mjs`
  );
  const src = `
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const MAX_STORED_BODY_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_QUERY_PARAM_RE = /token|key|secret|signature|auth/i;
const interactions = [];
const normalizerNames = new Set();
let seq = 0;

${providerResponseFor.toString()}

const RUN1_SAVED_PAGE1 = ${JSON.stringify(RUN1_SAVED_PAGE1)};
const RUN1_SAVED_PAGE2 = ${JSON.stringify(RUN1_SAVED_PAGE2)};
const RUN2_SAVED_TAIL = ${JSON.stringify(RUN2_SAVED_TAIL)};
const RUN1_RECENT_PAGE1 = ${JSON.stringify(RUN1_RECENT_PAGE1)};
const RUN1_RECENT_PAGE2 = ${JSON.stringify(RUN1_RECENT_PAGE2)};
const RUN2_RECENT_TAIL = ${JSON.stringify(RUN2_RECENT_TAIL)};
const RUN = ${JSON.stringify(run)};

async function syntheticFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = providerResponseFor(RUN, url.pathname, url.searchParams);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const underlying = syntheticFetch;

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  const kept = [];
  for (const [name, value] of url.searchParams.entries()) {
    if (CREDENTIAL_QUERY_PARAM_RE.test(name)) {
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
 * status/content-type/body as JSON. Exists solely to let the spotify
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
 * under test here, not a reimplementation.
 */
function writeReplayBridgePreload(bridgeUrl: string): string {
  const preloadPath = join(tmpdir(), `spotify-replay-preload-${String(process.pid)}-${String(Date.now())}.mjs`);
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

// ─── The spike: RECORD then REPLAY, both against the real spotify connector ──

test("spotify connector-scenario spike: record two runs, build a scenario, verify it replays offline", async (t: TestContext) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "spotify-scenario-"));

  // ── RECORD run1 (full history, state:null) ──
  const run1CapturePath = join(tmpDir, "run1-capture.json");
  const run1Preload = writeRecordPreload(run1CapturePath, 1);
  const run1Result = await runSpotifySubprocess({ nodeOptionsPreloadPath: run1Preload, startState: null });
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
  const run2Result = await runSpotifySubprocess({ nodeOptionsPreloadPath: run2Preload, startState: run1FinalState });
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
  assert.equal(run1RecordsAndState.records.length, 8, "run1: 4 records x 2 streams (2 pages x 2 records/page)");
  assert.equal(run2RecordsAndState.records.length, 2, "run2: 1 tail record x 2 streams");
  assert.equal(run1Capture.interactions.length, 4, "run1: 2 pages x 2 streams");
  assert.equal(run2Capture.interactions.length, 2, "run2: 1 page x 2 streams (incremental narrowing)");

  // ── KILL-CRITERIA FINDING: the `after` cursor under record-then-replay ──
  //
  // recently_played's run2 request must carry `after=<last_played_at_unix - 1>`
  // (recentlyPlayedAfterCursor, index.ts ~L132). Both the RECORD phase (which
  // derives it from run1's ACTUAL emitted STATE cursor) and REPLAY (which
  // re-derives it the SAME way, from the SAME run1 state threaded through
  // verifyScenario/state_from_run) compute this from identical inputs via the
  // identical unmodified connector code path, so the two `after` values are
  // not just "close" but byte-identical by construction — proven below by
  // asserting the captured run2 recently_played interaction's `after` query
  // param against the value hand-derived from run1's committed cursor.
  const run1RecentCursor = run1FinalState.recently_played as { last_played_at_unix?: number } | undefined;
  assert.ok(
    typeof run1RecentCursor?.last_played_at_unix === "number",
    `run1 must commit a numeric recently_played cursor; got ${JSON.stringify(run1FinalState.recently_played)}`
  );
  const expectedAfter = String((run1RecentCursor as { last_played_at_unix: number }).last_played_at_unix - 1);
  const run2RecentInteraction = run2Capture.interactions.find(
    (i) => i.request.path === "/v1/me/player/recently-played"
  );
  assert.ok(run2RecentInteraction, "run2 must have recorded a recently_played interaction");
  const run2AfterParam = run2RecentInteraction?.request.query.find(([name]) => name === "after")?.[1];
  assert.equal(
    run2AfterParam,
    expectedAfter,
    `run2's captured 'after' query param must equal run1's committed cursor minus 1ms (recentlyPlayedAfterCursor's contract)`
  );
  t.diagnostic(
    `recently_played after cursor: run1 committed ${String(run1RecentCursor?.last_played_at_unix)}, run2 requested after=${String(run2AfterParam)}`
  );

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
        // (above) never reads/emits an `op` field at all, and the real
        // spotify connector never emits a delete/tombstone RECORD — every
        // projected record here is legitimately an upsert.
        ops: recs.map(() => "upsert" as const),
        record_sha256s: recs.map((r) => hashCanonicalJson(r.data)),
      };
    }
    return out;
  }

  const scenario: ConnectorScenario = {
    format: SCENARIO_FORMAT,
    connector: { id: "spotify" },
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
        start: { scope: { streams: STREAMS }, state: null },
        interactions: run1Capture.interactions,
        expected: { records: expectedFor(run1RecordsAndState.records), final_state: run1FinalState },
      },
      {
        start: { scope: { streams: STREAMS }, state: run1FinalState, state_from_run: 0 },
        interactions: run2Capture.interactions,
        expected: { records: expectedFor(run2RecordsAndState.records), final_state: run2FinalState },
      },
    ],
  };

  const scenarioPath = join(tmpDir, "spotify.scenario.json");
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
      const result = await runSpotifySubprocess({
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
  assert.equal(verifyResult.metrics.interactionCount, 6, "4 (run1) + 2 (run2) recorded interactions");

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
  const tamperedBody = tamperedInteraction.response.body as { items: Record<string, unknown>[] };
  const [firstItem] = tamperedBody.items;
  if (!firstItem) {
    throw new Error("test setup: expected at least one item in the tampered page");
  }
  const firstTrack = firstItem.track as Record<string, unknown> | undefined;
  if (!firstTrack) {
    throw new Error("test setup: expected the tampered item to carry a track object");
  }
  firstTrack.name = "TAMPERED TRACK NAME"; // was "Saved Track st000001" / "Played Track rp000001"
  const tamperedResult = await verifyScenario(tamperedScenario, runCollector);
  assert.equal(tamperedResult.pass, false, "a tampered response body must fail verification");
  assert.ok(
    tamperedResult.failures.some((f) => f.kind === "record_hash"),
    `expected a record_hash failure; got ${JSON.stringify(tamperedResult.failures)}`
  );

  // ── NEGATIVE CONTROL (b): remove one uniquely-keyed interaction → replay_mismatch ──
  //
  // Unlike oura's `next_token` param, spotify's pagination params in this
  // spike's two streams are `offset` (saved_tracks) and `before` (recently_played)
  // — neither matches the credential redaction regex
  // (/token|key|secret|signature|auth/i), so page-1 and page-2 requests for
  // the same stream keep DISTINCT match keys (different query strings) rather
  // than colliding into the same FIFO bucket as oura's `next_token` did.
  // Dropping any one recorded interaction therefore surfaces directly as the
  // matcher's "no recorded interaction matches" ScenarioMismatchError, not a
  // count/hash mismatch from a wrong-page substitution. This is a concrete,
  // connector-specific difference in how a dropped interaction fails —
  // reported as evidence, not smoothed over.
  const droppedScenario: ConnectorScenario = JSON.parse(JSON.stringify(scenario)) as ConnectorScenario;
  const [droppedRun] = droppedScenario.runs;
  if (!droppedRun) {
    throw new Error("test setup: expected run 0");
  }
  droppedRun.interactions = droppedRun.interactions.slice(1); // drop seq 1 (saved_tracks page 1)
  const droppedResult = await verifyScenario(droppedScenario, runCollector);
  assert.equal(
    droppedResult.pass,
    false,
    "a scenario missing an interaction the connector needs must fail verification"
  );
  assert.ok(
    droppedResult.failures.some((f) => f.kind === "replay_mismatch"),
    `expected a replay_mismatch failure; got ${JSON.stringify(droppedResult.failures)}`
  );

  // ── NEGATIVE CONTROL (c): drop run2's uniquely-keyed recently_played interaction ──
  //
  // run2's requests carry state-derived cursors (`added_at`-gated for
  // saved_tracks is server-side no-op here since the synthetic provider
  // always returns the tail page; `after` for recently_played, the flagged
  // hazard stream) and no further pagination, so each stream's run2
  // interaction has a unique match key with nothing else in its FIFO bucket.
  // Dropping recently_played's here demonstrates the matcher's
  // ScenarioMismatchError path directly on the `after`-cursor request that
  // is this connector's specific risk area.
  const droppedRun2Scenario: ConnectorScenario = JSON.parse(JSON.stringify(scenario)) as ConnectorScenario;
  const [, droppedRun2] = droppedRun2Scenario.runs;
  if (!droppedRun2) {
    throw new Error("test setup: expected run 1");
  }
  const dropIndex = droppedRun2.interactions.findIndex((i) => i.request.path === "/v1/me/player/recently-played");
  assert.notEqual(dropIndex, -1, "test setup: expected a run2 recently_played interaction to drop");
  droppedRun2.interactions = droppedRun2.interactions.filter((_, i) => i !== dropIndex);
  const droppedRun2Result = await verifyScenario(droppedRun2Scenario, runCollector);
  assert.equal(
    droppedRun2Result.pass,
    false,
    "dropping run2's uniquely-keyed recently_played interaction must fail verification"
  );
  assert.ok(
    droppedRun2Result.failures.some((f) => f.kind === "replay_mismatch"),
    `expected a replay_mismatch failure; got ${JSON.stringify(droppedRun2Result.failures)}`
  );
});
