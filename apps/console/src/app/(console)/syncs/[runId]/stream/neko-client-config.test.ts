import assert from "node:assert/strict";
import test from "node:test";

import { fetchNekoClientConfigResponse, NEKO_CLIENT_CONFIG_UNAVAILABLE_MESSAGE } from "./neko-client-config.ts";

const HTTP_404_RE = /HTTP 404/;

test("fetchNekoClientConfigResponse retries transient network failures", async () => {
  let attempts = 0;
  const payload = { server_path: "/neko", status_path: "/neko/status" };

  const result = await fetchNekoClientConfigResponse("/neko/session", {
    fetchImpl: () => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve(Response.json(payload));
    },
    sleepImpl: () => Promise.resolve(),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(result, payload);
});

test("fetchNekoClientConfigResponse converts persistent network failure to stable inline error", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      fetchNekoClientConfigResponse("/neko/session", {
        fetchImpl: () => {
          attempts += 1;
          return Promise.reject(new TypeError("Failed to fetch"));
        },
        sleepImpl: () => Promise.resolve(),
      }),
    { message: NEKO_CLIENT_CONFIG_UNAVAILABLE_MESSAGE }
  );

  assert.equal(attempts, 3);
});

test("fetchNekoClientConfigResponse does not retry answered HTTP failures", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      fetchNekoClientConfigResponse("/neko/session", {
        fetchImpl: () => {
          attempts += 1;
          return Promise.resolve(new Response("missing", { status: 404 }));
        },
        sleepImpl: () => Promise.resolve(),
      }),
    HTTP_404_RE
  );

  assert.equal(attempts, 1);
});
