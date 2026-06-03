import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { StreamScope } from "../../src/connector-runtime.ts";
import { collectUser, type StreamCtx } from "./index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function installUserFetch(): void {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: 42,
        login: "octocat",
        name: "Octo Cat",
        public_repos: 10,
        public_gists: 2,
        followers: 100,
        following: 5,
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2026-06-03T00:00:00Z",
      }),
      { status: 200 }
    );
}

function makeCtx(requestedStreams: readonly string[]): {
  ctx: StreamCtx;
  records: Array<{ stream: string; data: Record<string, unknown> }>;
  states: Array<{ stream: string; cursor: unknown }>;
} {
  const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const states: Array<{ stream: string; cursor: unknown }> = [];
  const requested = new Map<string, StreamScope>(requestedStreams.map((name) => [name, { name }]));
  return {
    ctx: {
      emit: (msg) => {
        states.push({ stream: msg.stream, cursor: msg.cursor });
        return Promise.resolve();
      },
      emitRecord: (stream, data) => {
        records.push({ stream, data });
        return Promise.resolve();
      },
      progress: () => Promise.resolve(),
      requested,
      state: {},
      token: "fake-token",
    },
    records,
    states,
  };
}

test("collectUser: user_stats-only scope emits only user_stats records and state", async () => {
  installUserFetch();
  const { ctx, records, states } = makeCtx(["user_stats"]);
  await collectUser(ctx);

  assert.deepEqual(
    records.map((r) => r.stream),
    ["user_stats"]
  );
  assert.deepEqual(
    states.map((s) => s.stream),
    ["user_stats"]
  );
  assert.equal(records[0]?.data.user_id, "42");
  assert.equal(records[0]?.data.followers, 100);
});

test("collectUser: user-only scope emits only user entity records and state", async () => {
  installUserFetch();
  const { ctx, records, states } = makeCtx(["user"]);
  await collectUser(ctx);

  assert.deepEqual(
    records.map((r) => r.stream),
    ["user"]
  );
  assert.deepEqual(
    states.map((s) => s.stream),
    ["user"]
  );
  assert.equal(records[0]?.data.id, "42");
  assert.equal("followers" in (records[0]?.data ?? {}), false);
});
