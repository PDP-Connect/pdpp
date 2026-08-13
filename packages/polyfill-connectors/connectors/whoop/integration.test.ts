// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  collectWhoop,
  ensureWhoopSession,
  makeWhoopPageFetch,
  parseFetchTextForTest,
  type WhoopFetch,
  whoopAllowsInteractiveAuthRepair,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { WhoopFetchResult } from "./types.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-08-13T00:00:00.000Z");

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(ROOT, "fixtures", "whoop", name), "utf8")) as unknown;
}

function scriptedFetch(bootstrap: unknown, cycles: unknown): { calls: string[]; fetch: WhoopFetch } {
  const calls: string[] = [];
  let cycleCalls = 0;
  return {
    calls,
    fetch: (path) => {
      calls.push(path);
      if (path.startsWith("/users-service")) {
        return Promise.resolve({ status: 200, json: bootstrap });
      }
      cycleCalls += 1;
      return Promise.resolve({ status: 200, json: cycleCalls === 1 ? cycles : [] });
    },
  };
}

test("collectWhoop emits six validated streams before post-record state", async () => {
  const bootstrap = await fixture("bootstrap.json");
  const cycles = await fixture("cycles.json");
  const source = scriptedFetch(bootstrap, cycles);
  const harness = makeRecordingEmit(validateRecord);

  await collectWhoop({
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    fetchPath: source.fetch,
    now: NOW,
    requested: new Set(["profile", "body", "cycles", "recoveries", "sleeps", "workouts"]),
    state: {},
  });

  assert.deepEqual(
    new Set(harness.emitted.map((record) => record.stream)),
    new Set(["profile", "body", "cycles", "recoveries", "sleeps", "workouts"])
  );
  assert.equal(harness.emitted.filter((record) => record.stream === "cycles").length, 2);
  assert.equal(harness.emitted.filter((record) => record.stream === "recoveries").length, 1);
  const lastRecord = harness.events.reduce((last, event, index) => (event.kind === "record" ? index : last), -1);
  const firstAggregateState = harness.events.findIndex(
    (event) => event.kind === "message" && event.message.type === "STATE" && event.message.stream === "cycles"
  );
  assert.ok(firstAggregateState > lastRecord);
  assert.ok(source.calls.every((path) => !path.includes("accessToken")));
  assert.ok(
    source.calls.filter((path) => path.includes("cycles/details")).every((path) => !path.includes("apiVersion"))
  );
});

test("collectWhoop filters unrequested streams and carries incremental overlap", async () => {
  const source = scriptedFetch(await fixture("bootstrap.json"), { records: await fixture("cycles.json") });
  const harness = makeRecordingEmit(validateRecord);
  await collectWhoop({
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    fetchPath: source.fetch,
    now: NOW,
    requested: new Set(["workouts"]),
    state: { workouts: { through: "2026-08-10T00:00:00.000Z" } },
  });
  assert.deepEqual(new Set(harness.emitted.map((record) => record.stream)), new Set(["workouts"]));
  const cycleCall = source.calls.find((path) => path.includes("cycles/details"));
  assert.ok(cycleCall?.includes(encodeURIComponent("2026-08-03T00:00:00.000Z")));
});

for (const [label, result, pattern] of [
  ["401", { status: 401, json: null }, /owner_repair_required/u],
  ["403", { status: 403, json: null }, /owner_repair_required/u],
  ["429", { status: 429, json: null }, /rate_limited/u],
  ["500", { status: 500, json: null }, /http_500/u],
  ["invalid JSON", { status: 200, json: null, invalidJson: true }, /invalid_json/u],
] as const) {
  test(`collectWhoop fails closed on ${label} without state`, async () => {
    const harness = makeRecordingEmit(validateRecord);
    const fetchPath: WhoopFetch = () => Promise.resolve(result satisfies WhoopFetchResult);
    await assert.rejects(
      collectWhoop({
        emit: harness.emit,
        emitRecord: harness.emitRecord,
        fetchPath,
        now: NOW,
        requested: new Set(["cycles"]),
        state: {},
      }),
      pattern
    );
    assert.equal(
      harness.protocolMessages.some((message) => message.type === "STATE"),
      false
    );
  });
}

test("collectWhoop rejects bootstrap and aggregate schema drift", async () => {
  const harness = makeRecordingEmit(validateRecord);
  await assert.rejects(
    collectWhoop({
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      fetchPath: scriptedFetch({ account: {} }, []).fetch,
      now: NOW,
      requested: new Set(["cycles"]),
      state: {},
    })
  );
  await assert.rejects(
    collectWhoop({
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      fetchPath: scriptedFetch(await fixture("bootstrap.json"), [{ cycle: { id: "drift" } }]).fetch,
      now: NOW,
      requested: new Set(["cycles"]),
      state: {},
    })
  );
});

test("manual login re-probes source truth and unattended repair does not prompt", async () => {
  const bootstrap = await fixture("bootstrap.json");
  let fetchCount = 0;
  let manualCount = 0;
  const page = {
    goto: () => Promise.resolve(null),
  } as Pick<Page, "goto"> as Page;
  const fetchPath: WhoopFetch = () => {
    fetchCount += 1;
    return Promise.resolve(fetchCount === 1 ? { status: 401, json: null } : { status: 200, json: bootstrap });
  };
  await ensureWhoopSession({
    fetchPath,
    interactive: true,
    manualLogin: () => {
      manualCount += 1;
      return Promise.resolve();
    },
    page,
    sendInteraction: () => Promise.resolve({ request_id: "fixture", status: "success", type: "INTERACTION_RESPONSE" }),
  });
  assert.equal(fetchCount, 2);
  assert.equal(manualCount, 1);

  await assert.rejects(
    ensureWhoopSession({
      fetchPath: () => Promise.resolve({ status: 401, json: null }),
      interactive: false,
      manualLogin: () => {
        throw new Error("must not prompt");
      },
      page,
      sendInteraction: () =>
        Promise.resolve({ request_id: "fixture", status: "success", type: "INTERACTION_RESPONSE" }),
    }),
    /unattended refresh cannot open interactive login/u
  );
  assert.equal(whoopAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "scheduled" }), false);
});

test("page fetch keeps Cognito token inside browser evaluation and wrong-origin storage fails typed", async () => {
  const page = {
    evaluate: async (fn: (args: { apiBase: string; requestPath: string }) => Promise<unknown>, args: unknown) => {
      const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get: () => {
          throw new Error("denied");
        },
      });
      try {
        return await fn(args as { apiBase: string; requestPath: string });
      } finally {
        if (prior) {
          Object.defineProperty(globalThis, "localStorage", prior);
        } else {
          Reflect.deleteProperty(globalThis, "localStorage");
        }
      }
    },
  } as Pick<Page, "evaluate"> as Page;
  assert.deepEqual(await makeWhoopPageFetch(page)("/probe"), { status: 401, json: null });
  assert.deepEqual(parseFetchTextForTest(200, "not json"), { status: 200, json: null, invalidJson: true });
});

test("page fetch uses the current WHOOP auth cookie without returning the token", async () => {
  let observedAuthorization: string | null = null;
  const page = {
    evaluate: async (fn: (args: { apiBase: string; requestPath: string }) => Promise<unknown>, args: unknown) => {
      const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
      const priorFetch = globalThis.fetch;
      const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { cookie: "whoop-auth-user=fixture; whoop-auth-token=cookie-token" },
      });
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {} });
      globalThis.fetch = (_input, init) => {
        observedAuthorization = new Headers(init?.headers).get("authorization");
        return Promise.resolve(new Response('{"account":"ok"}', { status: 200 }));
      };
      try {
        return await fn(args as { apiBase: string; requestPath: string });
      } finally {
        globalThis.fetch = priorFetch;
        if (priorDocument) {
          Object.defineProperty(globalThis, "document", priorDocument);
        } else {
          Reflect.deleteProperty(globalThis, "document");
        }
        if (priorStorage) {
          Object.defineProperty(globalThis, "localStorage", priorStorage);
        } else {
          Reflect.deleteProperty(globalThis, "localStorage");
        }
      }
    },
  } as Pick<Page, "evaluate"> as Page;

  assert.deepEqual(await makeWhoopPageFetch(page)("/probe"), { status: 200, json: { account: "ok" } });
  assert.equal(observedAuthorization, "bearer cookie-token");
});
