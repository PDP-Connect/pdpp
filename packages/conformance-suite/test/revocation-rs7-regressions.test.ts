// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { SeededStream, TargetAdapter } from "../src/harness/adapter.ts";
import { CLIENT_REVOCATION_CLOCK, pollClientRevocation } from "../src/harness/client-revocation-poll.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ALL_CASES } from "../src/suite.ts";

const streams: SeededStream[] = [
  {
    name: "events",
    fields: ["id", "value"],
    primaryKey: ["id"],
    recordCount: 1,
    semantics: "mutable_state",
  },
];

function mockProbeTimeout(t: TestContext) {
  const budgets: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    budgets.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  return budgets;
}

async function tickWindow(t: TestContext) {
  for (let elapsed = 0; elapsed < 60_000; elapsed += 250) {
    t.mock.timers.tick(250);
    // biome-ignore lint/performance/noAwaitInLoops: flush each simulated probe before advancing its clock.
    await nextTurn();
  }
  // The last probe is dispatched at the deadline, with zero additional budget.
  t.mock.timers.tick(0);
  await nextTurn();
}

it("client revocation bounds a hung probe within the 60s window", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const budgets = mockProbeTimeout(t);
  let probes = 0;
  t.mock.method(globalThis, "fetch", () => {
    probes += 1;
    return new Promise<Response>(() => undefined);
  });
  let settled = false;
  const pending = pollClientRevocation("https://scripted.invalid", "/records", "token");
  pending.then(() => {
    settled = true;
  });
  await nextTurn();
  await tickWindow(t);
  assert.equal(settled, true, "a hung probe must not outlive the propagation window");
  assert.equal(await pending, undefined, "a timeout is not a revocation response");
  assert.deepEqual(budgets, [5000]);
  assert.equal(probes, 1, "do not stack probes after a timeout");
});

it("client revocation backs off while retaining the final 60s probe", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const probes: number[] = [];
  t.mock.method(globalThis, "fetch", () => {
    probes.push(Date.now());
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  const pending = pollClientRevocation("https://scripted.invalid", "/records", "token");
  await nextTurn();
  await tickWindow(t);
  const response = await pending;
  assert.equal(response?.status, 200);
  assert.equal(probes.at(-1), 60_000);
  assert.ok(probes.length <= 25, `expected backed-off traffic, saw ${probes.length} probes`);
});

it("client revocation gives a hung final probe no budget beyond the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const budgets = mockProbeTimeout(t);
  t.mock.method(globalThis, "fetch", () => {
    if (Date.now() === 60_000) {
      return new Promise<Response>(() => undefined);
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  const pending = pollClientRevocation("https://scripted.invalid", "/records", "token");
  await nextTurn();
  await tickWindow(t);
  assert.equal(await pending, undefined);
  assert.equal(Date.now(), 60_000);
  assert.equal(budgets.at(-1), 0);
  assert.ok(budgets.every((budget) => budget >= 0 && budget <= 5000));
});

it("a successful pre-deadline probe finishing at the boundary is inconclusive", async (t) => {
  const times = [0, 59_999, 60_000];
  t.mock.method(CLIENT_REVOCATION_CLOCK, "now", () => times.shift() ?? 60_000);
  t.mock.method(globalThis, "fetch", () => Promise.resolve(new Response("{}", { status: 200 })));
  assert.equal(await pollClientRevocation("https://scripted.invalid", "/records", "token"), undefined);
});

async function expiryCase(t: TestContext, hook: "working" | "absent" | "failed") {
  let position = 1;
  const expired = new Set<string>();
  const events: string[] = [];
  t.mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get("changes_since");
    if (cursor && expired.has(cursor)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: { type: "invalid_request_error", code: "cursor_expired", message: "expired" },
          }),
          { status: 410 }
        )
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ id: "1", data: { id: "1", value: "before" } }],
          has_more: false,
          next_changes_since: String(position),
        }),
        { status: 200 }
      )
    );
  });
  const adapter = {
    baseUrl: "https://scripted.invalid",
    queryBase: "/v1",
    issueGrant: () =>
      Promise.resolve({
        accessToken: "token",
        grantId: "grant",
        streams: [{ name: "events", fields: ["id", "value"] }],
      }),
    expireSyncCursor: (_stream: string, cursor: string) => {
      events.push("expire");
      expired.add(cursor);
      return Promise.resolve(true);
    },
    ...(hook === "absent"
      ? {}
      : {
          writeRecordField: () => {
            events.push("write");
            if (hook === "failed") {
              return Promise.resolve(false);
            }
            position += 1;
            return Promise.resolve(true);
          },
        }),
  } as unknown as TargetAdapter;
  const c = ALL_CASES.find((entry) => entry.caseId === "RS-7/expired-sync-cursor-reported-as-gone");
  assert.ok(c);
  return { result: await runCase(c, makeContext(adapter, streams)), events, expired, position };
}

it("RS-7 expiry isolates position-only tokens from later cases", async (t) => {
  const { result, events, expired, position } = await expiryCase(t, "working");
  assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  assert.deepEqual(events, ["write", "expire"]);
  assert.equal(expired.has(String(position)), false, "later cases must receive a live latest-position token");
});

it("RS-7 expiry still runs without an optional write hook", async (t) => {
  const { result, events } = await expiryCase(t, "absent");
  assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  assert.deepEqual(events, ["expire"]);
});

it("RS-7 expiry skips when advertised isolation cannot be arranged", async (t) => {
  const { result, events } = await expiryCase(t, "failed");
  assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
  assert.deepEqual(events, ["write"]);
});

for (const caseId of [
  "AS-25/client-revocation-of-an-access-token-ends-it",
  "AS-25/refresh-token-revocation-ends-the-family-grants",
]) {
  it(`${caseId} reports a timed-out probe as inconclusive`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    mockProbeTimeout(t);
    let revoked = false;
    t.mock.method(globalThis, "fetch", () => {
      if (revoked) {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(new Response('{"data":[]}', { status: 200 }));
    });
    const grant = {
      accessToken: "token",
      refreshToken: "refresh",
      grantId: "grant",
      streams: [{ name: "events", fields: ["id", "value"] }],
    };
    const adapter = {
      baseUrl: "https://scripted.invalid",
      queryBase: "/v1",
      capabilities: { refreshTokens: true },
      issueGrant: () => Promise.resolve(grant),
      issueRefreshableGrant: () => Promise.resolve(grant),
      revokeToken: () => {
        revoked = true;
        return Promise.resolve({ status: 200 });
      },
    } as unknown as TargetAdapter;
    const c = ALL_CASES.find((entry) => entry.caseId === caseId);
    assert.ok(c);
    const pending = runCase(c, makeContext(adapter, streams));
    await nextTurn();
    await tickWindow(t);
    const result = await pending;
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    assert.ok(result.detail?.includes("inconclusive"));
  });
}
