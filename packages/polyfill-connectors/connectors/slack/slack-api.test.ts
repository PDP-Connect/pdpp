// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import {
  buildSlackSessionCookieHeader,
  encodeSlackCookieValue,
  fetchAllReminders,
  fetchAllStars,
  fetchAllUserGroups,
  fetchDmReadStates,
  resetSlackApiGovernor,
  SlackApiAuthError,
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
  const items = await fetchAllStars(TOKEN, COOKIE);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.channel, "C01");
});

test("fetchAllStars returns an empty array when the workspace has no stars", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: true, items: [] }));
  const items = await fetchAllStars(TOKEN, COOKIE);
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
  const items = await fetchAllStars(TOKEN, COOKIE);
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
    await fetchAllStars(TOKEN, COOKIE);
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
  const groups = await fetchAllUserGroups(TOKEN, COOKIE);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.id, "S01");
  assert.equal(groups[1]?.date_delete, 1_700_000_001);
});

test("fetchAllUserGroups returns an empty array when the workspace has no user groups", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: true, usergroups: [] }));
  const groups = await fetchAllUserGroups(TOKEN, COOKIE);
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
  const reminders = await fetchAllReminders(TOKEN, COOKIE);
  assert.equal(reminders.length, 2);
  assert.equal(reminders[1]?.complete_ts, 1_710_000_500);
});

test("fetchAllReminders returns an empty array when the user has no reminders", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: true, reminders: [] }));
  const reminders = await fetchAllReminders(TOKEN, COOKIE);
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
  const states = await fetchDmReadStates(TOKEN, COOKIE, ["D01", "D02"]);
  assert.deepEqual(seenChannels, ["D01", "D02"]);
  assert.equal(states.length, 2);
  assert.equal(states[0]?.unreadCount, 2);
});

test("fetchDmReadStates returns an empty array for an empty channel id list", async () => {
  globalThis.fetch = () => Promise.reject(new Error("should not be called"));
  const states = await fetchDmReadStates(TOKEN, COOKIE, []);
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
    await fetchDmReadStates(TOKEN, COOKIE, ["D01"]);
    if (!sawRequest) {
      throw new Error("expected fetchDmReadStates to issue one HTTP request");
    }
    assert.equal(seenAuth.authorization, `Bearer ${TOKEN}`);
    assert.equal(seenAuth.cookie, buildSlackSessionCookieHeader(COOKIE));
  } finally {
    Date.now = originalNow;
  }
});

// ─── Cookie wire-format encoding ────────────────────────────────────────
//
// `encodeSlackCookieValue` must byte-match Go's `net/url.QueryEscape`
// (encodeQueryComponent mode), which slackdump's own client uses — NOT
// `encodeURIComponent`, which disagrees on space (`%20` vs Go's `+`) and on
// `!'()*` (unescaped in JS, escaped by Go in this mode). The counterexample
// tests below exist specifically so a future edit reintroducing
// `encodeURIComponent` (or any other non-Go-exact escaper) fails loudly.

const UNSAFE_COOKIE = "xoxd-abc+123/def==ghi";

test("encodeSlackCookieValue: +, /, = are percent-encoded to their exact Go url.QueryEscape hex form", () => {
  assert.equal(encodeSlackCookieValue(UNSAFE_COOKIE), "xoxd-abc%2B123%2Fdef%3D%3Dghi");
});

test("encodeSlackCookieValue: counterexample — a literal space becomes '+', not '%20' (encodeURIComponent would produce %20)", () => {
  assert.equal(encodeSlackCookieValue("a b"), "a+b");
  assert.notEqual(encodeSlackCookieValue("a b"), encodeURIComponent("a b"));
});

test("encodeSlackCookieValue: counterexample — !'()* are percent-encoded (encodeURIComponent leaves all four unescaped)", () => {
  const chars = "!'()*";
  assert.equal(encodeSlackCookieValue(chars), "%21%27%28%29%2A");
  assert.notEqual(encodeSlackCookieValue(chars), encodeURIComponent(chars));
});

test("encodeSlackCookieValue: an already-URL-safe value, or one already containing a valid %XX escape, is returned unchanged", () => {
  assert.equal(encodeSlackCookieValue("xoxd-abc123-def_ghi.jkl~mno"), "xoxd-abc123-def_ghi.jkl~mno");
  assert.equal(encodeSlackCookieValue("xoxd-abc%2Fdef"), "xoxd-abc%2Fdef");
});

test("buildSlackSessionCookieHeader: percent-encodes an unsafe cookie value in the wire header", () => {
  const header = buildSlackSessionCookieHeader(UNSAFE_COOKIE, 1_714_032_910);
  assert.equal(header, "d=xoxd-abc%2B123%2Fdef%3D%3Dghi; d-s=1714032900");
  assert.equal(header.includes(UNSAFE_COOKIE), false);
});

test("fetchAllStars sends the wire-encoded (not raw) cookie value when the cookie contains unsafe characters", async () => {
  const seen: { cookie: string | null } = { cookie: null };
  const originalNow = Date.now;
  Date.now = () => 1_714_032_910_000;
  globalThis.fetch = (_url, init) => {
    const headers = new Headers(init?.headers);
    seen.cookie = headers.get("Cookie");
    return Promise.resolve(jsonResponse({ ok: true, items: [] }));
  };
  try {
    await fetchAllStars(TOKEN, UNSAFE_COOKIE);
    assert.equal(seen.cookie, "d=xoxd-abc%2B123%2Fdef%3D%3Dghi; d-s=1714032900");
  } finally {
    Date.now = originalNow;
  }
});

// ─── Error classification ────────────────────────────────────────────────

test("a 401 status throws slack_auth_failed", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "not_authed" }, 401));
  await assert.rejects(fetchAllStars(TOKEN, COOKIE), /slack_auth_failed/);
});

test("a 401 status throws SlackApiAuthError with slackApiErrorCode=null (no parsed body)", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "not_authed" }, 401));
  await assert.rejects(fetchAllStars(TOKEN, COOKIE), (e: unknown) => {
    assert.ok(e instanceof SlackApiAuthError);
    assert.equal(e.slackApiErrorCode, null);
    return true;
  });
});

test("ok:false with error invalid_auth throws slack_auth_failed even on HTTP 200", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "invalid_auth" }, 200));
  await assert.rejects(fetchAllStars(TOKEN, COOKIE), /slack_auth_failed/);
});

test("ok:false with error invalid_auth throws SlackApiAuthError carrying the Slack-reported code", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "invalid_auth" }, 200));
  await assert.rejects(fetchAllStars(TOKEN, COOKIE), (e: unknown) => {
    assert.ok(e instanceof SlackApiAuthError);
    assert.equal(e.slackApiErrorCode, "invalid_auth");
    return true;
  });
});

test("ok:false with error token_revoked throws SlackApiAuthError carrying token_revoked", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "token_revoked" }, 200));
  await assert.rejects(fetchAllUserGroups(TOKEN, COOKIE), (e: unknown) => {
    assert.ok(e instanceof SlackApiAuthError);
    assert.equal(e.slackApiErrorCode, "token_revoked");
    return true;
  });
});

test("ok:false with an unrelated error throws a scoped slack_api_error, NOT a SlackApiAuthError", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "missing_scope" }, 200));
  await assert.rejects(fetchAllReminders(TOKEN, COOKIE), /slack_api_error_missing_scope/);
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "missing_scope" }, 200));
  await assert.rejects(fetchAllReminders(TOKEN, COOKIE), (e: unknown) => {
    assert.equal(e instanceof SlackApiAuthError, false);
    return true;
  });
});

test("sustained 429s exhaust the governor's retry budget as slack_rate_limited", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: false, error: "rate_limited" }, 429));
  await assert.rejects(fetchAllUserGroups(TOKEN, COOKIE), /slack_rate_limited/);
});
