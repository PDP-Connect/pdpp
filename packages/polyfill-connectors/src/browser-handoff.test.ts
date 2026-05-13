/**
 * Tests for the browser-binding-local handoff helper.
 *
 * The helper bridges a `manual_action` interaction to the streaming
 * companion's per-interaction page-target registry. We exercise:
 *
 *   1. `manualAction` calls `sendInteraction` with the kind + generated
 *      interactionId-as-request_id contract.
 *   2. `prepareManualAction` is honest about "streaming not configured"
 *      (returns `registered: false` rather than throwing).
 *   3. `prepareManualAction` registers with the right composite-key payload
 *      when the env is wired up + a fake `fetch` returns 200.
 *   4. The composed wsUrl shape: `ws://<host>:<port>/devtools/page/<targetId>`.
 *   5. Page-close-during-resolution: `newCDPSession` throwing must NOT
 *      bubble; the helper still returns the interactionId.
 *
 * We mock `Page` with the minimal surface the resolver needs:
 *   `.context().newCDPSession(page)` → returns a `CDPSession`-like object
 *   `.url()` and `.title()` for best-effort metadata
 *
 * No real Playwright launch, no real reference server.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";

import {
  BROWSER_CDP_HOST_ENV,
  BROWSER_CDP_PORT_ENV,
  BROWSER_SURFACE_ID_ENV,
  BROWSER_SURFACE_LEASE_ID_ENV,
  BROWSER_SURFACE_PROFILE_KEY_ENV,
  BROWSER_SURFACE_REQUIRED_ENV,
  BROWSER_SURFACE_STREAM_BASE_URL_ENV,
  manualAction,
  prepareManualAction,
  resolveWsUrlForExactPage,
  type SendInteraction,
} from "./browser-handoff.ts";
import type { InteractionRequest, InteractionResponse } from "./connector-runtime.ts";
import { LOCAL_DEVICE_TOKEN_ENV, STREAMING_REGISTRATION_TOKEN_ENV } from "./streaming-target-registration.ts";

// ─── Page mock helpers ─────────────────────────────────────────────────────
//
// The resolver needs `page.context().newCDPSession(page)` returning a
// session with `.send("Target.getTargetInfo")` and `.detach()`. Minimal
// shape — nothing else from Playwright's Page surface is required.

interface MockSessionOptions {
  readonly sendShouldThrow?: Error;
  readonly targetId?: string;
  readonly targetType?: string;
}

interface MockPageOptions {
  readonly newCDPSessionShouldThrow?: Error;
  readonly session?: MockSessionOptions;
  readonly title?: string | (() => Promise<string>);
  readonly url?: string | (() => string);
}

interface MockPage {
  context: () => {
    newCDPSession: (page: unknown) => Promise<{
      send: (method: string) => Promise<unknown>;
      detach: () => Promise<void>;
    }>;
  };
  title: () => Promise<string>;
  url: () => string;
}

function makeMockPage(opts: MockPageOptions = {}): Page {
  const session = opts.session ?? {};
  const targetType = session.targetType ?? "page";
  const targetId = session.targetId ?? "TARGETID_DEADBEEF";
  // Mocks return Promises directly via `Promise.resolve` / `Promise.reject`
  // rather than `async` arrows so the linter does not flag synchronous mock
  // bodies under `useAwait`. The Page surface contract is still
  // Promise-returning either way.
  const page: MockPage = {
    url: () => (typeof opts.url === "function" ? opts.url() : (opts.url ?? "https://example.test/login")),
    title: () => {
      if (typeof opts.title === "function") {
        return opts.title();
      }
      return Promise.resolve(opts.title ?? "Sign in");
    },
    context: () => ({
      newCDPSession: (_page: unknown) => {
        if (opts.newCDPSessionShouldThrow) {
          return Promise.reject(opts.newCDPSessionShouldThrow);
        }
        return Promise.resolve({
          send: (_method: string) => {
            if (session.sendShouldThrow) {
              return Promise.reject(session.sendShouldThrow);
            }
            return Promise.resolve({ targetInfo: { targetId, type: targetType } });
          },
          detach: () => Promise.resolve(),
        });
      },
    }),
  };
  return page as Page;
}

// ─── Fake fetch / registration capture ─────────────────────────────────────
//
// We piggyback on the same fake-fetch pattern the streaming-target-registration
// suite uses: feed a queue of responses, capture every request shape so we
// can assert URL + method + headers + body. Kept inline here so the test file
// is self-contained.

interface SeenRequest {
  body: string | null;
  headers: Record<string, string>;
  method: string;
  url: string;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return (input as Request).url;
}

function makeFakeFetch(responses: Response[]): { fetchImpl: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  let cursor = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [key, value] of rawHeaders) {
          headers[key] = value;
        }
      } else {
        for (const [key, value] of Object.entries(rawHeaders)) {
          headers[key] = String(value);
        }
      }
    }
    const body = typeof init?.body === "string" ? init.body : null;
    seen.push({ body, headers, method, url });
    const next = responses[cursor++];
    if (next === undefined) {
      return Promise.reject(
        new Error(`fakeFetch: no response queued for request #${String(cursor)} (${method} ${url})`)
      );
    }
    return Promise.resolve(next);
  };
  return { fetchImpl, seen };
}

// ─── Env helpers ───────────────────────────────────────────────────────────
//
// Tests pass an explicit `env` object via the `args.env` test seam in
// `prepareManualAction` so we never mutate `process.env`. The default
// production path reads `process.env`, but this suite must not depend on
// or pollute the runner's environment.

function envWithFullStreaming(): NodeJS.ProcessEnv {
  return {
    PDPP_RUN_ID: "run_test_123",
    PDPP_REFERENCE_BASE_URL: "http://127.0.0.1:7662",
    [STREAMING_REGISTRATION_TOKEN_ENV]: "test_nonce",
    [BROWSER_CDP_HOST_ENV]: "127.0.0.1",
    [BROWSER_CDP_PORT_ENV]: "44763",
  };
}

function envWithManagedNekoSurface(): NodeJS.ProcessEnv {
  return {
    ...envWithFullStreaming(),
    [BROWSER_SURFACE_REQUIRED_ENV]: "neko",
    [BROWSER_SURFACE_LEASE_ID_ENV]: "lease_neko_123",
    [BROWSER_SURFACE_PROFILE_KEY_ENV]: "chatgpt:owner",
    [BROWSER_SURFACE_ID_ENV]: "surface_static_1",
    [BROWSER_SURFACE_STREAM_BASE_URL_ENV]: "http://neko:8080/neko",
    PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://neko:9223",
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("resolveWsUrlForExactPage composes ws:// URL from CDP targetId + host:port", async () => {
  const page = makeMockPage({ session: { targetId: "ABC123FAKEID" } });
  const wsUrl = await resolveWsUrlForExactPage(page, {
    host: "127.0.0.1",
    port: 9222,
  });
  assert.equal(wsUrl, "ws://127.0.0.1:9222/devtools/page/ABC123FAKEID");
});

test("resolveWsUrlForExactPage throws when CDP target type is not 'page'", async () => {
  const page = makeMockPage({ session: { targetType: "iframe", targetId: "X" } });
  await assert.rejects(
    () =>
      resolveWsUrlForExactPage(page, {
        host: "127.0.0.1",
        port: 9222,
      }),
    /expected page target/
  );
});

test("prepareManualAction returns { registered: false } when streaming env is missing", async () => {
  // No PDPP_RUN_ID / PDPP_REFERENCE_BASE_URL / token in env — the
  // resolveStreamingRegistrationFromEnv default returns undefined, so the
  // helper short-circuits and never touches the page or fetch.
  const page = makeMockPage();
  const result = await prepareManualAction({
    page,
    env: {},
  });
  assert.equal(result.registered, false);
  assert.match(result.interactionId, /^int_\d+_[0-9a-f]{8}$/);
});

test("prepareManualAction returns { registered: false } when streaming env present but CDP endpoint env missing", async () => {
  // Streaming side wired up (PDPP_RUN_ID + base URL + token), but the launcher
  // never published PDPP_BROWSER_CDP_HOST/PORT — typically because Patchright
  // wasn't launched in cdpPort: 0 mode. Helper must fail closed honestly.
  const page = makeMockPage();
  const env: NodeJS.ProcessEnv = {
    PDPP_RUN_ID: "run_x",
    PDPP_REFERENCE_BASE_URL: "http://127.0.0.1:7662",
    [STREAMING_REGISTRATION_TOKEN_ENV]: "tok",
  };
  const result = await prepareManualAction({
    page,
    env,
    // Override the resolveStreamingRegistration to inject a fake whose
    // register/unregister both reject. The helper must short-circuit on the
    // missing CDP endpoint env BEFORE calling either, so neither rejection
    // ever fires.
    resolveStreamingRegistration: () =>
      Promise.resolve({
        runId: "run_x",
        register: () => Promise.reject(new Error("register should not be called")),
        unregister: () => Promise.reject(new Error("unregister should not be called")),
      }),
  });
  assert.equal(result.registered, false);
});

test("prepareManualAction PUTs the composed wsUrl + page metadata when env is fully set", async () => {
  const env = envWithFullStreaming();
  const page = makeMockPage({
    url: "https://example.test/login",
    title: "Sign in",
    session: { targetId: "FAKETARGET01" },
  });
  const { fetchImpl, seen } = makeFakeFetch([new Response("{}", { status: 200 })]);

  const result = await prepareManualAction({
    page,
    reason: "captcha",
    env,
    // Inject a registration whose underlying client uses our fake fetch so
    // we can assert the wire shape. We intentionally bypass
    // `createRegistrationClient` so the test stays self-contained, but
    // mirror its wire contract: PUT with bearer auth.
    resolveStreamingRegistration: (resolveEnv) => {
      const baseUrl = resolveEnv?.PDPP_REFERENCE_BASE_URL;
      const token = resolveEnv?.[STREAMING_REGISTRATION_TOKEN_ENV] ?? resolveEnv?.[LOCAL_DEVICE_TOKEN_ENV];
      assert.ok(baseUrl, "test env should have base URL");
      assert.ok(token, "test env should have token");
      return Promise.resolve({
        runId: resolveEnv?.PDPP_RUN_ID ?? "",
        register: async (args) => {
          const url = `${baseUrl}/admin/runs/${encodeURIComponent(args.runId)}/interactions/${encodeURIComponent(args.interactionId)}/streaming-target`;
          if (args.backend === "neko") {
            assert.fail("this test covers the CDP registration path");
          }
          const body: Record<string, string> = { ws_url: args.wsUrl };
          if (args.pageUrl) {
            body.page_url = args.pageUrl;
          }
          if (args.pageTitle) {
            body.page_title = args.pageTitle;
          }
          if (args.reason) {
            body.reason = args.reason;
          }
          const res = await fetchImpl(url, {
            method: "PUT",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
          return res.ok;
        },
        unregister: () => Promise.resolve(true),
      });
    },
  });

  assert.equal(result.registered, true);
  assert.match(result.interactionId, /^int_\d+_[0-9a-f]{8}$/);
  assert.equal(seen.length, 1);
  const sent = seen[0];
  assert.ok(sent);
  assert.equal(sent.method, "PUT");
  assert.equal(sent.headers.authorization, "Bearer test_nonce");

  const parsed = sent.body ? (JSON.parse(sent.body) as Record<string, string>) : null;
  assert.ok(parsed);
  // The wsUrl shape proves that:
  //   - the resolver picked up the host:port from the CDP env vars
  //   - the targetId came from the mocked Target.getTargetInfo
  assert.equal(parsed.ws_url, "ws://127.0.0.1:44763/devtools/page/FAKETARGET01");
  assert.equal(parsed.page_url, "https://example.test/login");
  assert.equal(parsed.page_title, "Sign in");
  assert.equal(parsed.reason, "captcha");
  // The URL path uses the generated interactionId (composite key with runId).
  assert.equal(
    sent.url,
    `http://127.0.0.1:7662/admin/runs/run_test_123/interactions/${result.interactionId}/streaming-target`
  );
});

test("prepareManualAction registers managed n.eko descriptor from lease env without exposing CDP details", async () => {
  const env = envWithManagedNekoSurface();
  const page = makeMockPage({
    url: "https://example.test/login",
    title: "Sign in",
  });

  let resolveWsUrlCalled = false;
  let registeredArgs: unknown;
  const result = await prepareManualAction({
    page,
    reason: "manual_action",
    env,
    resolveWsUrl: () => {
      resolveWsUrlCalled = true;
      return Promise.reject(new Error("CDP resolver must not be called for managed n.eko"));
    },
    resolveStreamingRegistration: () =>
      Promise.resolve({
        runId: "run_test_123",
        register: (args) => {
          registeredArgs = args;
          return Promise.resolve(true);
        },
        unregister: () => Promise.resolve(true),
      }),
  });

  assert.equal(result.registered, true);
  assert.equal(resolveWsUrlCalled, false);
  assert.ok(registeredArgs && typeof registeredArgs === "object");
  const args = registeredArgs as {
    backend?: string;
    descriptor?: Record<string, unknown>;
    pageTitle?: string;
    pageUrl?: string;
    reason?: string;
  };
  assert.equal(args.backend, "neko");
  assert.deepEqual(args.descriptor, {
    backend: "neko",
    base_url: "http://neko:8080/neko",
    lease_id: "lease_neko_123",
    profile_key: "chatgpt:owner",
    surface_id: "surface_static_1",
    start_url: "https://example.test/login",
  });
  assert.equal(args.pageUrl, "https://example.test/login");
  assert.equal(args.pageTitle, "Sign in");
  assert.equal(args.reason, "manual_action");
  assert.equal(JSON.stringify(args).includes("9223"), false, "raw CDP URL must not be registered");
  assert.equal(JSON.stringify(args).includes("REMOTE_CDP"), false, "CDP env key must not be registered");
});

test("prepareManualAction registers managed n.eko descriptor without CDP host/port env", async () => {
  const env = envWithManagedNekoSurface();
  delete env[BROWSER_CDP_HOST_ENV];
  delete env[BROWSER_CDP_PORT_ENV];

  let registeredArgs: unknown;
  const result = await prepareManualAction({
    page: makeMockPage(),
    env,
    resolveWsUrl: () => Promise.reject(new Error("CDP resolver must not be called for managed n.eko")),
    resolveStreamingRegistration: () =>
      Promise.resolve({
        runId: "run_test_123",
        register: (args) => {
          registeredArgs = args;
          return Promise.resolve(true);
        },
        unregister: () => Promise.resolve(true),
      }),
  });

  assert.equal(result.registered, true);
  assert.ok(registeredArgs && typeof registeredArgs === "object");
  assert.equal((registeredArgs as { backend?: string }).backend, "neko");
});

test("prepareManualAction does not fall back to CDP registration when managed n.eko descriptor env is incomplete", async () => {
  const env = {
    ...envWithFullStreaming(),
    [BROWSER_SURFACE_REQUIRED_ENV]: "neko",
    [BROWSER_SURFACE_LEASE_ID_ENV]: "lease_neko_123",
    [BROWSER_SURFACE_PROFILE_KEY_ENV]: "chatgpt:owner",
    PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://neko:9223",
  };
  let registerCalled = false;
  let resolveWsUrlCalled = false;

  const result = await prepareManualAction({
    page: makeMockPage(),
    env,
    resolveWsUrl: () => {
      resolveWsUrlCalled = true;
      return Promise.resolve("ws://127.0.0.1:44763/devtools/page/SHOULD_NOT_REGISTER");
    },
    resolveStreamingRegistration: () =>
      Promise.resolve({
        runId: "run_test_123",
        register: () => {
          registerCalled = true;
          return Promise.resolve(true);
        },
        unregister: () => Promise.resolve(true),
      }),
  });

  assert.equal(result.registered, false);
  assert.equal(registerCalled, false);
  assert.equal(resolveWsUrlCalled, false);
});

test("prepareManualAction returns { registered: false } and does NOT throw when newCDPSession throws (page closed)", async () => {
  const env = envWithFullStreaming();
  // Mirror the spike's case 5: page closed before the resolver could attach.
  // Playwright surfaces a stable error along the lines of
  // "browserContext.newCDPSession: page: no object with guid …"; the helper
  // must catch and return registered:false without throwing.
  const page = makeMockPage({
    newCDPSessionShouldThrow: new Error("browserContext.newCDPSession: page: no object with guid page@abc"),
  });

  let registerCalled = false;
  const result = await prepareManualAction({
    page,
    env,
    resolveStreamingRegistration: () =>
      Promise.resolve({
        runId: "run_test_123",
        register: () => {
          registerCalled = true;
          return Promise.resolve(true);
        },
        unregister: () => Promise.resolve(true),
      }),
  });

  assert.equal(result.registered, false);
  assert.equal(registerCalled, false, "register must not be called when wsUrl resolution fails");
  assert.match(result.interactionId, /^int_\d+_[0-9a-f]{8}$/);
});

test("prepareManualAction returns { registered: false } when registration POST fails (network/HTTP)", async () => {
  const env = envWithFullStreaming();
  const page = makeMockPage();
  const result = await prepareManualAction({
    page,
    env,
    resolveStreamingRegistration: () =>
      Promise.resolve({
        runId: "run_test_123",
        register: () => Promise.resolve(false), // server returned non-2xx OR network failed
        unregister: () => Promise.resolve(true),
      }),
  });
  assert.equal(result.registered, false);
  // interactionId is still produced — the connector still emits the INTERACTION
  // envelope; only the streaming surface is unavailable for it.
  assert.match(result.interactionId, /^int_\d+_[0-9a-f]{8}$/);
});

test("manualAction calls sendInteraction with kind=manual_action and the generated interactionId as request_id", async () => {
  const page = makeMockPage();
  const seenInteractions: InteractionRequest[] = [];
  const sendInteraction: SendInteraction = (req) => {
    seenInteractions.push(req);
    const response: InteractionResponse = {
      type: "INTERACTION_RESPONSE",
      request_id: req.request_id ?? "",
      status: "success",
      data: { ok: "1" },
    };
    return Promise.resolve(response);
  };

  const response = await manualAction(
    {
      page,
      message: "Solve the captcha and continue.",
      reason: "captcha",
      timeoutSeconds: 1800,
      env: {}, // no streaming env — manualAction still emits the INTERACTION
    },
    sendInteraction
  );

  assert.equal(seenInteractions.length, 1);
  const sent = seenInteractions[0];
  assert.ok(sent);
  assert.equal(sent.kind, "manual_action");
  assert.equal(sent.message, "Solve the captcha and continue.");
  assert.equal(sent.timeout_seconds, 1800);
  assert.match(sent.request_id ?? "", /^int_\d+_[0-9a-f]{8}$/);
  // Response is whatever sendInteraction returned, with the same request_id.
  assert.equal(response.status, "success");
  assert.equal(response.request_id, sent.request_id);
});

test("manualAction passes optional schema through to sendInteraction", async () => {
  const page = makeMockPage();
  const schema = { type: "object", properties: { ok: { type: "string" } } } as const;
  let received: InteractionRequest | undefined;
  const sendInteraction: SendInteraction = (req) => {
    received = req;
    return Promise.resolve({
      type: "INTERACTION_RESPONSE",
      request_id: req.request_id ?? "",
      status: "success",
    });
  };
  await manualAction(
    {
      page,
      message: "Continue when ready.",
      schema,
      env: {},
    },
    sendInteraction
  );
  assert.deepEqual(received?.schema, schema);
});

test("manualAction omits schema/timeout when not provided", async () => {
  const page = makeMockPage();
  let received: InteractionRequest | undefined;
  const sendInteraction: SendInteraction = (req) => {
    received = req;
    return Promise.resolve({
      type: "INTERACTION_RESPONSE",
      request_id: req.request_id ?? "",
      status: "success",
    });
  };
  await manualAction(
    {
      page,
      message: "Click continue.",
      env: {},
    },
    sendInteraction
  );
  assert.equal(received?.schema, undefined);
  assert.equal(received?.timeout_seconds, undefined);
});
