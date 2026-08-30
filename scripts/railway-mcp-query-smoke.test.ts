// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Offline unit tests for railway-mcp-query-smoke.ts.
//
// These run with zero dependencies and no network/Docker (node --test), exactly
// like check-railway-deploy-env.test.ts. They prove the seed-corpus shape, the
// MCP JSON-RPC framing, the dual-transport response parser, the seeded-record
// assertion, the anonymous-refusal classifier, and the owner-session form
// parsing — the logic that decides pass/fail in the live run — without standing
// up a stack. The live HTTP driver itself is exercised by the operator against a
// real composed origin (see deploy/railway/README.md), not in CI.
//
// The "disposable-env:" / "seedDisposableEnv:" tests further down stub
// globalThis.fetch with a tiny in-memory fake server to prove the
// production-mutation-isolation safety properties end-to-end offline: the
// pre-seed fingerprint gate refuses a pre-existing connection, cleanup runs on
// every failure point (not just success), cleanup is exact and idempotent, and
// a cleanup failure or residual record makes the run non-green with the exact
// key named. See that section's own header comment for the full rationale.

import assert from "node:assert/strict";
import test from "node:test";

import { extractCsrfFieldValue, findSetCookiePair } from "./lib/owner-session.ts";
import {
  assertSeedRecordsPresent,
  buildSeedNdjson,
  classifyAnonymousMcpStatus,
  cleanupSeedRecords,
  extractRecordsFromQueryResult,
  mcpInitializeMessage,
  mcpQueryRecordsMessage,
  mcpToolsListMessage,
  parseArgs,
  parseMcpResponseText,
  pkceChallenge,
  runLiveSmoke,
  SEED_CONNECTOR_ID,
  SEED_RECORDS,
  SEED_STREAM,
  seedDisposableEnv,
} from "./railway-mcp-query-smoke.ts";

const DETERMINISTIC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const MISSING_REASON_PATTERN = /missing/;
const MCP_ERROR_REASON_PATTERN = /MCP error/;

test("seed corpus: keys and data.id agree (ingestRecord identity rule)", () => {
  assert.ok(SEED_RECORDS.length >= 1);
  for (const record of SEED_RECORDS) {
    assert.equal(typeof record.key, "string");
    assert.equal(record.data.id, record.key, "data.id must equal key or ingest rejects it");
    assert.match(record.emitted_at, DETERMINISTIC_ISO_PATTERN, "deterministic ISO emitted_at");
  }
});

test("buildSeedNdjson: one JSON record per line, round-trips", () => {
  const ndjson = buildSeedNdjson();
  const lines = ndjson.split("\n");
  assert.equal(lines.length, SEED_RECORDS.length);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(parsed, SEED_RECORDS);
  // No trailing newline so the operation's non-empty-line filter sees exactly N.
  assert.ok(!ndjson.endsWith("\n"));
});

test("buildSeedNdjson: deterministic across calls (byte-identical)", () => {
  assert.equal(buildSeedNdjson(), buildSeedNdjson());
});

test("findSetCookiePair: extracts the named pair, ignores attributes/others", () => {
  const headers = [
    "pdpp_owner_csrf=abc123; Path=/; HttpOnly; SameSite=Lax",
    "pdpp_owner_session=sess999; Path=/; Secure; HttpOnly",
  ];
  assert.equal(findSetCookiePair(headers, "pdpp_owner_csrf"), "pdpp_owner_csrf=abc123");
  assert.equal(findSetCookiePair(headers, "pdpp_owner_session"), "pdpp_owner_session=sess999");
  assert.equal(findSetCookiePair(headers, "missing"), null);
});

test("extractCsrfFieldValue: reads the hidden _csrf input", () => {
  const html = '<form><input type="hidden" name="_csrf" value="tok-42" /><input name="password"></form>';
  assert.equal(extractCsrfFieldValue(html), "tok-42");
  assert.equal(extractCsrfFieldValue("<form>no csrf here</form>"), null);
});

test("mcp framing: initialize/tools.list/query_records are well-formed JSON-RPC", () => {
  const init = mcpInitializeMessage(7);
  assert.equal(init.jsonrpc, "2.0");
  assert.equal(init.id, 7);
  assert.equal(init.method, "initialize");

  const list = mcpToolsListMessage(8);
  assert.equal(list.method, "tools/list");

  const query = mcpQueryRecordsMessage(SEED_STREAM, { sort: "-emitted_at", limit: 10 }, 9);
  assert.equal(query.method, "tools/call");
  assert.equal(query.params.name, "query_records");
  const queryArguments = query.params.arguments as { limit: number; sort: string; stream: string };
  assert.equal(queryArguments.stream, SEED_STREAM);
  assert.equal(queryArguments.sort, "-emitted_at");
  assert.equal(queryArguments.limit, 10);
});

test("parseMcpResponseText: handles application/json", () => {
  const rpc = parseMcpResponseText("application/json", '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
  assert.equal((rpc?.result as { ok?: boolean } | undefined)?.ok, true);
});

test("parseMcpResponseText: handles SSE text/event-stream framing", () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  const rpc = parseMcpResponseText("text/event-stream", sse);
  assert.equal((rpc?.result as { ok?: boolean } | undefined)?.ok, true);
});

test("parseMcpResponseText: empty body yields null", () => {
  assert.equal(parseMcpResponseText("application/json", ""), null);
});

test("extractRecordsFromQueryResult: bare array, {data}, {records}, and empty", () => {
  const asArray = { result: { structuredContent: { data: [{ key: "a" }] } } };
  assert.deepEqual(extractRecordsFromQueryResult(asArray), [{ key: "a" }]);

  const asData = { result: { structuredContent: { data: { data: [{ key: "b" }] } } } };
  assert.deepEqual(extractRecordsFromQueryResult(asData), [{ key: "b" }]);

  const asRecords = { result: { structuredContent: { data: { records: [{ key: "c" }] } } } };
  assert.deepEqual(extractRecordsFromQueryResult(asRecords), [{ key: "c" }]);

  assert.deepEqual(extractRecordsFromQueryResult({ result: {} }), []);
});

test("assertSeedRecordsPresent: passes when all seeded keys are returned", () => {
  const rpc = {
    result: {
      structuredContent: {
        data: { data: SEED_RECORDS.map((r) => ({ key: r.key, data: r.data })) },
      },
    },
  };
  const verdict = assertSeedRecordsPresent(rpc);
  assert.equal(verdict.ok, true);
  assert.deepEqual(
    verdict.foundKeys,
    SEED_RECORDS.map((r) => r.key)
  );
});

test("assertSeedRecordsPresent: matches on data.id when key is absent", () => {
  const rpc = {
    result: { structuredContent: { data: SEED_RECORDS.map((r) => ({ data: r.data })) } },
  };
  assert.equal(assertSeedRecordsPresent(rpc).ok, true);
});

test("assertSeedRecordsPresent: fails when a seeded key is missing", () => {
  const rpc = { result: { structuredContent: { data: [{ key: SEED_RECORDS[0]?.key }] } } };
  const verdict = assertSeedRecordsPresent(rpc);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", MISSING_REASON_PATTERN);
});

test("assertSeedRecordsPresent: fails on an MCP tool error", () => {
  const rpc = { result: { isError: true, content: [{ type: "text", text: "nope" }] } };
  const verdict = assertSeedRecordsPresent(rpc);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", MCP_ERROR_REASON_PATTERN);
});

test("classifyAnonymousMcpStatus: 401/403 refuse, 2xx is a hard failure", () => {
  assert.deepEqual(classifyAnonymousMcpStatus(401), { refused: true, code: "unauthorized" });
  assert.deepEqual(classifyAnonymousMcpStatus(403), { refused: true, code: "forbidden" });
  assert.equal(classifyAnonymousMcpStatus(200).refused, false);
  assert.equal(classifyAnonymousMcpStatus(204).refused, false);
  assert.equal(classifyAnonymousMcpStatus(500).refused, true);
});

test("pkceChallenge: deterministic base64url S256 of the verifier", () => {
  // RFC 7636 Appendix B reference vector.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("parseArgs: parses origin, owner-password, subject, json, help", () => {
  const parsed = parseArgs([
    "node",
    "script",
    "--origin",
    "https://x.up.railway.app",
    "--owner-password",
    "secret",
    "--subject",
    "owner_x",
    "--json",
  ]);
  assert.equal(parsed.origin, "https://x.up.railway.app");
  assert.equal(parsed.ownerPassword, "secret");
  assert.equal(parsed.subjectId, "owner_x");
  assert.equal(parsed.json, true);
  assert.equal(parseArgs(["node", "script", "--help"]).help, true);
});

test("parseArgs: --disposable-env sets disposableEnv; absent leaves it falsy", () => {
  assert.equal(parseArgs(["node", "script", "--origin", "x", "--disposable-env"]).disposableEnv, true);
  assert.equal(parseArgs(["node", "script", "--origin", "x"]).disposableEnv, undefined);
});

test("seed constants are wired to the spotify fixture connector", () => {
  assert.equal(SEED_CONNECTOR_ID, "https://registry.pdpp.dev/connectors/spotify");
  assert.equal(SEED_STREAM, "top_artists");
});

// ---------------------------------------------------------------------------
// Fail-before safety tests for the --disposable-env production-mutation
// isolation fix. These prove, against a fake in-memory origin (no network, no
// Docker, deterministic), the exact regression this fix closes: the smoke
// used to seed into whatever default connection already existed for the
// owner, with no pre-check and no guaranteed cleanup (see
// FULL-PROTOCOL-TRAIN-CUTOVER-R2-0829.md "Required follow-up"). Each test
// below stubs globalThis.fetch with a tiny fake server keyed on method+path,
// runs runLiveSmoke against it, and asserts the safety property. Every test
// restores the real fetch in a finally so a failure in one test cannot leak a
// stub into another.
// ---------------------------------------------------------------------------

const [SEED_RECORD_0, SEED_RECORD_1] = SEED_RECORDS;
assert.ok(SEED_RECORD_0 && SEED_RECORD_1, "SEED_RECORDS must have at least two entries for these tests");
const SEED_KEY_0 = SEED_RECORD_0.key;
const SEED_KEY_1 = SEED_RECORD_1.key;
const PRE_EXISTING_CONNECTION_REASON_PATTERN = /already has 1 connection.*cin_existing_default_account/s;
const ANONYMOUS_MCP_ALLOWED_REASON_PATTERN = /anonymous .mcp was NOT refused/;
const PARTIAL_INGEST_ACCEPT_REASON_PATTERN = /ingest accepted 1 of 2 records/;
const CLEANUP_DID_NOT_CONVERGE_KEY_0_PATTERN = new RegExp(`cleanup did not converge.*${SEED_KEY_0}`, "s");
const CLEANUP_DID_NOT_CONVERGE_RESIDUAL_KEY_1_PATTERN = new RegExp(
  `cleanup did not converge.*residual keys.*${SEED_KEY_1}`,
  "s"
);

const OWNER_TOKEN = "owner-test-token";
const CLIENT_TOKEN = "client-test-token";
const CODE_VERIFIER_ECHO = "test-code";

function sortStrings(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

interface FakeServerOptions {
  connectionsListStatus?: number;
  deleteStatusByKey?: Record<string, number>;
  existingConnections?: { connection_id: string }[];
  ingestRecordsAccepted?: number;
  ingestStatus?: number;
  residualKeysAfterDelete?: string[];
}

interface FakeServerState {
  deleteCalls: string[];
  ingestCalls: number;
  manifestRegisterCalls: number;
}

function fakeServerFetch(opts: FakeServerOptions = {}): { fetchImpl: typeof fetch; state: FakeServerState } {
  const state: FakeServerState = { deleteCalls: [], ingestCalls: 0, manifestRegisterCalls: 0 };
  const existing = opts.existingConnections ?? [];
  const deletedKeys = new Set<string>();
  // Tracks which seed keys have actually been "ingested" so a partial-accept
  // scenario (ingestRecordsAccepted < SEED_RECORDS.length) is reflected
  // consistently in query_records: an un-ingested key never appears live, and
  // deleting it (cleanup's no-op-safe DELETE, matching the real RS route's
  // 204-regardless-of-count contract) must not un-delete a key that was never
  // there.
  let ingestedKeys = new Set<string>();

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // biome-ignore lint/suspicious/useAwait: must be async to satisfy `typeof fetch`'s Promise<Response> return type, even though every branch here is synchronous.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (method === "POST" && path === "/oauth/device_authorization") {
      return json(200, { device_code: "dc-1", user_code: "uc-1" });
    }
    if (method === "POST" && path === "/device/approve") {
      return json(200, {});
    }
    if (method === "POST" && path === "/oauth/token") {
      const body = String(init?.body ?? "");
      if (body.includes("device_code") || body.includes("urn:ietf:params:oauth:grant-type:device_code")) {
        return json(200, { access_token: OWNER_TOKEN });
      }
      return json(200, { access_token: CLIENT_TOKEN });
    }
    if (method === "GET" && path === "/v1/owner/connections") {
      return json(opts.connectionsListStatus ?? 200, { object: "list", data: existing });
    }
    if (method === "POST" && path === "/connectors") {
      state.manifestRegisterCalls += 1;
      return json(201, { ok: true });
    }
    if (method === "POST" && path.startsWith("/v1/ingest/")) {
      state.ingestCalls += 1;
      const accepted = opts.ingestRecordsAccepted ?? SEED_RECORDS.length;
      // A re-ingest (e.g. a second disposable-env run against the same
      // fixture) revives any previously tombstoned seed key, mirroring the
      // real ingest contract: POSTing a record makes it live again. A
      // partial accept only revives the first `accepted` keys (deterministic
      // ordering matches SEED_RECORDS), modeling the real ingest's
      // per-record accept/reject semantics.
      deletedKeys.clear();
      ingestedKeys = new Set(SEED_RECORDS.slice(0, accepted).map((r) => r.key));
      return json(opts.ingestStatus ?? 200, {
        records_accepted: accepted,
        records_rejected: SEED_RECORDS.length - accepted,
      });
    }
    if (method === "POST" && path === "/mcp") {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      if (!auth) {
        return new Response("unauthorized", { status: 401 });
      }
      const rpc = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
      if (rpc.method === "initialize") {
        return json(200, { jsonrpc: "2.0", id: rpc.id, result: {} });
      }
      if (rpc.method === "tools/list") {
        return json(200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "query_records" }] } });
      }
      // tools/call query_records
      const liveKeys = SEED_RECORDS.map((r) => r.key).filter(
        (key) => ingestedKeys.has(key) && (!deletedKeys.has(key) || (opts.residualKeysAfterDelete ?? []).includes(key))
      );
      return json(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { structuredContent: { data: liveKeys.map((key) => ({ key })) } },
      });
    }
    if (method === "POST" && path === "/oauth/register") {
      return json(201, { client_id: "client-1" });
    }
    if (method === "GET" && path === "/oauth/authorize") {
      return new Response(null, {
        status: 302,
        headers: { Location: `${url.origin}/consent?request_uri=req-1` },
      });
    }
    if (method === "GET" && path === "/consent") {
      return new Response('<form><input type="hidden" name="_csrf" value="csrf-1" /></form>', {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    if (method === "POST" && path === "/consent/review") {
      return json(200, {
        approval_review: {},
        approval_review_revision: "rev-1",
        request_uri: "req-1",
      });
    }
    if (method === "POST" && path === "/consent/approve") {
      return new Response(null, {
        status: 302,
        headers: { Location: `https://client.example/callback?code=${CODE_VERIFIER_ECHO}` },
      });
    }
    if (method === "DELETE" && path.startsWith(`/v1/streams/${SEED_STREAM}/records/`)) {
      const key = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
      state.deleteCalls.push(key);
      const status = opts.deleteStatusByKey?.[key] ?? 204;
      if (status === 204) {
        deletedKeys.add(key);
      }
      return new Response(null, { status });
    }
    throw new Error(`fakeServerFetch: unhandled ${method} ${path}`);
  }) as typeof fetch;

  return { fetchImpl, state };
}

async function withFakeFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("disposable-env: refuses to seed when the owner already has a pre-existing connection (fail-before)", async () => {
  const { fetchImpl, state } = fakeServerFetch({
    existingConnections: [{ connection_id: "cin_existing_default_account" }],
  });
  await assert.rejects(
    () =>
      withFakeFetch(fetchImpl, () =>
        runLiveSmoke({
          origin: "https://fake.test",
          ownerPassword: "",
          subjectId: "owner_local",
          disposableEnv: true,
        })
      ),
    PRE_EXISTING_CONNECTION_REASON_PATTERN
  );
  // The pre-existing-connection guard must abort BEFORE any mutation: no
  // manifest registration and no ingest call may occur.
  assert.equal(state.manifestRegisterCalls, 0, "must not register a manifest before the pre-seed guard runs");
  assert.equal(state.ingestCalls, 0, "must not ingest before the pre-seed guard runs");
});

test("disposable-env: a fresh owner (zero connections) is allowed to seed", async () => {
  const { fetchImpl, state } = fakeServerFetch({ existingConnections: [] });
  await withFakeFetch(fetchImpl, () =>
    runLiveSmoke({
      origin: "https://fake.test",
      ownerPassword: "",
      subjectId: "owner_local",
      disposableEnv: true,
    })
  );
  assert.equal(state.manifestRegisterCalls, 1);
  assert.equal(state.ingestCalls, 1);
  assert.deepEqual(sortStrings(state.deleteCalls), sortStrings(SEED_RECORDS.map((r) => r.key)));
});

test("disposable-env: cleanup runs even when a post-seed step throws (query_records failure)", async () => {
  const { fetchImpl, state } = fakeServerFetch({ existingConnections: [], ingestStatus: 200 });
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (
      init?.method?.toUpperCase() === "POST" &&
      url.pathname === "/mcp" &&
      String(init.body ?? "").includes("query_records") &&
      !state.deleteCalls.length
    ) {
      // Fail the FIRST scoped query_records call (before any cleanup delete
      // has happened) to simulate a post-seed assertion failure. Cleanup
      // must still run and tombstone every seeded key.
      return Promise.resolve(new Response("boom", { status: 500 }));
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
  try {
    await assert.rejects(() =>
      runLiveSmoke({
        origin: "https://fake.test",
        ownerPassword: "",
        subjectId: "owner_local",
        disposableEnv: true,
      })
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(
    sortStrings(state.deleteCalls),
    sortStrings(SEED_RECORDS.map((r) => r.key)),
    "cleanup must delete every seeded key even though the run failed"
  );
});

test("disposable-env: cleanup runs when anonymous-refusal assertion throws (before any client token exists)", async () => {
  const { fetchImpl, state } = fakeServerFetch({ existingConnections: [] });
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (
      method === "POST" &&
      url.pathname === "/mcp" &&
      !(init?.headers as Record<string, string> | undefined)?.Authorization
    ) {
      // Simulate a broken deploy that serves anonymous /mcp (2xx): the
      // assertion throws immediately, before mintClientToken ever runs.
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        runLiveSmoke({
          origin: "https://fake.test",
          ownerPassword: "",
          subjectId: "owner_local",
          disposableEnv: true,
        }),
      ANONYMOUS_MCP_ALLOWED_REASON_PATTERN
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(
    sortStrings(state.deleteCalls),
    sortStrings(SEED_RECORDS.map((r) => r.key)),
    "cleanup must run (minting its own client token) even when the failure happens before mintClientToken"
  );
});

test("disposable-env: cleanup is exact — deletes precisely the seeded keys, no others", async () => {
  const { fetchImpl, state } = fakeServerFetch({ existingConnections: [] });
  await withFakeFetch(fetchImpl, () =>
    runLiveSmoke({
      origin: "https://fake.test",
      ownerPassword: "",
      subjectId: "owner_local",
      disposableEnv: true,
    })
  );
  assert.deepEqual(sortStrings(state.deleteCalls), sortStrings(SEED_RECORDS.map((r) => r.key)));
  assert.equal(state.deleteCalls.length, SEED_RECORDS.length, "exactly one delete per seeded key, nothing extra");
});

test("disposable-env: cleanup runs even when seedRecords itself throws on a PARTIAL ingest accept (mutation already happened)", async () => {
  // The real ingest route can return HTTP 200 with records_accepted < the
  // full seed count (a partial accept) — seedRecords throws on that mismatch
  // (scripts/railway-mcp-query-smoke.ts). That throw happens AFTER a real
  // mutation (the accepted record actually landed), so cleanup must still
  // run and must not skip the never-accepted key either — the real RS delete
  // route returns 204 whether the deleted count was 0 or 1, so deleting an
  // unaccepted key is a safe no-op, not an error.
  const { fetchImpl, state } = fakeServerFetch({ existingConnections: [], ingestRecordsAccepted: 1 });
  await assert.rejects(
    () =>
      withFakeFetch(fetchImpl, () =>
        runLiveSmoke({
          origin: "https://fake.test",
          ownerPassword: "",
          subjectId: "owner_local",
          disposableEnv: true,
        })
      ),
    PARTIAL_INGEST_ACCEPT_REASON_PATTERN
  );
  assert.deepEqual(
    sortStrings(state.deleteCalls),
    sortStrings(SEED_RECORDS.map((r) => r.key)),
    "cleanup must attempt to delete every seeded key, including the one the partial ingest never accepted"
  );
});

test("disposable-env: cleanup is idempotent — calling cleanupSeedRecords twice on the same already-tombstoned keys converges both times", async () => {
  // The real RS delete route (reference-implementation/operations/
  // rs-records-delete/index.ts) returns 204 whether the deleted count was 0
  // or 1 — i.e. deleting an already-deleted key is a 204 no-op, not a 404.
  // fakeServerFetch's DELETE handler models this: it returns 204
  // unconditionally (unless deleteStatusByKey overrides a specific key), with
  // no notion of "already gone", exactly matching that contract. This test
  // calls cleanupSeedRecords directly TWICE on the same key set — the second
  // call is a real repeat-delete-of-already-tombstoned-key exercise, not just
  // two independent full runs (which wouldn't prove this specific property,
  // since a fresh seed revives the keys before each run's own cleanup).
  const { fetchImpl } = fakeServerFetch({ existingConnections: [] });
  await withFakeFetch(fetchImpl, async () => {
    const first = await cleanupSeedRecords("https://fake.test", OWNER_TOKEN, CLIENT_TOKEN, () => undefined);
    assert.equal(first.ok, true);
    assert.deepEqual(sortStrings(first.deletedKeys), sortStrings(SEED_RECORDS.map((r) => r.key)));
    const second = await cleanupSeedRecords("https://fake.test", OWNER_TOKEN, CLIENT_TOKEN, () => undefined);
    assert.equal(second.ok, true, "a repeat cleanup of the same already-tombstoned keys must still converge");
    assert.deepEqual(sortStrings(second.deletedKeys), sortStrings(SEED_RECORDS.map((r) => r.key)));
  });
});

test("disposable-env: a cleanup failure makes the run non-green and names the exact residual key(s)", async () => {
  const { fetchImpl, state } = fakeServerFetch({
    existingConnections: [],
    deleteStatusByKey: { [SEED_KEY_0]: 500 },
    residualKeysAfterDelete: [SEED_KEY_0],
  });
  await assert.rejects(
    () =>
      withFakeFetch(fetchImpl, () =>
        runLiveSmoke({
          origin: "https://fake.test",
          ownerPassword: "",
          subjectId: "owner_local",
          disposableEnv: true,
        })
      ),
    CLEANUP_DID_NOT_CONVERGE_KEY_0_PATTERN
  );
  assert.deepEqual(sortStrings(state.deleteCalls), sortStrings(SEED_RECORDS.map((r) => r.key)));
});

test("disposable-env: a record surviving tombstone delete (residue) is reported and fails the run", async () => {
  const { fetchImpl } = fakeServerFetch({
    existingConnections: [],
    // Every delete reports 204, but the verification re-query still returns
    // one key live (simulating a storage-layer inconsistency) — the run must
    // fail closed and name the exact residual key rather than trust the
    // delete status code alone.
    residualKeysAfterDelete: [SEED_KEY_1],
  });
  await assert.rejects(
    () =>
      withFakeFetch(fetchImpl, () =>
        runLiveSmoke({
          origin: "https://fake.test",
          ownerPassword: "",
          subjectId: "owner_local",
          disposableEnv: true,
        })
      ),
    CLEANUP_DID_NOT_CONVERGE_RESIDUAL_KEY_1_PATTERN
  );
});

// seedDisposableEnv is the seed-only entry point for a caller that IS itself
// a whole-environment disposable harness (e.g. railway-sqlite-restart-smoke.sh,
// which tears down its entire Docker Compose project + volume via its own
// `trap ... EXIT`). It shares the exact same fail-closed pre-existing-
// connection gate as runLiveSmoke's --disposable-env mode, but — unlike that
// mode — deliberately performs NO cleanup of its own: the caller's
// environment-level teardown IS the cleanup. These tests prove both halves:
// the gate still refuses a non-fresh owner, and a successful seed leaves the
// records live (no tombstone-delete call at all).
test("seedDisposableEnv: refuses to seed when the owner already has a pre-existing connection (fail-before)", async () => {
  const { fetchImpl, state } = fakeServerFetch({
    existingConnections: [{ connection_id: "cin_existing_default_account" }],
  });
  await assert.rejects(
    () =>
      withFakeFetch(fetchImpl, () =>
        seedDisposableEnv({
          origin: "https://fake.test",
          ownerPassword: "",
          subjectId: "owner_local",
        })
      ),
    PRE_EXISTING_CONNECTION_REASON_PATTERN
  );
  assert.equal(state.manifestRegisterCalls, 0, "must not register a manifest before the pre-seed guard runs");
  assert.equal(state.ingestCalls, 0, "must not ingest before the pre-seed guard runs");
});

test("seedDisposableEnv: seeds successfully and performs NO cleanup of its own (caller's environment teardown is the cleanup)", async () => {
  const { fetchImpl, state } = fakeServerFetch({ existingConnections: [] });
  await withFakeFetch(fetchImpl, () =>
    seedDisposableEnv({
      origin: "https://fake.test",
      ownerPassword: "",
      subjectId: "owner_local",
    })
  );
  assert.equal(state.manifestRegisterCalls, 1);
  assert.equal(state.ingestCalls, 1);
  assert.deepEqual(state.deleteCalls, [], "seedDisposableEnv must not delete/tombstone anything itself");
});
