// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { fetchNekoClientConfigResponse, NEKO_CLIENT_CONFIG_UNAVAILABLE_MESSAGE } from "./neko-client-config.ts";

const HTTP_404_RE = /HTTP 404/;

test("fetchNekoClientConfigResponse retries transient network failures", async () => {
  let attempts = 0;
  const observations: unknown[] = [];
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
    onObservation: (observation) => observations.push(observation),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(result, payload);
  assert.deepEqual(observations, [
    { attempt: 1, outcome: "request_started" },
    { attempt: 1, errorKind: "network", outcome: "failed", willRetry: true },
    { attempt: 2, outcome: "request_started" },
    { attempt: 2, errorKind: "network", outcome: "failed", willRetry: true },
    { attempt: 3, outcome: "request_started" },
    { attempt: 3, outcome: "response", status: 200 },
  ]);
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
  const observations: unknown[] = [];

  await assert.rejects(
    () =>
      fetchNekoClientConfigResponse("/neko/session", {
        fetchImpl: () => {
          attempts += 1;
          return Promise.resolve(new Response("missing", { status: 404 }));
        },
        onObservation: (observation) => observations.push(observation),
        sleepImpl: () => Promise.resolve(),
      }),
    HTTP_404_RE
  );

  assert.equal(attempts, 1);
  assert.deepEqual(observations, [
    { attempt: 1, outcome: "request_started" },
    { attempt: 1, outcome: "response", status: 404 },
    { attempt: 1, errorKind: "http_status", outcome: "failed", willRetry: false },
  ]);
});

test("fetchNekoClientConfigResponse classifies invalid JSON after a successful HTTP response", async () => {
  const observations: unknown[] = [];

  await assert.rejects(
    () =>
      fetchNekoClientConfigResponse("/neko/session", {
        fetchImpl: () => Promise.resolve(new Response("not JSON", { status: 200 })),
        onObservation: (observation) => observations.push(observation),
      }),
    SyntaxError
  );

  assert.deepEqual(observations, [
    { attempt: 1, outcome: "request_started" },
    { attempt: 1, outcome: "response", status: 200 },
    { attempt: 1, errorKind: "invalid_response", outcome: "failed", willRetry: false },
  ]);
});

test("a throwing config observer cannot change successful or HTTP fetch behavior", async () => {
  let attempts = 0;
  const payload = { server_path: "/neko", status_path: "/neko/status" };
  const result = await fetchNekoClientConfigResponse("/neko/session", {
    fetchImpl: () => {
      attempts += 1;
      return Promise.resolve(Response.json(payload));
    },
    onObservation: () => {
      throw new Error("observer failed");
    },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(result, payload);

  await assert.rejects(
    () =>
      fetchNekoClientConfigResponse("/neko/session", {
        fetchImpl: () => Promise.resolve(new Response("missing", { status: 404 })),
        onObservation: () => {
          throw new Error("observer failed");
        },
      }),
    HTTP_404_RE
  );
});
