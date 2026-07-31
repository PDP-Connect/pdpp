// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import {
  buildSlackSessionCookieHeader,
  createBrowserSlackApiTransport,
  fetchAllReminders,
  fetchAllStars,
  fetchAllUserGroups,
  fetchDmReadStates,
  nodeFetchSlackApiTransport,
  resetSlackApiGovernor,
  type SlackApiRequestInit,
  slackApiFetchInBrowser,
} from "./slack-api.ts";

const ORIGINAL_FETCH = globalThis.fetch;

// Same pacing-bypass pattern as connectors/github/index.test.ts: the module
// governor sleeps a real GCRA interval between requests, which would make
// these fetch-stubbing tests pay real wall-clock. Resolve pacing waits
// instantly; behavioral pacing itself is proven in
// src/connector-http-governor.test.ts, not here.
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const TOKEN = "xoxc-fake";
const COOKIE = "fake-d-cookie";

// ─── stars.list ────────────────────────────────────────────────────────

test("fetchAllStars parses a single-page response", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        ok: true,
        items: [
          {
            type: "message",
            channel: "C01",
            message: { ts: "1714032849.123456", user: "U01" },
            date_create: 1_714_032_900,
          },
        ],
      })
    );
  const items = await fetchAllStars(nodeFetchSlackApiTransport, TOKEN, COOKIE);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.channel, "C01");
});

test("fetchAllStars returns an empty array when the workspace has no stars", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: true, items: [] }));
  const items = await fetchAllStars(nodeFetchSlackApiTransport, TOKEN, COOKIE);
  assert.deepEqual(items, []);
});

test("fetchAllStars follows pagination cursors", async () => {
  let call = 0;
  globalThis.fetch = () => {
    call += 1;
    if (call === 1) {
      return Promise.resolve(
        jsonResponse({
          ok: true,
          items: [{ type: "message", channel: "C01", message: { ts: "1.1", user: "U01" } }],
          response_metadata: { next_cursor: "page2" },
        })
      );
    }
    return Promise.resolve(
      jsonResponse({
        ok: true,
        items: [{ type: "message", channel: "C02", message: { ts: "2.2", user: "U02" } }],
        response_metadata: { next_cursor: "" },
      })
    );
  };
  const items = await fetchAllStars(nodeFetchSlackApiTransport, TOKEN, COOKIE);
  assert.equal(items.length, 2);
  assert.equal(call, 2);
});

test("fetchAllStars sends the session token, d cookie, and derived d-s cookie on every request", async () => {
  let seenAuth: { cookie: string | null; body: string; userAgent: string | null } | undefined;
  const originalNow = Date.now;
  Date.now = () => 1_714_032_910_000;
  globalThis.fetch = (_url, init) => {
    const headers = new Headers(init?.headers);
    seenAuth = {
      cookie: headers.get("Cookie"),
      body: String(init?.body ?? ""),
      userAgent: headers.get("User-Agent"),
    };
    return Promise.resolve(jsonResponse({ ok: true, items: [] }));
  };
  try {
    await fetchAllStars(nodeFetchSlackApiTransport, TOKEN, COOKIE);
    assert.equal(seenAuth?.cookie, buildSlackSessionCookieHeader(COOKIE, 1_714_032_910));
    assert.match(seenAuth?.body ?? "", new RegExp(`token=${TOKEN}`));
    assert.match(
      seenAuth?.userAgent ?? "",
      /^Mozilla\/5\.0 \((?:X11; Linux x86_64|Macintosh; Intel Mac OS X 10_15_7|Windows NT 10\.0; Win64; x64)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/129\.0\.0\.0 Safari\/537\.36$/
    );
  } finally {
    Date.now = originalNow;
  }
});

// ─── usergroups.list ───────────────────────────────────────────────────

test("fetchAllUserGroups parses groups including a deleted one", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        ok: true,
        usergroups: [
          {
            id: "S01",
            handle: "eng",
            name: "Engineering",
            users: ["U01", "U02"],
            date_create: 1_700_000_000,
            date_delete: 0,
          },
          {
            id: "S02",
            handle: "old",
            name: "Old Team",
            users: [],
            date_create: 1_600_000_000,
            date_delete: 1_700_000_001,
          },
        ],
      })
    );
  const groups = await fetchAllUserGroups(nodeFetchSlackApiTransport, TOKEN, COOKIE);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.id, "S01");
  assert.equal(groups[1]?.date_delete, 1_700_000_001);
});

test("fetchAllUserGroups returns an empty array when the workspace has no user groups", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: true, usergroups: [] }));
  const groups = await fetchAllUserGroups(nodeFetchSlackApiTransport, TOKEN, COOKIE);
  assert.deepEqual(groups, []);
});

// ─── reminders.list ────────────────────────────────────────────────────

test("fetchAllReminders parses a completed and an incomplete reminder", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        ok: true,
        reminders: [
          { id: "Rm01", creator: "U01", user: "U01", text: "ping bob", time: 1_714_032_900, complete_ts: 0 },
          {
            id: "Rm02",
            creator: "U01",
            user: "U01",
            text: "done thing",
            time: 1_710_000_000,
            complete_ts: 1_710_000_500,
          },
        ],
      })
    );
  const reminders = await fetchAllReminders(nodeFetchSlackApiTransport, TOKEN, COOKIE);
  assert.equal(reminders.length, 2);
  assert.equal(reminders[1]?.complete_ts, 1_710_000_500);
});

test("fetchAllReminders returns an empty array when the user has no reminders", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: true, reminders: [] }));
  const reminders = await fetchAllReminders(nodeFetchSlackApiTransport, TOKEN, COOKIE);
  assert.deepEqual(reminders, []);
});

// ─── conversations.info (dm_read_states) ────────────────────────────────

test("fetchDmReadStates issues one call per channel id and parses read state", async () => {
  const seenChannels: string[] = [];
  globalThis.fetch = (url) => {
    const parsed = new URL(String(url));
    const channel = parsed.searchParams.get("channel") ?? "";
    seenChannels.push(channel);
    return Promise.resolve(
      jsonResponse({
        ok: true,
        channel: { id: channel, last_read: "1714032849.123456", unread_count: 2, unread_count_display: 1 },
      })
    );
  };
  const states = await fetchDmReadStates(nodeFetchSlackApiTransport, TOKEN, COOKIE, ["D01", "D02"]);
  assert.deepEqual(seenChannels, ["D01", "D02"]);
  assert.equal(states.length, 2);
  assert.equal(states[0]?.unreadCount, 2);
});

test("fetchDmReadStates returns an empty array for an empty channel id list", async () => {
  globalThis.fetch = () => Promise.reject(new Error("should not be called"));
  const states = await fetchDmReadStates(nodeFetchSlackApiTransport, TOKEN, COOKIE, []);
  assert.deepEqual(states, []);
});

test("fetchDmReadStates uses Authorization: Bearer for the GET call", async () => {
  const seenAuth = { authorization: "", cookie: "" };
  let sawRequest = false;
  const originalNow = Date.now;
  Date.now = () => 1_714_032_910_000;
  globalThis.fetch = (_url, init) => {
    const headers = new Headers(init?.headers);
    seenAuth.authorization = headers.get("Authorization") ?? "";
    seenAuth.cookie = headers.get("Cookie") ?? "";
    sawRequest = true;
    return Promise.resolve(jsonResponse({ ok: true, channel: { id: "D01" } }));
  };
  try {
    await fetchDmReadStates(nodeFetchSlackApiTransport, TOKEN, COOKIE, ["D01"]);
    if (!sawRequest) {
      throw new Error("expected fetchDmReadStates to issue one HTTP request");
    }
    assert.equal(seenAuth.authorization, `Bearer ${TOKEN}`);
    assert.equal(seenAuth.cookie, buildSlackSessionCookieHeader(COOKIE));
  } finally {
    Date.now = originalNow;
  }
});

// ─── Error classification ────────────────────────────────────────────────

test("a 401 status throws slack_auth_failed", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "not_authed" }, 401));
  await assert.rejects(fetchAllStars(nodeFetchSlackApiTransport, TOKEN, COOKIE), /slack_auth_failed/);
});

test("ok:false with error invalid_auth throws slack_auth_failed even on HTTP 200", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "invalid_auth" }, 200));
  await assert.rejects(fetchAllStars(nodeFetchSlackApiTransport, TOKEN, COOKIE), /slack_auth_failed/);
});

test("ok:false with an unrelated error throws a scoped slack_api_error", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "missing_scope" }, 200));
  await assert.rejects(fetchAllReminders(nodeFetchSlackApiTransport, TOKEN, COOKIE), /slack_api_error_missing_scope/);
});

test("sustained 429s exhaust the governor's retry budget as slack_rate_limited", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "rate_limited" }, 429));
  await assert.rejects(fetchAllUserGroups(nodeFetchSlackApiTransport, TOKEN, COOKIE), /slack_rate_limited/);
});

// ─── Browser transport (TLS-fingerprint fix) ──────────────────────────────
//
// Root cause (see slack-api.ts module header): slackdump's own live Slack
// Web API client wraps every call in a uTLS transport that emulates a real
// Chrome TLS ClientHello; a plain Node `fetch()` presents a different
// fingerprint at the handshake layer and Slack's edge rejects it as
// invalid_auth/401 even for an objectively valid token+cookie pair. These
// tests prove the browser-transport plumbing dispatches through a real page
// (not Node fetch) and does so with the request shape a live call needs —
// they cannot prove Slack's edge actually accepts a Chromium TLS
// fingerprint (that requires a live network call, out of scope for a unit
// test), only that the connector's own code takes the corrected path.

test("slackApiFetchInBrowser: issues a fetch with credentials:'include' so the page's cookie jar rides the request", async () => {
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (_url, init) => {
    seenInit = init;
    return Promise.resolve(jsonResponse({ ok: true, items: [] }));
  };
  await slackApiFetchInBrowser({
    url: "https://slack.com/api/stars.list",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "token=xoxc-fake",
  });
  assert.equal(seenInit?.credentials, "include", "must ride the page's cookie jar (the d/d-s cookies), not send none");
});

test("slackApiFetchInBrowser: returns the same {status, body, retryAfter} shape nodeFetchSlackApiTransport does", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: true, items: [] }, 200, { "retry-after": "3" }));
  const result = await slackApiFetchInBrowser({
    url: "https://slack.com/api/stars.list",
    method: "GET",
    headers: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.retryAfter, "3");
  assert.match(result.body, /"ok":true/);
});

test("createBrowserSlackApiTransport: dispatches through page.evaluate(slackApiFetchInBrowser, req), not Node fetch directly", async () => {
  let nodeFetchCalled = false;
  globalThis.fetch = () => {
    nodeFetchCalled = true;
    return Promise.resolve(jsonResponse({ ok: true }));
  };
  let evaluatedFn: unknown;
  let evaluatedArg: unknown;
  const fakePage = {
    evaluate: <R, Arg>(fn: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R> => {
      evaluatedFn = fn;
      evaluatedArg = arg;
      return Promise.resolve({ status: 200, body: '{"ok":true}' } as R);
    },
  };
  const transport = createBrowserSlackApiTransport(fakePage);
  const req: SlackApiRequestInit = {
    url: "https://slack.com/api/reminders.list",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "token=xoxc-fake",
  };
  const result = await transport(req);

  assert.equal(
    evaluatedFn,
    slackApiFetchInBrowser,
    "must serialize slackApiFetchInBrowser into the page, not some other function"
  );
  assert.deepEqual(evaluatedArg, req, "must forward the exact request to the page, not a transformed/partial one");
  assert.equal(result.status, 200);
  // This is the crux of the fix: the actual network call happens INSIDE
  // page.evaluate (a fake here; a real Chromium page live), never through
  // Node's own fetch — proving the transport swap actually took effect,
  // not just that the function signature changed.
  assert.equal(nodeFetchCalled, false, "must not fall through to Node fetch when a browser transport is wired");
});
