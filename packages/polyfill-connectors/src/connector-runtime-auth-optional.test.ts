// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A scheduled run for a session-first browser connector must NOT be killed by
 * an unanswerable credentials prompt.
 *
 * Production defect (owner's second ChatGPT account, cin_484604984db7c091bd08b259,
 * 2026-08-27): the connection had a valid browser session and NO stored
 * credential row. On every scheduled run the `env` auth strategy raised a
 * `credentials` INTERACTION for CHATGPT_USERNAME/CHATGPT_PASSWORD; nothing
 * answers an interaction on a scheduled run, so the strategy threw
 * `chatgpt_credentials_missing`. That throw happens inside `resolveCredentials`,
 * which the runtime awaits BEFORE `ensureSession` — so the run died in ~0.5s
 * with empty capture directories (no browser ever opened) and the console
 * rendered "Can't collect". The first ChatGPT account, which HAS a stored
 * credential, was unaffected: it never prompts.
 *
 * These tests pin the seam directly, using the real `env` strategy from
 * `@pdpp/connector-protocol` and a declining `sendInteraction` — the same shape
 * a scheduled run presents.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { InteractionRequest, InteractionResponse } from "./connector-runtime.ts";
import { resolveCredentials } from "./connector-runtime.ts";

const CHATGPT_AUTH = {
  kind: "env",
  required: ["CHATGPT_USERNAME", "CHATGPT_PASSWORD"],
} as const;

/**
 * A scheduled run: no owner is present, so the interaction comes back
 * unanswered. `cancelled` is the real protocol status for that (see
 * `InteractionResponse` in @pdpp/connector-protocol) — the `env` strategy
 * treats any non-`success` status as a missing credential.
 */
const declineInteraction = (req: InteractionRequest): Promise<InteractionResponse> =>
  Promise.resolve({
    request_id: req.request_id ?? "req_test_1",
    status: "cancelled",
    type: "INTERACTION_RESPONSE",
  });

/** Clear the credential env so the `env` strategy is forced to prompt. */
function withoutChatGptCredentialEnv(): () => void {
  const saved = {
    CHATGPT_PASSWORD: process.env.CHATGPT_PASSWORD,
    CHATGPT_USERNAME: process.env.CHATGPT_USERNAME,
  };
  process.env.CHATGPT_USERNAME = undefined;
  process.env.CHATGPT_PASSWORD = undefined;
  delete process.env.CHATGPT_USERNAME;
  delete process.env.CHATGPT_PASSWORD;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

test("authOptional: a declined credentials prompt yields no credentials instead of failing the run", async () => {
  const restore = withoutChatGptCredentialEnv();
  let prompted = 0;
  try {
    const credentials = await resolveCredentials(CHATGPT_AUTH, {
      authOptional: true,
      connectorName: "chatgpt",
      sendInteraction: (req) => {
        prompted += 1;
        return declineInteraction(req);
      },
    });
    // The whole point: the run continues credential-less so `ensureSession`
    // can reuse this connection's existing browser session.
    assert.deepEqual(credentials, {}, "a declined prompt must resolve to an empty credential set, not throw");
  } finally {
    restore();
  }
  assert.equal(prompted, 1, "the strategy must still have attempted the prompt");
});

test("authOptional stays OFF by default: a declined credentials prompt still fails the run closed", async () => {
  const restore = withoutChatGptCredentialEnv();
  try {
    await assert.rejects(
      () =>
        resolveCredentials(CHATGPT_AUTH, {
          authOptional: false,
          connectorName: "chatgpt",
          sendInteraction: declineInteraction,
        }),
      /chatgpt_credentials_missing/,
      "without the opt-in, a missing credential must remain terminal — API connectors depend on this"
    );
  } finally {
    restore();
  }
});

test("authOptional does not swallow non-credential auth failures", async () => {
  // An empty `required` array is a connector MISCONFIGURATION, not a missing
  // owner credential. It must fail even with the opt-in set, or a broken
  // manifest would silently run without auth forever.
  await assert.rejects(
    () =>
      resolveCredentials(
        { kind: "env", required: [] },
        {
          authOptional: true,
          connectorName: "chatgpt",
          sendInteraction: declineInteraction,
        }
      ),
    /auth_env_required_missing/,
    "a malformed auth block must stay terminal even when authOptional is set"
  );

  await assert.rejects(
    () =>
      resolveCredentials({ kind: "nope" } as never, {
        authOptional: true,
        connectorName: "chatgpt",
        sendInteraction: declineInteraction,
      }),
    /auth_strategy_unknown/,
    "an unknown auth strategy must stay terminal even when authOptional is set"
  );
});

test("authOptional never fabricates credentials: a STORED credential still resolves and never prompts", async () => {
  const restore = withoutChatGptCredentialEnv();
  process.env.CHATGPT_USERNAME = "owner@example.test";
  process.env.CHATGPT_PASSWORD = "correct-horse";
  let prompted = 0;
  try {
    const credentials = await resolveCredentials(CHATGPT_AUTH, {
      authOptional: true,
      connectorName: "chatgpt",
      sendInteraction: (req) => {
        prompted += 1;
        return declineInteraction(req);
      },
    });
    assert.deepEqual(credentials, {
      CHATGPT_PASSWORD: "correct-horse",
      CHATGPT_USERNAME: "owner@example.test",
    });
  } finally {
    restore();
  }
  assert.equal(prompted, 0, "a fully-stored credential must never raise an interaction");
});

test("the chatgpt connector opts in — the production connection that failed is covered", async () => {
  // Guards the wiring, not just the seam: if `authOptional: true` is dropped
  // from the chatgpt runConnector config, the prod defect silently returns.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../connectors/chatgpt/index.ts", import.meta.url), "utf8")
  );
  assert.match(source, /authOptional:\s*true/, "connectors/chatgpt/index.ts must set authOptional: true");
});
