// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A session-first browser connector must never ASK for a credential it does
 * not need.
 *
 * Defect part 1 (owner's second ChatGPT account, cin_484604984db7c091bd08b259,
 * 2026-08-27): the connection had a valid browser session and NO stored
 * credential row. On every scheduled run the `env` auth strategy raised a
 * `credentials` INTERACTION for CHATGPT_USERNAME/CHATGPT_PASSWORD; nothing
 * answers an interaction on a scheduled run, so the strategy threw
 * `chatgpt_credentials_missing`. That throw happens inside `resolveCredentials`,
 * which the runtime awaits BEFORE `ensureSession` — so the run died in ~0.5s
 * with empty capture directories (no browser ever opened) and the console
 * rendered "Can't collect". 6f6765bbb added `authOptional` for this.
 *
 * Defect part 2 (live prod run_1788004675387): that fix caught the FAILURE but
 * not the PROMPT. The strategy still opened the `credentials` interaction and
 * awaited it for up to 1800s. So a repair run leased and readied a browser
 * surface and then showed the owner a username/password form — unanswerable
 * for a Google-SSO account, and squarely in the way of the required journey:
 * repair page -> start a run -> streamed browser -> owner completes SSO there.
 *
 * These tests pin the seam directly, using the real `env` strategy from
 * `@pdpp/connector-protocol` and a `sendInteraction` spy — the same shape a
 * scheduled or repair run presents. The load-bearing assertions are on the
 * INTERACTION COUNT, because an empty credential set alone cannot distinguish
 * "never prompted" from "prompted, then recovered".
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

test("authOptional: a missing credential yields no credentials WITHOUT ever prompting the owner", async () => {
  // The core of the session-first fix. 6f6765bbb made a DECLINED prompt
  // survivable, but the prompt was still emitted and awaited (up to 1800s).
  // Live prod run_1788004675387 showed the cost: the run leased and readied a
  // browser surface, then put a username/password form in front of the owner.
  // That form is unanswerable for a Google-SSO account and blocks the required
  // journey (repair page -> run -> streamed browser -> owner completes SSO).
  //
  // Asserting on the SPY, not just the outcome: an empty credential set is
  // reachable both by suppressing the prompt and by catching its failure
  // afterwards. Only the interaction count distinguishes them.
  const restore = withoutChatGptCredentialEnv();
  const kinds: string[] = [];
  try {
    const credentials = await resolveCredentials(CHATGPT_AUTH, {
      authOptional: true,
      connectorName: "chatgpt",
      sendInteraction: (req) => {
        kinds.push(req.kind);
        return declineInteraction(req);
      },
    });
    // The run continues credential-less so `ensureSession` can reuse this
    // connection's existing browser session.
    assert.deepEqual(credentials, {}, "a missing credential must resolve to an empty credential set, not throw");
  } finally {
    restore();
  }
  assert.deepEqual(
    kinds.filter((kind) => kind === "credentials"),
    [],
    "a session-first run must never raise a credentials interaction; the browser is the authenticator"
  );
});

test("authOptional silences credential resolution WITHOUT closing the interaction channel", async () => {
  // Skipping the credential question must not cost the run its voice. The
  // owner completing SSO in the streamed browser depends on
  // manual_action/assist interactions still being delivered, so this pins that
  // `authOptional` suppresses one QUESTION, not the channel it was asked on.
  const restore = withoutChatGptCredentialEnv();
  const delivered: string[] = [];
  const sendInteraction = (req: InteractionRequest): Promise<InteractionResponse> => {
    delivered.push(req.kind);
    return Promise.resolve({
      request_id: req.request_id ?? "req_test_2",
      status: "success",
      type: "INTERACTION_RESPONSE",
    });
  };

  try {
    await resolveCredentials(CHATGPT_AUTH, {
      authOptional: true,
      connectorName: "chatgpt",
      sendInteraction,
    });
    // Nothing was delivered during credential resolution...
    assert.deepEqual(delivered, [], "credential resolution must be silent for a session-first connector");

    // ...and the connector's own channel still works for the browser login.
    const manual = await sendInteraction({
      kind: "manual_action",
      message: "Finish signing in with Google",
      request_id: "req_manual",
    } as InteractionRequest);
    assert.equal(manual.status, "success", "a manual_action interaction must still reach the owner");
    assert.deepEqual(delivered, ["manual_action"], "only the credential question is skipped");
  } finally {
    restore();
  }
});

test("authOptional stays OFF by default: a missing credential still PROMPTS and still fails closed", async () => {
  // REGRESSION GUARD for every connector that genuinely needs its secret
  // (github/ynab/notion/amazon/chase/...). Prompt suppression must be strictly
  // opt-in: without the flag the owner is still asked, and an unanswered
  // prompt is still terminal. Asserts the prompt COUNT as well as the throw —
  // a fix that suppressed the prompt globally would still throw here and would
  // pass a throw-only assertion.
  const restore = withoutChatGptCredentialEnv();
  const kinds: string[] = [];
  try {
    await assert.rejects(
      () =>
        resolveCredentials(CHATGPT_AUTH, {
          authOptional: false,
          connectorName: "chatgpt",
          sendInteraction: (req) => {
            kinds.push(req.kind);
            return declineInteraction(req);
          },
        }),
      /chatgpt_credentials_missing/,
      "without the opt-in, a missing credential must remain terminal — API connectors depend on this"
    );
  } finally {
    restore();
  }
  assert.deepEqual(kinds, ["credentials"], "a required credential must still be requested from the owner");
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

test("the INSTALLED protocol build honours authOptional — not just the source we intended to ship", async () => {
  // The behavior lives in `@pdpp/connector-protocol`, which reaches this repo
  // as a prebuilt tarball under vendor/. A correct upstream fix that was never
  // repacked (or a lockfile whose integrity still points at the old artifact)
  // would leave production exactly as broken while every seam test above still
  // passed against the intended semantics. So assert on the DEPENDENCY as
  // installed, through its public entrypoint.
  const { resolveAuth } = await import("@pdpp/connector-protocol/auth");
  const restore = withoutChatGptCredentialEnv();
  const calls: InteractionRequest[] = [];
  try {
    const credentials = await resolveAuth(CHATGPT_AUTH, {
      authOptional: true,
      connectorName: "chatgpt",
      sendInteraction: (req: InteractionRequest) => {
        calls.push(req);
        return declineInteraction(req);
      },
    });
    assert.deepEqual(credentials, {});
  } finally {
    restore();
  }
  assert.deepEqual(calls, [], "the installed protocol build still prompts: vendor/ tarball or lock integrity is stale");
});

test("the credentials prompt makes no false persistence promise", async () => {
  // Owner-submitted interaction values are used for THAT RUN ONLY — never
  // written to `.env.local`, durable config, or the spine event payload. The
  // prompt used to instruct the owner to "Set in .env.local for persistence",
  // describing an operator deployment step as if it were the effect of
  // answering. Asserted here as well as upstream because this repo is where
  // the owner-facing string actually ships from.
  const restore = withoutChatGptCredentialEnv();
  const calls: InteractionRequest[] = [];
  try {
    await assert.rejects(() =>
      resolveCredentials(CHATGPT_AUTH, {
        authOptional: false,
        connectorName: "chatgpt",
        sendInteraction: (req) => {
          calls.push(req);
          return declineInteraction(req);
        },
      })
    );
  } finally {
    restore();
  }
  const message = calls[0]?.message ?? "";
  assert.doesNotMatch(message, /\.env\.local/, "the prompt must not tell the owner to edit .env.local");
  assert.doesNotMatch(message, /persistence/i, "the prompt must not promise persistence it does not provide");
  assert.match(message, /CHATGPT_USERNAME/, "the prompt must still name what it needs");
});
