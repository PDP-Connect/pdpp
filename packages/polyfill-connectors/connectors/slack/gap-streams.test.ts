// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Direct-call tests for the four gap streams (stars/user_groups/reminders/
// dm_read_states) that collect via slack-api.ts rather than the slackdump
// archive. Calls the exported stream runners in-process (not via the
// subprocess harness) so `globalThis.fetch` mocking works, mirroring
// connectors/github/index.test.ts's pattern for the same reason.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, before, test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import {
  acquireSlackApiBrowserTransport,
  runDmReadStatesStream,
  runOptionalStream,
  runRemindersStream,
  runStarsStream,
  runUserGroupsStream,
  runUsersStream,
  type SlackApiIsolatedBrowser,
  type StreamDeps,
} from "./index.ts";
import { nodeFetchSlackApiTransport, resetSlackApiGovernor } from "./slack-api.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;

before(() => {
  globalThis.setTimeout = new Proxy(ORIGINAL_SET_TIMEOUT, {
    apply: (_target, _thisArg, callArgs: unknown[]) => {
      const [handler, , ...args] = callArgs as [TimerHandler, number?, ...unknown[]];
      if (typeof handler === "function") {
        queueMicrotask(() => (handler as (...a: unknown[]) => void)(...args));
      }
      const handle = ORIGINAL_SET_TIMEOUT(() => undefined, 0);
      clearTimeout(handle);
      return handle;
    },
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetSlackApiGovernor();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Captured {
  considered: Array<{ considered: number; stream: string }>;
  records: Array<{ data: unknown; stream: string }>;
}

function fakeDeps(db: DatabaseSync, captured: Captured, requested: readonly string[]): StreamDeps {
  return {
    db,
    emit: (msg) => {
      if (msg.type === "DETAIL_COVERAGE") {
        captured.considered.push({ stream: msg.stream, considered: msg.considered ?? 0 });
      }
      return Promise.resolve();
    },
    emitRecord: (stream, data) => {
      captured.records.push({ stream, data });
      return Promise.resolve();
    },
    emittedAt: "2026-07-10T00:00:00.000Z",
    fingerprintCursors: new Map(),
    progress: () => Promise.resolve(),
    requested: new Map(requested.map((name) => [name, { name }])),
  };
}

test("runStarsStream: emits one RECORD per starred item and declares considered", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        ok: true,
        items: [{ type: "message", channel: "C01", message: { ts: "1.1", user: "U01" } }],
      })
    );
  const db = new DatabaseSync(":memory:");
  const captured: Captured = { considered: [], records: [] };
  await runStarsStream(fakeDeps(db, captured, ["stars"]), nodeFetchSlackApiTransport, "xoxc-fake", "d-fake");
  assert.equal(captured.records.length, 1);
  assert.equal(captured.records[0]?.stream, "stars");
  assert.equal(captured.considered[0]?.considered, 1);
});

test("runStarsStream: zero stars still completes and declares considered=0", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: true, items: [] }));
  const db = new DatabaseSync(":memory:");
  const captured: Captured = { considered: [], records: [] };
  await runStarsStream(fakeDeps(db, captured, ["stars"]), nodeFetchSlackApiTransport, "xoxc-fake", "d-fake");
  assert.equal(captured.records.length, 0);
  assert.equal(captured.considered[0]?.considered, 0);
});

test("runUserGroupsStream: emits one RECORD per user group", async () => {
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse({ ok: true, usergroups: [{ id: "S01", handle: "eng", users: ["U01"] }] }));
  const db = new DatabaseSync(":memory:");
  const captured: Captured = { considered: [], records: [] };
  await runUserGroupsStream(fakeDeps(db, captured, ["user_groups"]), nodeFetchSlackApiTransport, "xoxc-fake", "d-fake");
  assert.equal(captured.records.length, 1);
  assert.equal(captured.records[0]?.stream, "user_groups");
});

test("runRemindersStream: emits one RECORD per reminder", async () => {
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse({ ok: true, reminders: [{ id: "Rm01", text: "ping bob", time: 1_714_032_900 }] }));
  const db = new DatabaseSync(":memory:");
  const captured: Captured = { considered: [], records: [] };
  await runRemindersStream(fakeDeps(db, captured, ["reminders"]), nodeFetchSlackApiTransport, "xoxc-fake", "d-fake");
  assert.equal(captured.records.length, 1);
  assert.equal(captured.records[0]?.stream, "reminders");
});

function seedChannel(db: DatabaseSync, id: string, data: Record<string, unknown>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS CHANNEL (
      ID TEXT NOT NULL,
      NAME TEXT,
      DATA TEXT,
      CHUNK_ID INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)").run(
    id,
    null,
    JSON.stringify(data),
    1
  );
}

test("runDmReadStatesStream: only calls conversations.info for is_im/is_mpim channels", async () => {
  const db = new DatabaseSync(":memory:");
  seedChannel(db, "D01", { is_im: true });
  seedChannel(db, "G01", { is_mpim: true });
  seedChannel(db, "C01", { is_channel: true });

  const seenChannels: string[] = [];
  globalThis.fetch = (url) => {
    const parsed = new URL(String(url));
    const channel = parsed.searchParams.get("channel") ?? "";
    seenChannels.push(channel);
    return Promise.resolve(
      jsonResponse({ ok: true, channel: { id: channel, last_read: "1.1", unread_count: 0, unread_count_display: 0 } })
    );
  };
  const captured: Captured = { considered: [], records: [] };
  await runDmReadStatesStream(
    fakeDeps(db, captured, ["dm_read_states"]),
    nodeFetchSlackApiTransport,
    "xoxc-fake",
    "d-fake"
  );

  assert.deepEqual([...seenChannels].sort(), ["D01", "G01"]);
  assert.equal(captured.records.length, 2);
  assert.ok(captured.records.every((r) => r.stream === "dm_read_states"));
});

test("runDmReadStatesStream: zero DM/MPIM channels makes zero API calls and completes cleanly", async () => {
  const db = new DatabaseSync(":memory:");
  seedChannel(db, "C01", { is_channel: true });
  globalThis.fetch = () => Promise.reject(new Error("should not be called"));
  const captured: Captured = { considered: [], records: [] };
  await runDmReadStatesStream(
    fakeDeps(db, captured, ["dm_read_states"]),
    nodeFetchSlackApiTransport,
    "xoxc-fake",
    "d-fake"
  );
  assert.equal(captured.records.length, 0);
  assert.equal(captured.considered[0]?.considered, 0);
});

// ─── runOptionalStream: run-isolation regression (the 7cc177eec class of bug) ───
//
// `stars`/`user_groups`/`reminders`/`dm_read_states` are declared
// `required: false` in the manifest. A thrown error from one of them must
// stay stream-scoped: `runOptionalStream` is the connector-local seam that
// catches it and reports a SKIP_RESULT instead of letting it reach
// `connector-runtime.ts`'s single top-level `run().catch()`, which would
// fail the entire run (see `packages/polyfill-connectors/src/connector-
// runtime.ts:766`). This directly regression-tests the failure mode from
// `tmp/workstreams/2026-07-14-health-regression/slack-stars.md`: a
// `slack_auth_failed` 401 on `stars.list` used to abort the whole run even
// though 7 other streams had already succeeded.

function captureEmitted(): { emit: (msg: EmittedMessage) => Promise<void>; messages: EmittedMessage[] } {
  const messages: EmittedMessage[] = [];
  return {
    emit: (msg) => {
      messages.push(msg);
      return Promise.resolve();
    },
    messages,
  };
}

test("runOptionalStream: a failing optional stream resolves (does not reject) and emits a SKIP_RESULT", async () => {
  const { emit, messages } = captureEmitted();

  await assert.doesNotReject(() =>
    runOptionalStream(emit, "stars", () => Promise.reject(new Error("slack_auth_failed")))
  );

  assert.equal(messages.length, 1);
  const [msg] = messages;
  assert.equal(msg?.type, "SKIP_RESULT");
  assert.equal((msg as { stream?: string }).stream, "stars");
  assert.match((msg as { message?: string }).message ?? "", /slack_auth_failed/);
  assert.equal((msg as { reason?: string }).reason, "optional_stream_failed");
});

test("runOptionalStream: a succeeding optional stream runs to completion and emits nothing", async () => {
  const { emit, messages } = captureEmitted();
  let ran = false;

  await runOptionalStream(emit, "stars", () => {
    ran = true;
    return Promise.resolve();
  });

  assert.equal(ran, true);
  assert.equal(messages.length, 0);
});

test("runOptionalStream: a retryable failure (rate limit) is flagged retryable with a retry_by_runtime action", async () => {
  const { emit, messages } = captureEmitted();

  await runOptionalStream(emit, "reminders", () => Promise.reject(new Error("slack_rate_limited")));

  const [msg] = messages;
  const hint = (msg as { recovery_hint?: { action?: string; retryable?: boolean } }).recovery_hint;
  assert.equal(hint?.retryable, true);
  assert.equal(hint?.action, "retry_by_runtime", "a transient failure claims retrying can help");
});

test("runOptionalStream: an auth failure is flagged non-retryable and omits retry_by_runtime", async () => {
  // Regression for a real evidence gap: `mapSkipCoverageCondition`
  // (reference-implementation/server/connector-coverage-policy.ts) reads
  // `recovery_action === "retry_by_runtime"` BEFORE it looks at the skip
  // reason text, and projects that as `retryable_gap`. Before this fix,
  // `runOptionalStream` set that action unconditionally, so a durable
  // `stars.list` 401 (which will not clear by retrying) was misreported as
  // a transient, self-healing gap instead of the terminal one it actually
  // is. The action must be absent here so the coverage projection falls
  // through to its reason-based classification instead.
  const { emit, messages } = captureEmitted();

  await runOptionalStream(emit, "stars", () => Promise.reject(new Error("slack_auth_failed")));

  const [msg] = messages;
  const hint = (msg as { recovery_hint?: { action?: string; retryable?: boolean } }).recovery_hint;
  assert.equal(hint?.retryable, false);
  assert.equal(hint?.action, undefined, "an auth failure must not claim retry_by_runtime can help");
});

test("runOptionalStream: an auth failure reports a structured error_code diagnostic", async () => {
  const { emit, messages } = captureEmitted();

  await runOptionalStream(emit, "stars", () => Promise.reject(new Error("slack_auth_failed")));

  const [msg] = messages;
  const { diagnostics } = msg as { diagnostics?: { error_code?: string } };
  assert.equal(diagnostics?.error_code, "slack_auth_failed");
});

test("runOptionalStream: an HTTP-status API failure reports its coded error_code, not the raw body", async () => {
  const { emit, messages } = captureEmitted();

  await runOptionalStream(emit, "user_groups", () =>
    Promise.reject(new Error("slack_api_http_500: <html>internal error</html>"))
  );

  const [msg] = messages;
  const { diagnostics } = msg as { diagnostics?: { error_code?: string } };
  assert.equal(diagnostics?.error_code, "slack_api_http_500");
});

test("runOptionalStream: a non-Slack-API error (thrown by other code) reports no diagnostics", async () => {
  const { emit, messages } = captureEmitted();

  await runOptionalStream(emit, "reminders", () => Promise.reject(new Error("boom")));

  const [msg] = messages;
  assert.equal((msg as { diagnostics?: unknown }).diagnostics, undefined);
});

function seedUser(db: DatabaseSync, id: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS S_USER (
      ID TEXT NOT NULL,
      USERNAME TEXT,
      DATA TEXT,
      CHUNK_ID INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO S_USER (ID, USERNAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)").run(
    id,
    "alice",
    JSON.stringify({ real_name: "Alice" }),
    1
  );
}

test("contrast: a REQUIRED stream's failure is NOT caught by runOptionalStream and propagates", async () => {
  // Required streams (workspace/channels/users/messages/files/canvases) are
  // called directly in `runRequestedStreams` — never through
  // `runOptionalStream` — so a thrown error from one of them must still
  // reach `collect()`'s caller and fail the whole run (the correct
  // behavior for a stream the connector's core value depends on). Drive a
  // REAL required-stream runner (`runUsersStream`) with one row so it
  // reaches `emitRecord`, and make `emitRecord` throw (the shape a schema-
  // validation or downstream I/O failure would take), so the error is
  // genuine, not a stand-in. Unlike the `runOptionalStream`-wrapped tests
  // above, this call is bare — proving the isolation seam is opt-in per
  // stream, not a blanket safety net that would also (wrongly) hide a
  // required stream's failure.
  const db = new DatabaseSync(":memory:");
  seedUser(db, "U01");
  const deps: StreamDeps = {
    db,
    emit: () => Promise.resolve(),
    emitRecord: () => Promise.reject(new Error("emitRecord_boom")),
    emittedAt: "2026-07-10T00:00:00.000Z",
    fingerprintCursors: new Map(),
    progress: () => Promise.resolve(),
    requested: new Map([["users", { name: "users" }]]),
  };
  await assert.rejects(() => runUsersStream(deps), /emitRecord_boom/);
});

// ─── acquireSlackApiBrowserTransport: TLS-fingerprint fix wiring ───────────
//
// Root cause (see slack-api.ts module header, also documented on
// acquireSlackApiBrowserTransport itself): a plain Node fetch cannot
// authenticate stars/user_groups/reminders/dm_read_states against Slack's
// edge even with a byte-identical, valid token+cookie pair, because it
// lacks slackdump's real Chromium/uTLS TLS fingerprint. These tests prove
// the acquisition + cookie-seeding + failure-isolation contract using a
// fake acquire function (the real one launches actual Chromium, which is
// out of scope for a fast unit test) — not that Slack's edge accepts the
// resulting fingerprint, which only a live call can prove.

interface FakeCookie {
  domain?: string;
  name: string;
  path?: string;
  value: string;
}

type AcquireFn = (options: { headless?: boolean; profileName: string }) => Promise<SlackApiIsolatedBrowser>;

// `SlackApiIsolatedBrowser` (index.ts) is ALREADY the minimal surface
// `acquireSlackApiBrowserTransport` depends on — the fake below satisfies it
// directly, with no cast needed at all (unlike a fake built against the full
// Playwright `IsolatedBrowser`/`BrowserContext`/`Page` types).
function fakeIsolatedBrowser(
  overrides: {
    addCookies?: (cookies: readonly FakeCookie[]) => Promise<void>;
    newPage?: () => Promise<{ evaluate: () => Promise<never> }>;
    release?: () => Promise<void>;
  } = {}
): { addCookiesCalls: FakeCookie[][]; browser: AcquireFn } {
  const addCookiesCalls: FakeCookie[][] = [];
  const browser: AcquireFn = () =>
    Promise.resolve({
      context: {
        addCookies: (cookies) => {
          addCookiesCalls.push([...(cookies as readonly FakeCookie[])]);
          return overrides.addCookies ? overrides.addCookies(cookies as readonly FakeCookie[]) : Promise.resolve();
        },
        newPage:
          overrides.newPage ??
          (() => Promise.resolve({ evaluate: () => Promise.resolve({ status: 200, body: "{}" } as never) })),
      },
      release: overrides.release ?? (() => Promise.resolve()),
    });
  return { addCookiesCalls, browser };
}

test("acquireSlackApiBrowserTransport: seeds the d/d-s cookies on .slack.com before returning a transport", async () => {
  const { addCookiesCalls, browser } = fakeIsolatedBrowser();
  const handle = await acquireSlackApiBrowserTransport(() => Promise.resolve(), "d-cookie-value", browser);
  try {
    assert.equal(addCookiesCalls.length, 1, "must seed cookies exactly once per acquisition");
    const cookies = addCookiesCalls[0] ?? [];
    const dCookie = cookies.find((c) => c.name === "d");
    const dsCookie = cookies.find((c) => c.name === "d-s");
    assert.equal(dCookie?.value, "d-cookie-value");
    assert.equal(dCookie?.domain, ".slack.com");
    assert.equal(dCookie?.path, "/");
    assert.ok(dsCookie, "must also seed the derived d-s freshness cookie slackdump's own auth provider sends");
    assert.equal(dsCookie?.domain, ".slack.com");
  } finally {
    await handle.release();
  }
});

test("acquireSlackApiBrowserTransport: browser acquisition failure never throws — returns a transport that rejects", async () => {
  const progressMessages: string[] = [];
  const handle = await acquireSlackApiBrowserTransport(
    (msg) => {
      progressMessages.push(msg);
      return Promise.resolve();
    },
    "d-cookie-value",
    () => Promise.reject(new Error("chromium_not_installed"))
  );
  // The function itself must not throw (proven by reaching this line) —
  // this is what keeps a Chromium launch failure from failing the whole
  // run, since runRequestedStreams awaits this directly, outside any
  // runOptionalStream try/catch.
  await assert.rejects(
    () => handle.transport({ url: "https://slack.com/api/stars.list", method: "GET", headers: {} }),
    /slack_api_browser_unavailable/
  );
  await assert.doesNotReject(() => handle.release(), "release must be a safe no-op after a failed acquisition");
  assert.ok(
    progressMessages.some((m) => m.includes("could not acquire a browser")),
    "must report the acquisition failure via progress so it is visible in run evidence"
  );
});

test("acquireSlackApiBrowserTransport: a failed run through runOptionalStream still reports honest per-stream SKIP_RESULTs when the browser is unavailable", async () => {
  // End-to-end proof of the isolation contract at the actual call site
  // shape: runOptionalStream wraps a stream runner that depends on the
  // (failed) transport, and the SKIP_RESULT still carries a real, specific
  // error — not a generic/opaque failure — for the operator to diagnose.
  const { messages, emit } = captureEmitted();
  const handle = await acquireSlackApiBrowserTransport(
    () => Promise.resolve(),
    "d-cookie-value",
    () => Promise.reject(new Error("headed_browser_unavailable"))
  );
  await runOptionalStream(emit, "stars", () =>
    handle.transport({ url: "https://slack.com/api/stars.list", method: "GET", headers: {} }).then(() => undefined)
  );
  await handle.release();

  assert.equal(messages.length, 1);
  const [msg] = messages;
  assert.equal(msg?.type, "SKIP_RESULT");
  assert.match((msg as { message?: string }).message ?? "", /slack_api_browser_unavailable/);
  assert.match((msg as { message?: string }).message ?? "", /headed_browser_unavailable/);
});

test("acquireSlackApiBrowserTransport: a cookie-seeding failure is isolated the same way as an acquisition failure", async () => {
  const releaseCalls: number[] = [];
  const { browser } = fakeIsolatedBrowser({
    addCookies: () => Promise.reject(new Error("context_closed")),
    release: () => {
      releaseCalls.push(1);
      return Promise.resolve();
    },
  });
  const handle = await acquireSlackApiBrowserTransport(() => Promise.resolve(), "d-cookie-value", browser);
  await assert.rejects(
    () => handle.transport({ url: "https://slack.com/api/stars.list", method: "GET", headers: {} }),
    /slack_api_browser_setup_failed/
  );
  assert.equal(releaseCalls.length, 1, "the underlying browser must still be released even though setup failed");
});
