// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionResponse } from "../connector-runtime.ts";
import {
  CHATGPT_BROWSER_LOGIN_ASSISTANCE_MESSAGE,
  CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE,
  CHATGPT_PUSH_APPROVAL_FALLBACK_MESSAGE,
  CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE,
  CHATGPT_STORED_CREDENTIAL_REJECTED_MESSAGE,
  chatGptAllowsInteractiveAuthRepair,
  chatGptPushApprovalAssistance,
  ensureChatGptSession,
  interactionResponseCode,
  isLikelyChatGptPushApprovalText,
  resolveChatGptPushApprovalTimeoutMs,
} from "./chatgpt.ts";

function response(extra: Partial<InteractionResponse>): InteractionResponse {
  return {
    request_id: "test_interaction",
    status: "success",
    type: "INTERACTION_RESPONSE",
    ...extra,
  };
}

function extractAuthProbeDiagnostic(message: string): Record<string, unknown> {
  const prefix = "ChatGPT auth probe diagnostic ";
  assert.equal(message.startsWith(prefix), true);
  return JSON.parse(message.slice(prefix.length)) as Record<string, unknown>;
}

function withEnvUnset(keys: readonly string[], run: () => Promise<void>): Promise<void> {
  const prior = new Map<string, string | undefined>();
  for (const key of keys) {
    prior.set(key, process.env[key]);
    delete process.env[key];
  }
  return run().finally(() => {
    for (const [key, value] of prior) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function withEnvValues(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    prior.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return run().finally(() => {
    for (const [key, value] of prior) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("interactionResponseCode reads orchestrator otp responses", () => {
  assert.equal(interactionResponseCode(response({ data: { code: "123456" } })), "123456");
});

test("interactionResponseCode preserves legacy value responses", () => {
  assert.equal(interactionResponseCode(response({ value: "654321" })), "654321");
});

test("isLikelyChatGptPushApprovalText detects ChatGPT app push approval copy", () => {
  assert.equal(
    isLikelyChatGptPushApprovalText(`
      Approve sign-in
      We've sent a notification to your devices. Open the ChatGPT app on any of them to continue.
      Resend prompt
      Try with email
    `),
    true
  );
});

test("isLikelyChatGptPushApprovalText ignores ordinary login copy", () => {
  assert.equal(isLikelyChatGptPushApprovalText("Log in to ChatGPT Continue with password"), false);
});

test("isLikelyChatGptPushApprovalText requires supporting push-approval copy", () => {
  assert.equal(isLikelyChatGptPushApprovalText("Approve sign-in"), false);
});

test("ChatGPT push approval copy separates external approval from browser control", () => {
  assert.match(CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE, /continue automatically/i);
  assert.doesNotMatch(CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE, /streaming companion|run interaction controls/i);
  assert.match(CHATGPT_PUSH_APPROVAL_FALLBACK_MESSAGE, /open the ChatGPT app to approve it/i);
});

test("chatGptPushApprovalAssistance emits nonblocking external approval shape", () => {
  // The observation budget is raised so realistic late approvals auto-resume via
  // the non-blocking poll; the assistance timeout is derived from that budget.
  assert.deepEqual(chatGptPushApprovalAssistance({}), {
    message: CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE,
    progress_posture: "running",
    owner_action: "act_elsewhere",
    response_contract: "none",
    sensitivity: "non_secret",
    timeout_seconds: 900,
  });
});

test("ChatGPT push approval checkpoints while polling so the session watchdog sees progress", async () => {
  const originalUsername = process.env.CHATGPT_USERNAME;
  const originalPassword = process.env.CHATGPT_PASSWORD;
  process.env.CHATGPT_USERNAME = "owner@example.test";
  process.env.CHATGPT_PASSWORD = "correct horse battery staple";

  let sessionProbeCount = 0;
  let passwordSubmitted = false;
  const checkpoints: string[] = [];
  const assistanceMessages: string[] = [];

  function locator(options: { count?: number; visible?: boolean } = {}) {
    const count = options.count ?? 0;
    const visible = options.visible ?? count > 0;
    const self = {
      click: () => {
        passwordSubmitted = true;
        return Promise.resolve();
      },
      count: () => count,
      fill: () => Promise.resolve(),
      first: () => self,
      waitFor: () => {
        if (!visible) {
          return Promise.reject(new Error("not visible"));
        }
        return Promise.resolve();
      },
    };
    return self;
  }

  const page = {
    evaluate: (fn: (...args: never[]) => unknown) => {
      const source = String(fn);
      if (source.includes("/api/auth/session")) {
        sessionProbeCount += 1;
        return sessionProbeCount >= 18 ? { user: { id: "owner" } } : null;
      }
      return false;
    },
    getByRole: () => locator({ visible: false }),
    getByText: (text: RegExp) =>
      locator({
        visible:
          passwordSubmitted &&
          (text.test("Approve sign-in") ||
            text.test("sent a notification") ||
            text.test("ChatGPT app") ||
            text.test("your devices")),
      }),
    goto: async () => undefined,
    locator: (selector: string) => {
      if (selector.includes('input[type="email"]') || selector.includes('input[type="password"]')) {
        return locator({ count: 1 });
      }
      if (selector.includes('input[name="code"]') || selector.includes('input[type="tel"]')) {
        return locator({ count: 0 });
      }
      return locator({ count: 1 });
    },
    waitForTimeout: async () => undefined,
  };

  try {
    const ok = await ensureChatGptSession({
      assist: (req) => {
        assistanceMessages.push(req.message);
        return Promise.resolve("assist_1");
      },
      checkpoint: (label) => {
        checkpoints.push(label);
        return Promise.resolve();
      },
      completeAssistance: () => Promise.resolve(),
      context: {} as never,
      page: page as never,
      progress: () => Promise.resolve(),
      sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
    });

    assert.equal(ok, true);
    assert.deepEqual(assistanceMessages, [CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE]);
    assert.ok(
      checkpoints.includes("chatgpt-push-approval-requested"),
      "push approval should checkpoint immediately after assistance is emitted"
    );
    assert.ok(
      checkpoints.includes("chatgpt-push-approval-waiting-12"),
      "long app-approval polling should checkpoint before the 120s watchdog deadline"
    );
  } finally {
    if (originalUsername === undefined) {
      delete process.env.CHATGPT_USERNAME;
    } else {
      process.env.CHATGPT_USERNAME = originalUsername;
    }
    if (originalPassword === undefined) {
      delete process.env.CHATGPT_PASSWORD;
    } else {
      process.env.CHATGPT_PASSWORD = originalPassword;
    }
  }
});

test("ChatGPT initial auth probe emits bounded diagnostic before credential login", async () => {
  await withEnvUnset(["CHATGPT_USERNAME", "CHATGPT_PASSWORD"], async () => {
    const progressMessages: string[] = [];
    const privateRoute = "https://chatgpt.com/c/private-conversation-id";
    let currentUrl = privateRoute;
    const page = {
      evaluate: (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("/api/auth/session")) {
          return Promise.resolve(null);
        }
        if (source.includes("querySelectorAll")) {
          return Promise.resolve({
            dom_logged_in: true,
            has_login_or_signup: false,
            has_sidebar: true,
            has_user_menu: false,
          });
        }
        return Promise.resolve(false);
      },
      goto: (url: string) => {
        currentUrl = url;
        return Promise.resolve(null);
      },
      url: () => currentUrl,
      waitForTimeout: async () => undefined,
    };

    await assert.rejects(
      ensureChatGptSession({
        allowInteractiveAuthRepair: false,
        context: {} as never,
        page: page as never,
        progress: (message) => {
          progressMessages.push(message);
          return Promise.resolve();
        },
        sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
      }),
      /chatgpt_session_required/u
    );

    assert.equal(progressMessages.length, 2);
    assert.doesNotMatch(progressMessages[0] ?? "", /private-conversation-id/u);
    const diagnostic = extractAuthProbeDiagnostic(progressMessages[0] ?? "");
    assert.deepEqual(diagnostic, {
      object: "chatgpt_auth_probe",
      stage: "initial",
      api_session_user: false,
      dom_logged_in: true,
      has_login_or_signup: false,
      has_sidebar: true,
      has_user_menu: false,
      route_class: "home",
      decision: "credential_login_required",
    });
  });
});

test("ChatGPT initial auth probe preserves existing API-session decision", async () => {
  const progressMessages: string[] = [];
  let loginOpened = false;
  const page = {
    evaluate: (fn: (...args: never[]) => unknown) => {
      const source = String(fn);
      if (source.includes("/api/auth/session")) {
        return Promise.resolve({ user: { id: "owner" } });
      }
      if (source.includes("querySelectorAll")) {
        return Promise.resolve({
          dom_logged_in: false,
          has_login_or_signup: true,
          has_sidebar: false,
          has_user_menu: false,
        });
      }
      return Promise.resolve(false);
    },
    getByRole: () => {
      loginOpened = true;
      throw new Error("login path should not be reached");
    },
    goto: (url: string) => {
      if (url.includes("/auth/login")) {
        loginOpened = true;
      }
      return Promise.resolve(null);
    },
    url: () => "https://chatgpt.com/",
    waitForTimeout: async () => undefined,
  };

  const ok = await ensureChatGptSession({
    context: {} as never,
    page: page as never,
    progress: (message) => {
      progressMessages.push(message);
      return Promise.resolve();
    },
    sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
  });

  assert.equal(ok, true);
  assert.equal(loginOpened, false);
  assert.equal(progressMessages.length, 1);
  const diagnostic = extractAuthProbeDiagnostic(progressMessages[0] ?? "");
  assert.equal(diagnostic.api_session_user, true);
  assert.equal(diagnostic.decision, "accepted_by_api_session");
});

test("ChatGPT auth repair policy only allows owner-started manual runs by default", () => {
  assert.equal(chatGptAllowsInteractiveAuthRepair({}), true);
  assert.equal(chatGptAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "manual" }), true);
  assert.equal(chatGptAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "scheduled" }), false);
  assert.equal(chatGptAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "retry" }), false);
  assert.equal(chatGptAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "webhook" }), false);
});

test("ChatGPT scheduled auth repair fails before credential login or owner prompts", async () => {
  await withEnvValues(
    {
      CHATGPT_PASSWORD: "correct horse battery staple",
      CHATGPT_USERNAME: "owner@example.test",
      PDPP_RUN_AUTOMATION_MODE: "unattended",
      PDPP_RUN_TRIGGER_KIND: "scheduled",
    },
    async () => {
      const progressMessages: string[] = [];
      const visitedUrls: string[] = [];
      const page = {
        evaluate: (fn: (...args: never[]) => unknown) => {
          const source = String(fn);
          if (source.includes("/api/auth/session")) {
            return Promise.resolve(null);
          }
          if (source.includes("querySelectorAll")) {
            return Promise.resolve({
              dom_logged_in: false,
              has_login_or_signup: true,
              has_sidebar: false,
              has_user_menu: false,
            });
          }
          return Promise.resolve(false);
        },
        getByRole: () => {
          throw new Error("scheduled auth repair must not open or click the login form");
        },
        goto: (url: string) => {
          visitedUrls.push(url);
          return Promise.resolve(null);
        },
        locator: () => {
          throw new Error("scheduled auth repair must not inspect credential form fields");
        },
        url: () => "https://chatgpt.com/",
        waitForTimeout: async () => undefined,
      };

      await assert.rejects(
        ensureChatGptSession({
          assist: async () => {
            await Promise.resolve();
            throw new Error("scheduled auth repair must not emit assistance");
          },
          context: {} as never,
          page: page as never,
          progress: (message) => {
            progressMessages.push(message);
            return Promise.resolve();
          },
          sendInteraction: async () => {
            await Promise.resolve();
            throw new Error("scheduled auth repair must not emit interactions");
          },
        }),
        /chatgpt_session_required/u
      );

      assert.deepEqual(visitedUrls, ["https://chatgpt.com/"]);
      assert.equal(progressMessages.length, 2);
      assert.equal(extractAuthProbeDiagnostic(progressMessages[0] ?? "").decision, "credential_login_required");
      assert.match(progressMessages[1] ?? "", /automatic refresh will not start interactive auth repair/u);
    }
  );
});

test("ChatGPT manual auth repair can use the secure browser without storing a password", async () => {
  await withEnvValues(
    {
      CHATGPT_PASSWORD: undefined,
      CHATGPT_USERNAME: undefined,
      PDPP_RUN_AUTOMATION_MODE: "assisted",
      PDPP_RUN_TRIGGER_KIND: "manual",
    },
    async () => {
      const assistanceMessages: string[] = [];
      let sessionProbeCount = 0;
      const page = {
        evaluate: (fn: (...args: never[]) => unknown) => {
          const source = String(fn);
          if (source.includes("/api/auth/session")) {
            sessionProbeCount += 1;
            return Promise.resolve(sessionProbeCount >= 2 ? { user: { id: "owner" } } : null);
          }
          if (source.includes("querySelectorAll")) {
            return Promise.resolve({
              dom_logged_in: false,
              has_login_or_signup: true,
              has_sidebar: false,
              has_user_menu: false,
            });
          }
          return Promise.resolve(false);
        },
        goto: () => Promise.resolve(null),
        getByText: () => ({
          first() {
            return this;
          },
          waitFor: () => Promise.reject(new Error("not visible")),
        }),
        url: () => "https://chatgpt.com/",
        waitForTimeout: async () => undefined,
      };

      const ok = await ensureChatGptSession({
        assist: (req) => {
          assistanceMessages.push(req.message);
          return Promise.resolve("assist_1");
        },
        completeAssistance: () => Promise.resolve(),
        context: {} as never,
        page: page as never,
        progress: () => Promise.resolve(),
        sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
      });

      assert.equal(ok, true);
      assert.deepEqual(assistanceMessages, [
        "ChatGPT could not finish sign-in automatically; open the browser to continue. PDPP resumes when sign-in succeeds.",
      ]);

      const inactivePage = {
        evaluate: (fn: (...args: never[]) => unknown) => {
          const source = String(fn);
          if (source.includes("/api/auth/session")) {
            return Promise.resolve(null);
          }
          if (source.includes("querySelectorAll")) {
            return Promise.resolve({
              dom_logged_in: false,
              has_login_or_signup: true,
              has_sidebar: false,
              has_user_menu: false,
            });
          }
          return Promise.resolve(false);
        },
        goto: () => Promise.resolve(null),
        url: () => "https://chatgpt.com/",
        waitForTimeout: async () => undefined,
      };
      await assert.rejects(
        ensureChatGptSession({
          allowInteractiveAuthRepair: false,
          context: {} as never,
          page: inactivePage as never,
          progress: () => Promise.resolve(),
          sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
        }),
        /chatgpt_session_required/u
      );
    }
  );
});

test("ChatGPT fallback keeps owner copy concise while preserving diagnostic evidence separately", async () => {
  await withEnvValues(
    {
      CHATGPT_PASSWORD: "stored password",
      CHATGPT_USERNAME: "owner@example.test",
      PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS: "1",
      PDPP_RUN_AUTOMATION_MODE: "assisted",
      PDPP_RUN_TRIGGER_KIND: "manual",
    },
    async () => {
      const assistanceMessages: string[] = [];
      const diagnosticMessages: string[] = [];
      const page = {
        evaluate: (fn: (...args: never[]) => unknown) => {
          const source = String(fn);
          if (source.includes("/api/auth/session")) {
            return Promise.resolve(null);
          }
          if (source.includes("querySelectorAll")) {
            return Promise.resolve({
              dom_logged_in: false,
              has_login_or_signup: true,
              has_sidebar: false,
              has_user_menu: false,
            });
          }
          return Promise.resolve(false);
        },
        getByRole: () => {
          const locator = {
            click: () => Promise.reject(new Error("not visible")),
            first() {
              return locator;
            },
            waitFor: () => Promise.reject(new Error("not visible")),
          };
          return locator;
        },
        goto: () => Promise.resolve(null),
        locator: () => {
          const locator = {
            count: () => Promise.resolve(0),
            fill: () => Promise.resolve(),
            first() {
              return locator;
            },
            waitFor: () => Promise.reject(new Error("not visible")),
          };
          return locator;
        },
        url: () => "https://chatgpt.com/",
        waitForTimeout: async () => undefined,
      };

      await assert.rejects(
        ensureChatGptSession({
          assist: (req) => {
            assistanceMessages.push(req.message);
            return Promise.resolve("assist_1");
          },
          completeAssistance: (_id, _status, extra) => {
            if (extra?.message) {
              diagnosticMessages.push(extra.message);
            }
            return Promise.resolve();
          },
          context: {} as never,
          page: page as never,
          progress: () => Promise.resolve(),
          sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
        }),
        /chatgpt_login_unexpected_ui/u
      );

      assert.deepEqual(assistanceMessages, [CHATGPT_BROWSER_LOGIN_ASSISTANCE_MESSAGE]);
      assert.match(diagnosticMessages.join("\n"), /Cloudflare challenge confirmed|ChatGPT login inputs were not found/);
      assert.doesNotMatch(
        assistanceMessages[0] ?? "",
        /PDPP_BROWSER_HEADLESS|Cloudflare challenge|streaming companion|rerun/i
      );
    }
  );
});

test("ChatGPT rejected stored password fails before push approval or browser assistance", async () => {
  await withEnvValues(
    {
      CHATGPT_PASSWORD: "stale password",
      CHATGPT_USERNAME: "owner@example.test",
      PDPP_RUN_AUTOMATION_MODE: "assisted",
      PDPP_RUN_TRIGGER_KIND: "manual",
    },
    async () => {
      let passwordSubmitted = false;
      const page = {
        evaluate: (fn: (...args: never[]) => unknown) => {
          const source = String(fn);
          if (source.includes("/api/auth/session")) {
            return Promise.resolve(null);
          }
          if (source.includes("querySelectorAll")) {
            return Promise.resolve({
              dom_logged_in: false,
              has_login_or_signup: true,
              has_sidebar: false,
              has_user_menu: false,
            });
          }
          return Promise.resolve(false);
        },
        getByRole: () => ({
          click: () => Promise.resolve(),
          first() {
            return this;
          },
          waitFor: () => Promise.resolve(),
        }),
        getByText: (text: RegExp) => ({
          first() {
            return this;
          },
          waitFor: () =>
            passwordSubmitted && text.test("Incorrect email address or password")
              ? Promise.resolve()
              : Promise.reject(new Error("not visible")),
        }),
        goto: () => Promise.resolve(null),
        locator: (selector: string) => {
          const count =
            selector.includes('input[type="email"]') ||
            selector.includes('input[type="password"]') ||
            selector.includes('button[type="submit"]') ||
            selector.includes(":text-is")
              ? 1
              : 0;
          const locator = {
            click: () => {
              if (selector.includes('button[type="submit"]') || selector.includes(":text-is")) {
                passwordSubmitted = true;
              }
              return Promise.resolve();
            },
            count: () => Promise.resolve(count),
            fill: () => Promise.resolve(),
            first() {
              return locator;
            },
            waitFor: () => (count > 0 ? Promise.resolve() : Promise.reject(new Error("not visible"))),
          };
          return locator;
        },
        url: () => "https://chatgpt.com/",
        waitForTimeout: async () => undefined,
      };

      // The rejection throw below is the canonical post-submit failure: the
      // stored password already went out, so the marker must have fired —
      // exactly once, and only after the submit click (the email-continue
      // click also matches the fixture's submit selectors, but must not fire
      // the marker: only the password-submit call site does).
      let markerCount = 0;
      await assert.rejects(
        ensureChatGptSession({
          assist: async () => {
            await Promise.resolve();
            throw new Error("rejected stored password must not request owner assistance");
          },
          context: {} as never,
          onCredentialSubmit: () => {
            markerCount += 1;
            assert.equal(passwordSubmitted, true, "marker must fire only after the password submit click");
          },
          page: page as never,
          progress: () => Promise.resolve(),
          sendInteraction: async () => {
            await Promise.resolve();
            throw new Error("rejected stored password must not ask for push approval or OTP");
          },
        }),
        new RegExp(CHATGPT_STORED_CREDENTIAL_REJECTED_MESSAGE)
      );
      assert.equal(markerCount, 1, "one stored-credential attempt — the runtime must hear exactly one submit");
    }
  );
});

/**
 * Builds a fake ChatGPT login page with no matching login inputs (mirrors the
 * `page` fixture in "ChatGPT fallback keeps owner copy concise...") that ALSO
 * carries `title()`/`content()` evidence — the page a browser connector
 * actually lands on when a non-Cloudflare provider block/interstitial is
 * served instead of the ChatGPT login form. Every CSS/role locator finds
 * nothing, so `detectCloudflareChallenge` reports no signals for this
 * fixture (matches the real observed shape: the provider block is not
 * Cloudflare).
 */
function makeChatGptPageWithoutLoginInputsButWithContent(opts: {
  content?: string;
  title?: string;
}): Record<string, unknown> {
  const emptyLocator = {
    click: () => Promise.reject(new Error("not visible")),
    count: () => Promise.resolve(0),
    fill: () => Promise.resolve(),
    first() {
      return emptyLocator;
    },
    waitFor: () => Promise.reject(new Error("not visible")),
  };
  return {
    content: () => Promise.resolve(opts.content ?? ""),
    evaluate: (fn: (...args: never[]) => unknown) => {
      const source = String(fn);
      if (source.includes("/api/auth/session")) {
        return Promise.resolve(null);
      }
      if (source.includes("querySelectorAll")) {
        return Promise.resolve({
          dom_logged_in: false,
          has_login_or_signup: true,
          has_sidebar: false,
          has_user_menu: false,
        });
      }
      return Promise.resolve(false);
    },
    getByRole: () => emptyLocator,
    goto: () => Promise.resolve(null),
    locator: () => emptyLocator,
    title: () => Promise.resolve(opts.title ?? ""),
    url: () => "https://chatgpt.com/",
    waitForTimeout: async () => undefined,
  };
}

async function expectUnexpectedLoginUiRun(
  page: Record<string, unknown>,
  timeoutMsOverride = "1"
): Promise<{ assistanceMessages: string[]; capturedLabels: string[]; diagnosticMessages: string[] }> {
  const assistanceMessages: string[] = [];
  const diagnosticMessages: string[] = [];
  const capturedLabels: string[] = [];
  await withEnvValues(
    {
      CHATGPT_PASSWORD: "stored password",
      CHATGPT_USERNAME: "owner@example.test",
      PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS: timeoutMsOverride,
      PDPP_RUN_AUTOMATION_MODE: "assisted",
      PDPP_RUN_TRIGGER_KIND: "manual",
    },
    async () => {
      await assert.rejects(
        ensureChatGptSession({
          assist: (req) => {
            assistanceMessages.push(req.message);
            return Promise.resolve("assist_1");
          },
          capture: {
            baseDir: "/tmp/fixtures/chatgpt/raw/test-run",
            captureDom: (_page: unknown, label: string) => {
              capturedLabels.push(label);
              return Promise.resolve();
            },
            captureHttp: () => undefined,
            finalize: () => undefined,
            keepOnSuccess: true,
            markSucceeded: () => undefined,
            recordRecord: () => undefined,
            runId: "test-run",
          } as never,
          completeAssistance: (_id, _status, extra) => {
            if (extra?.message) {
              diagnosticMessages.push(extra.message);
            }
            return Promise.resolve();
          },
          context: {} as never,
          page: page as never,
          progress: () => Promise.resolve(),
          sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
        }),
        /chatgpt_login_unexpected_ui/u
      );
    }
  );
  return { assistanceMessages, capturedLabels, diagnosticMessages };
}

// Regression: architecturally identical gap to the reddit.ts fix — a
// non-Cloudflare provider block/interstitial on the ChatGPT login page fell
// through to the generic "page may have changed" message even though the
// page content would prove a block. The diagnostic message must name the
// detected condition and cite the captured artifact, not guess why.
test("ChatGPT unexpected-login-UI fallback names a provider block/interstitial and cites the captured artifact", async () => {
  const page = makeChatGptPageWithoutLoginInputsButWithContent({
    content:
      '<html><body><pre>{"errorCode":"15","errorDescription":"Incapsula incident ID: 123456789012345678-987654321098765432","incidentId":"123456789012345678-987654321098765432","proxyId":"abcdef12"}</pre></body></html>',
  });

  const { capturedLabels, diagnosticMessages } = await expectUnexpectedLoginUiRun(page);

  const message = diagnosticMessages.join("\n");
  assert.match(message, /provider block\/interstitial/i);
  assert.match(message, /imperva_incapsula_json_error/);
  assert.doesNotMatch(message, /Cloudflare challenge confirmed/);
  assert.doesNotMatch(message, /the login page may have changed/i);
  assert.ok(
    capturedLabels.includes("auth-unexpected-login-ui"),
    `expected a capture call for the blocked page, got labels: ${capturedLabels.join(", ")}`
  );
  assert.match(message, /\/tmp\/fixtures\/chatgpt\/raw\/test-run\/dom\/auth-unexpected-login-ui\.html/);
  // Never speculates about WHY (IP reputation / fingerprint / rate limit).
  assert.doesNotMatch(message, /IP reputation|fingerprint|rate limit/i);
});

// A real Cloudflare challenge must still classify as Cloudflare, not as the
// new provider-block condition — the two detectors are deliberately disjoint
// (detectCloudflareChallenge owns Cloudflare; the new detector is explicitly
// for non-Cloudflare provider blocks) and Cloudflare's message takes
// priority in unexpectedLoginUiMessage.
test("ChatGPT unexpected-login-UI fallback still classifies a Cloudflare page as Cloudflare, not a provider block", async () => {
  const page = makeChatGptPageWithoutLoginInputsButWithContent({
    title: "Just a moment...",
  });

  const { diagnosticMessages } = await expectUnexpectedLoginUiRun(page);

  const message = diagnosticMessages.join("\n");
  assert.match(message, /Cloudflare challenge confirmed/);
  assert.match(message, /title_just_a_moment/);
  assert.doesNotMatch(message, /provider block\/interstitial/i);
  assert.doesNotMatch(message, /IP reputation|fingerprint|rate limit/i);
});

// NEGATIVE control: an ordinary page that just happens to have no matching
// login inputs (e.g. a genuine UI change) must NOT be misclassified as a
// provider block — the generic fallback must remain byte-for-byte unchanged.
test("ChatGPT unexpected-login-UI fallback keeps the generic fallback for an ordinary (non-block) page", async () => {
  const page = makeChatGptPageWithoutLoginInputsButWithContent({
    title: "ChatGPT",
    content: "<html><body><main><h1>Welcome</h1><p>Nothing to see here.</p></main></body></html>",
  });

  const { diagnosticMessages } = await expectUnexpectedLoginUiRun(page);

  const message = diagnosticMessages.join("\n");
  assert.match(
    message,
    /ChatGPT login inputs were not found and no Cloudflare challenge was detected \(the login page may have changed\)\. Complete login in the streaming companion, or rerun with PDPP_BROWSER_HEADLESS=0 \(or unset it\) on a browser-capable deployment\./
  );
  assert.doesNotMatch(message, /provider block\/interstitial/i);
  assert.doesNotMatch(message, /Cloudflare challenge confirmed/);
  assert.doesNotMatch(message, /IP reputation|fingerprint|rate limit/i);
});

test("resolveChatGptPushApprovalTimeoutMs honors a positive env override and falls back otherwise", () => {
  assert.equal(resolveChatGptPushApprovalTimeoutMs({}), 900_000);
  assert.equal(resolveChatGptPushApprovalTimeoutMs({ PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "60000" }), 60_000);
  // Non-positive / non-numeric values fall back to the default.
  assert.equal(resolveChatGptPushApprovalTimeoutMs({ PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "0" }), 900_000);
  assert.equal(resolveChatGptPushApprovalTimeoutMs({ PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "nope" }), 900_000);
});

test("chatGptPushApprovalAssistance derives timeout_seconds from the configured budget", () => {
  // 5-minute override -> 300s assistance timeout. NodeJS.ProcessEnv accepts the
  // partial env object in the test.
  const assistance = chatGptPushApprovalAssistance({ PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "300000" });
  assert.equal(assistance.timeout_seconds, 300);
});
