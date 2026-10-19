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
  // The final probe is dispatched once the window has passed.
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

it("a hung final probe is inconclusive after its own five-second budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const budgets = mockProbeTimeout(t);
  t.mock.method(globalThis, "fetch", () => {
    if (Date.now() >= 60_000) {
      return new Promise<Response>(() => undefined);
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  const pending = pollClientRevocation("https://scripted.invalid", "/records", "token");
  await nextTurn();
  await tickWindow(t);
  t.mock.timers.tick(5000);
  await nextTurn();
  assert.equal(await pending, undefined);
  assert.equal(budgets.at(-1), 5000);
  assert.ok(budgets.every((budget) => budget > 0 && budget <= 5000));
});

it("timer overshoot past the deadline still runs the final probe", async (t) => {
  // Deadline read, first remaining, after the first probe, then a 250 ms sleep overshooting by 760 ms.
  const times = [0, 0, 59_000, 60_010];
  t.mock.method(CLIENT_REVOCATION_CLOCK, "now", () => times.shift() ?? 60_010);
  t.mock.method(CLIENT_REVOCATION_CLOCK, "sleep", () => Promise.resolve());
  let probes = 0;
  t.mock.method(globalThis, "fetch", () => {
    probes += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  const response = await pollClientRevocation("https://scripted.invalid", "/records", "token");
  assert.equal(response?.status, 200, "a server that never revokes must be observed, not skipped");
  assert.equal(probes, 2);
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

interface CallerProbeScript {
  finalStatus: number | undefined;
  statusAt59900: number;
}

async function clientRevocationCase(t: TestContext, caseId: string, script: CallerProbeScript) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const budgets = mockProbeTimeout(t);
  const probes: number[] = [];
  const revocations: [string, string][] = [];
  let now = 0;
  let revoked = false;
  let beforeReads = 0;
  t.mock.method(CLIENT_REVOCATION_CLOCK, "now", () => now);
  t.mock.method(CLIENT_REVOCATION_CLOCK, "sleep", (ms: number) => {
    // Fast-forward the idle polling window, then honor the final 100 ms sleep.
    now = now === 0 ? 59_900 : now + ms;
    return Promise.resolve();
  });
  t.mock.method(globalThis, "fetch", () => {
    if (!revoked) {
      beforeReads += 1;
      return Promise.resolve(new Response('{"data":[]}', { status: 200 }));
    }
    probes.push(now);
    let status = 200;
    if (now === 59_900) {
      status = script.statusAt59900;
    } else if (now >= 60_000) {
      if (script.finalStatus === undefined) {
        return new Promise<Response>(() => undefined);
      }
      status = script.finalStatus;
    }
    if (status === 200) {
      return Promise.resolve(new Response('{"data":[]}', { status }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: { type: "authentication_error", code: "grant_revoked", message: "revoked" },
        }),
        {
          status,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          },
        }
      )
    );
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
    revokeToken: (token: string, hint: string) => {
      revocations.push([token, hint]);
      revoked = true;
      return Promise.resolve({ status: 200 });
    },
  } as unknown as TargetAdapter;
  const c = ALL_CASES.find((entry) => entry.caseId === caseId);
  assert.ok(c);
  let settled = false;
  const pending = runCase(c, makeContext(adapter, streams));
  pending.then(() => {
    settled = true;
  });
  await nextTurn();
  if (script.statusAt59900 === 200 && script.finalStatus === undefined) {
    assert.deepEqual(probes, [0, 59_900, 60_000], "the timeout must belong to the final probe");
    t.mock.timers.tick(4999);
    await nextTurn();
    assert.equal(settled, false, "the final probe retains its own five-second budget");
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(settled, true, "the caller must settle when the final probe times out");
  }
  const result = await pending;
  assert.equal(beforeReads, 1, "the token must read successfully before revocation");
  const expectedRevocation = caseId.includes("refresh-token")
    ? ["refresh", "refresh_token"]
    : ["token", "access_token"];
  assert.deepEqual(revocations, [expectedRevocation]);
  return { result, probes, budgets };
}

for (const caseId of [
  "AS-25/client-revocation-of-an-access-token-ends-it",
  "AS-25/refresh-token-revocation-ends-the-family-grants",
]) {
  for (const scenario of [
    {
      name: "passes a valid refusal at 59.9 seconds",
      statusAt59900: 401,
      finalStatus: 200,
      outcome: "pass",
    },
    {
      name: "passes cached 200 followed by a valid final refusal",
      statusAt59900: 200,
      finalStatus: 401,
      outcome: "pass",
    },
    {
      name: "fails continued 200 through the final probe",
      statusAt59900: 200,
      finalStatus: 200,
      outcome: "fail",
    },
    {
      name: "fails a 500 instead of accepting it as revocation",
      statusAt59900: 500,
      finalStatus: 401,
      outcome: "fail",
    },
    {
      name: "fails a 403 instead of accepting it as revocation",
      statusAt59900: 403,
      finalStatus: 401,
      outcome: "fail",
    },
    {
      name: "skips a timed-out final probe",
      statusAt59900: 200,
      finalStatus: undefined,
      outcome: "skip",
    },
  ]) {
    it(`${caseId} ${scenario.name}`, async (t) => {
      const { result, probes, budgets } = await clientRevocationCase(t, caseId, scenario);
      assert.equal(result.outcome, scenario.outcome, result.detail ?? "(no detail)");
      if (scenario.statusAt59900 === 200) {
        assert.deepEqual(probes, [0, 59_900, 60_000]);
        assert.deepEqual(budgets, [5000, 100, 5000]);
      } else {
        assert.deepEqual(probes, [0, 59_900], "a refusal before the deadline ends polling");
        assert.deepEqual(budgets, [5000, 100]);
      }
      if (scenario.outcome === "skip") {
        assert.ok(result.detail?.includes("inconclusive"));
      }
    });
  }

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
