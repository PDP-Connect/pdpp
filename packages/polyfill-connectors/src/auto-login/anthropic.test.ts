// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anthropicBrowserLoginAssistance,
  resolveAnthropicBrowserLoginTimeoutMs,
  waitForAnthropicSessionReadiness,
} from "./anthropic.ts";

test("Anthropic browser login assistance is non-secret and response-free", () => {
  const req = anthropicBrowserLoginAssistance({ PDPP_ANTHROPIC_BROWSER_LOGIN_TIMEOUT_MS: "10000" });

  assert.equal(req.sensitivity, "non_secret");
  assert.equal(req.response_contract, "none");
  assert.equal(req.timeout_seconds, 10);
  assert.deepEqual(req.attachments, [{ kind: "browser_surface", role: "streaming_companion" }]);
});

test("Anthropic browser login timeout falls back to the bounded default", () => {
  assert.equal(resolveAnthropicBrowserLoginTimeoutMs({ PDPP_ANTHROPIC_BROWSER_LOGIN_TIMEOUT_MS: "nope" }), 1_800_000);
  assert.equal(resolveAnthropicBrowserLoginTimeoutMs({ PDPP_ANTHROPIC_BROWSER_LOGIN_TIMEOUT_MS: "0" }), 1_800_000);
  assert.equal(resolveAnthropicBrowserLoginTimeoutMs({ PDPP_ANTHROPIC_BROWSER_LOGIN_TIMEOUT_MS: "2500" }), 2500);
});

test("Anthropic readiness poll returns as soon as the session probe succeeds", async () => {
  let probes = 0;
  const waits: number[] = [];
  const checkpoints: string[] = [];

  const ready = await waitForAnthropicSessionReadiness({
    attempts: 5,
    checkpoint: (label) => {
      checkpoints.push(label);
      return Promise.resolve();
    },
    intervalMs: 123,
    probe: () => {
      probes += 1;
      return Promise.resolve(probes === 3);
    },
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });

  assert.equal(ready, true);
  assert.equal(probes, 3);
  assert.deepEqual(waits, [123, 123]);
  assert.deepEqual(checkpoints, [
    "anthropic-browser-login-poll",
    "anthropic-browser-login-poll",
    "anthropic-browser-login-poll",
  ]);
});

test("Anthropic readiness poll fails closed after its bounded attempts", async () => {
  let probes = 0;
  const ready = await waitForAnthropicSessionReadiness({
    attempts: 2,
    intervalMs: 1,
    probe: () => {
      probes += 1;
      return Promise.resolve(false);
    },
    wait: () => Promise.resolve(),
  });

  assert.equal(ready, false);
  assert.equal(probes, 2);
});
