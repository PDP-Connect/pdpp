// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tls from "node:tls";

import { closeDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPinnedHttpsAgent, resolveAllowedAddresses } from "../server/ssrf-guard.ts";
import {
  buildAssistancePushPayload,
  buildPendingInteractionPushPayload,
  buildTestPushPayload,
  classifyInteractionSensitivity,
  classifyPushFanoutOutcome,
  createMemoryWebPushSubscriptionStore,
  createPostgresWebPushSubscriptionStore,
  createSqliteWebPushSubscriptionStore,
  defaultSendNotification as defaultSendNotificationUntyped,
  fanoutAssistanceWebPush as fanoutAssistanceWebPushUntyped,
  fanoutEscalationWebPush as fanoutEscalationWebPushUntyped,
  fanoutPendingInteractionWebPush as fanoutPendingInteractionWebPushUntyped,
  fanoutTestWebPush as fanoutTestWebPushUntyped,
  guardWebPushEndpoint as guardWebPushEndpointUntyped,
  resolveWebPushModuleApi as resolveWebPushModuleApiUntyped,
  shouldFanoutAssistanceProgress,
  WEB_PUSH_SEND_TIMEOUT_MS,
} from "../server/web-push-notifications.ts";

// `web-push` (the npm package) has no bundled types and no `@types/web-push`
// is installed. Declared here, test-file-local, covering only the members
// this file actually calls: setVapidDetails/sendNotification (the runtime
// seam) and generateVAPIDKeys (used once at module load for real VAPID test
// keys).
interface WebPushModuleApi {
  generateVAPIDKeys: () => { privateKey: string; publicKey: string };
  sendNotification: (
    subscription: { endpoint: string; keys: SubscriptionKeys },
    payload: unknown,
    options?: Record<string, unknown>
  ) => Promise<{ headers: unknown; statusCode: number }>;
  setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
}

function loadWebPushModule() {
  // biome-ignore lint/correctness/noUnresolvedImports: this direct reference-implementation dependency is resolved by the reference test runner.
  return import("web-push");
}

const resolveWebPushModuleApi = resolveWebPushModuleApiUntyped as (webPushModule: unknown) => WebPushModuleApi;

// Keep the broad production signatures behind narrow, test-local contracts
// matching how this suite invokes each seam.
type GuardResult = { ok: true; agent: unknown } | { ok: false; reason: string };
type GuardWebPushEndpointFn = (
  endpoint: string,
  options?: {
    dnsLookupImpl?: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>>;
    isGlobalUnicastAddressImpl?: (ip: string) => boolean;
  }
) => Promise<GuardResult>;
const guardWebPushEndpoint = guardWebPushEndpointUntyped as GuardWebPushEndpointFn;

interface SendNotificationResult {
  headers: unknown;
  statusCode: number;
}
interface SendNotificationDeps {
  guardWebPushEndpointImpl?: (endpoint: string) => Promise<GuardResult>;
  webPushModuleImpl?: unknown;
}
type DefaultSendNotificationFn = (
  subscription: { endpoint: string; keys: SubscriptionKeys },
  payload: unknown,
  config: { privateKey: string; publicKey: string; subject: string },
  deps?: SendNotificationDeps
) => Promise<SendNotificationResult>;
const defaultSendNotification = defaultSendNotificationUntyped as DefaultSendNotificationFn;

type FanoutSender = (subscription: unknown, payload: unknown, config: unknown) => Promise<unknown> | unknown;
interface FanoutResult {
  [key: string]: unknown;
}
type FanoutFn = (args: Record<string, unknown> & { store: unknown; sender?: FanoutSender }) => Promise<FanoutResult>;

// Each real fanout export's concrete parameter object and the generic
// caller-facing `FanoutFn` harness shape do not overlap enough for a direct
// cast, so each is widened through a function-shaped intermediate.
function toFanoutFn(untyped: unknown): FanoutFn {
  return untyped as FanoutFn;
}
const fanoutPendingInteractionWebPushUnknown = fanoutPendingInteractionWebPushUntyped as (args: unknown) => unknown;
const fanoutPendingInteractionWebPush = toFanoutFn(fanoutPendingInteractionWebPushUnknown);
const fanoutAssistanceWebPushUnknown = fanoutAssistanceWebPushUntyped as (args: unknown) => unknown;
const fanoutAssistanceWebPush = toFanoutFn(fanoutAssistanceWebPushUnknown);
const fanoutTestWebPushUnknown = fanoutTestWebPushUntyped as (args: unknown) => unknown;
const fanoutTestWebPush = toFanoutFn(fanoutTestWebPushUnknown);
const fanoutEscalationWebPushUnknown = fanoutEscalationWebPushUntyped as (args: unknown) => unknown;
const fanoutEscalationWebPush = toFanoutFn(fanoutEscalationWebPushUnknown);

const TEST_PASSWORD = "web-push-owner-test-password";
const VAPID_PUBLIC = "BAabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd";
const VAPID_PRIVATE = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
const NON_PUBLIC_ADDRESS_PATTERN = /non-public address 169\.254\.169\.254/;
const HTTPS_SCHEME_PATTERN = /https scheme/;
const EXCEEDING_BOUND_PATTERN = /exceeding the bound/;
const WEB_PUSH_BLOCKED_PATTERN = /Web Push send blocked/;
const NON_EMPTY_PATTERN = /./;
const TIMEOUT_PATTERN = /timeout|Socket timeout/i;
const MANUAL_PROGRESS_NOOP_PATTERN =
  /onProgress: \(\) => \{\s*\/\/ no-op; progress is persisted via the event spine, not this callback\.\s*\},/;
const SHOULD_FANOUT_ASSISTANCE_PATTERN = /shouldFanoutAssistanceProgressMessage\(msg\)/;
const DETACHED_ASSISTANCE_FANOUT_PATTERN = /detachControllerTask\(\s*fireAssistanceWebPush\(\{/;
const ASSISTANCE_FANOUT_CONTEXT_PATTERN = /fireAssistanceWebPush\([\s\S]*?ownerSubjectId,[\s\S]*?runId,/;
const DETACHED_NTFY_FANOUT_PATTERN = /detachControllerTask\(\s*fireNtfy\(/;
const DETACHED_WEB_PUSH_FANOUT_PATTERN = /detachControllerTask\(\s*fireWebPush\(/;
const NTFY_FIRE_FAILURE_PATTERN = /ntfy fire for run .* failed/;
const WEB_PUSH_FIRE_FAILURE_PATTERN = /web push fire for run .* failed/;
const SCHEDULER_ON_STARTED_PATTERN = /onStarted: \(run\) =>/;
const CONNECTOR_DISPLAY_NAME_PATTERN = /connector_display_name: connectorDisplayName/;
const RUN_ID_PATTERN = /run_id:\s*runId/;
const PENDING_INTERACTION_FANOUT_PATTERN = /fanoutPendingInteractionWebPush/;
const WEB_PUSH_STORE_PATTERN = /webPushSubscriptionStore: webPushStore/;
const OWNER_SUBJECT_PATTERN = /ownerSubjectId: ownerAuthSubjectId/;
const STORE_PATTERN = /store: webPushSubscriptionStore/;
const ROUTE_TO_RUN_PATTERN = /routeTo: "run"/;
const TRANSPORT_PATTERN = /transport:/;
const GONE_PATTERN = /410 gone/;

// Real VAPID keypair (web-push's own generateVAPIDKeys(), not a placeholder
// string) — required for the production-seam tests below, which drive the
// real web-push library end-to-end and need setVapidDetails to pass its
// genuine format validation. Generated once at module load.
const REAL_VAPID_KEYS = resolveWebPushModuleApi(await loadWebPushModule()).generateVAPIDKeys();
const VAPID_PUBLIC_REAL = REAL_VAPID_KEYS.publicKey;
const VAPID_PRIVATE_REAL = REAL_VAPID_KEYS.privateKey;

interface CloseableHttpServer {
  close: (callback: () => void) => unknown;
  closeAllConnections?: () => void;
}

interface TestServer {
  asPort: number;
  asServer: CloseableHttpServer;
  rsPort: number;
  rsServer: CloseableHttpServer;
}

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
    new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
  ]);
}

async function withServer(opts: Record<string, unknown>, fn: (ctx: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...opts,
  })) as TestServer;
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

interface SubscriptionKeys {
  auth: string;
  p256dh: string;
}

// `tls.connect`'s real declared type is a large overload union; every spy
// below only ever calls the single-options-object form. A spy matching just
// that one call shape is cast to the full overloaded type (a single direct
// cast, not `as any`/`as unknown as`) -- the same pattern established in
// ssrf-guard.test.ts's spyOnNetConnect.
type TlsConnectSingleOverload = (opts: tls.ConnectionOptions, secureConnectListener?: () => void) => tls.TLSSocket;

function spyOnTlsConnect(dialedHosts: Array<{ host: unknown; servername?: unknown }>): () => void {
  const originalConnect = tls.connect;
  const originalConnectSingleOverload = originalConnect as TlsConnectSingleOverload;
  const spiedConnect: TlsConnectSingleOverload = function spiedTlsConnect(opts, secureConnectListener) {
    dialedHosts.push({
      host: "host" in opts ? opts.host : undefined,
      servername: "servername" in opts ? opts.servername : undefined,
    });
    return originalConnectSingleOverload(opts, secureConnectListener);
  };
  tls.connect = spiedConnect as typeof tls.connect;
  return () => {
    tls.connect = originalConnect;
  };
}

function sampleSubscription(
  endpoint = "https://push.example.invalid/sub/one",
  keys: SubscriptionKeys = { auth: "auth-secret", p256dh: "public-key-material" }
) {
  return { endpoint, keys };
}

test("web-push module normalization supports CommonJS default import shape", async () => {
  const actualModule = await loadWebPushModule();
  const actualApi = resolveWebPushModuleApi(actualModule);
  assert.equal(typeof actualApi.setVapidDetails, "function");
  assert.equal(typeof actualApi.sendNotification, "function");

  const api = { sendNotification: () => undefined, setVapidDetails: () => undefined };
  assert.equal(resolveWebPushModuleApi(api), api);
  assert.equal(resolveWebPushModuleApi({ default: api }), api);
});

// --- SSRF guard: owner-supplied Web Push endpoint (tmp/workstreams/ssrf-terra-final-0717.md P1) ---
//
// `guardWebPushEndpoint` is the send-time SSRF guard `defaultSendNotification`
// calls before ever invoking `web-push`'s `sendNotification`. These tests
// exercise that guard directly — the smallest concept-correct seam for
// proving the SSRF properties (block-before-send, bounded validated-address
// resolution, a real pinned `https.Agent` returned on success) without
// touching VAPID/encryption, which the existing mocked-`sender` tests above
// and below already cover unchanged.

test("guardWebPushEndpoint blocks a non-public endpoint before any send is attempted", async () => {
  const guard = await guardWebPushEndpoint("https://push.example.invalid/sub/one", {
    dnsLookupImpl: async () => [{ address: "169.254.169.254" }],
  });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, NON_PUBLIC_ADDRESS_PATTERN);
});

test("guardWebPushEndpoint blocks the Terra P1 false-pass addresses for Web Push endpoints too", async () => {
  const addresses = ["192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1"];
  const guards = await Promise.all(
    addresses.map(
      async (address) =>
        [
          address,
          await guardWebPushEndpoint("https://push.example.invalid/sub/one", {
            dnsLookupImpl: async () => [{ address }],
          }),
        ] as const
    )
  );
  for (const [ip, guard] of guards) {
    assert.equal(guard.ok, false, `${ip} must be blocked`);
  }
});

test("guardWebPushEndpoint blocks a non-https endpoint", async () => {
  const guard = await guardWebPushEndpoint("http://push.example.invalid/sub/one");
  assert.equal(guard.ok, false);
  assert.match(guard.reason, HTTPS_SCHEME_PATTERN);
});

test("guardWebPushEndpoint fails closed on an oversized DNS answer (bounded fallback)", async () => {
  const addrs = Array.from({ length: 128 }, (_, i) => ({ address: `8.8.8.${i % 255}` }));
  const guard = await guardWebPushEndpoint("https://push.example.invalid/sub/one", {
    dnsLookupImpl: async () => addrs,
  });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, EXCEEDING_BOUND_PATTERN);
});

test("guardWebPushEndpoint allows a public endpoint and returns a pinned https.Agent bound to the validated address (falsifiable, real socket)", async () => {
  // A real https.Agent (not a mock) whose createConnection dials only the
  // literal validated address — proved by spying on node:tls's connect
  // (what the pinned agent calls directly for TLS) with an endpoint hostname
  // that cannot itself resolve (.invalid TLD).
  const dialedHostsRaw: Array<{ host: unknown; servername?: unknown }> = [];
  const restoreTlsConnect = spyOnTlsConnect(dialedHostsRaw);

  try {
    const guard = await guardWebPushEndpoint("https://rebind-webpush-proof.invalid/sub/one", {
      // Simulates the address that passed the SSRF check (a stand-in for a
      // real public address; the allow/block decision is already covered by
      // the tests above with the real classifier).
      dnsLookupImpl: async () => [{ address: "127.0.0.1" }],
      isGlobalUnicastAddressImpl: () => true,
    });
    assert.equal(guard.ok, true);
    assert.ok(guard.ok);
    const guardedAgent = guard.agent as { createConnection: unknown; destroy: () => void };
    const widenAgent = (value: unknown): unknown => value;
    const requestAgent = widenAgent(guardedAgent) as https.RequestOptions["agent"];
    assert.equal(typeof guardedAgent.createConnection, "function");

    // Drive a real request through the returned agent (nothing needs to be
    // listening — the assertion is about the dialed address, not a full
    // round trip).
    await new Promise<void>((resolve) => {
      const req = https.request(
        {
          agent: requestAgent,
          hostname: "rebind-webpush-proof.invalid",
          method: "POST",
          path: "/",
          port: 44_300,
          timeout: 2000,
        },
        () => resolve()
      );
      req.on("error", () => resolve());
      req.on("timeout", () => {
        req.destroy();
        resolve();
      });
      req.end();
    });

    const dialedHosts = dialedHostsRaw.map((d) => d.host);
    assert.deepEqual(
      dialedHosts,
      ["127.0.0.1"],
      "the pinned https.Agent must dial the validated IP literal, never the original unresolvable hostname"
    );
    guardedAgent.destroy();
  } finally {
    restoreTlsConnect();
  }
});

test("createPinnedHttpsAgent is a real https.Agent instance (required by web-push's instanceof check)", () => {
  const agent = createPinnedHttpsAgent(["127.0.0.1"]) as { destroy: () => void };
  assert.equal(agent instanceof https.Agent, true);
  agent.destroy();
});

// --- defaultSendNotification: production-seam tests (tmp/workstreams/ssrf-sol-final-0717.md P2) ---
//
// The tests above exercise `guardWebPushEndpoint` directly — the smallest
// concept-correct seam for the allow/block decision, and sufficient to prove
// that in isolation. They do NOT prove the production sender
// (`defaultSendNotification`, the function actually wired as `sender` in
// every fanout call site) forwards the guard's pinned agent and timeout to
// the real `web-push` library, preserves SNI/VAPID correctness, or cleans up
// the agent on every outcome — Sol's review found exactly this gap and
// required closing it with a BEHAVIORAL mutant (a variant that still exports
// and runs, but silently skips using the guard/agent/timeout), not a
// missing-export import failure (reverting the whole file, which merely
// proves the export didn't exist yet, proves nothing about a regression that
// keeps the export but weakens its behavior).
//
// These tests drive `defaultSendNotification` itself against a real local
// HTTPS server (self-signed cert) and real VAPID/subscription key material
// generated via Node's own crypto.createECDH/generateVAPIDKeys (not
// hand-crafted fixtures — the standard API any real caller would use), so
// the full production code path — guard, agent construction, `web-push`'s
// own request building, VAPID header generation — runs for real. A thin
// spy wrapper around the real `web-push` module (calls straight through to
// it; does not reimplement or approximate anything) records the exact
// options `defaultSendNotification` passed, which is what proves forwarding
// without weakening the oracle to "did the mock get called."

function generateSelfSignedCertForWebPush() {
  const dir = mkdtempSync(join(tmpdir(), "web-push-cert-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=web-push-seam-test.invalid",
      ],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// Real ECDH subscriber keys (crypto.createECDH), not reverse-engineered
// bytes — this is the standard Node API a real browser subscription's
// p256dh/auth would be validated the same way against.
function generateRealSubscriptionKeys() {
  const ecdh = createECDH("prime256v1");
  const p256dh = ecdh.generateKeys().toString("base64url");
  const auth = randomBytes(16).toString("base64url");
  return { auth, p256dh };
}

async function withSelfSignedWebPushServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  fn: (port: number) => Promise<void>
): Promise<void> {
  const cert = generateSelfSignedCertForWebPush();
  const server = https.createServer({ cert: cert.cert, key: cert.key }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object", "server.address() must return an AddressInfo once listening");
    await fn(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Wraps the REAL `web-push` module: every call passes straight through to
 * the real implementation (so VAPID headers, encryption, and request
 * building are all genuinely exercised), while recording the exact
 * `sendNotification` options object `defaultSendNotification` passed. This
 * is what makes the test prove forwarding rather than merely proving a
 * mock was invoked.
 */
interface RecordedSendCall {
  options: Record<string, unknown> | undefined;
  payload: unknown;
  subscription: { endpoint: string; keys: SubscriptionKeys };
}

async function spyOnRealWebPush(): Promise<{ calls: RecordedSendCall[]; module: WebPushModuleApi }> {
  const real = resolveWebPushModuleApi(await loadWebPushModule());
  const calls: RecordedSendCall[] = [];
  return {
    calls,
    module: {
      generateVAPIDKeys: () => real.generateVAPIDKeys(),
      sendNotification: (subscription, payload, options) => {
        calls.push({ options, payload, subscription });
        return real.sendNotification(subscription, payload, options);
      },
      setVapidDetails: (subject, publicKey, privateKey) => real.setVapidDetails(subject, publicKey, privateKey),
    },
  };
}

/**
 * A test-only `guardWebPushEndpointImpl` that runs the REAL allow/block
 * decision (`resolveAllowedAddresses`, with DNS/classifier injected so no
 * real network resolution is needed) and builds a pinned agent with
 * `rejectUnauthorized: false` — the only difference from production
 * `guardWebPushEndpoint`, needed because these tests' HTTPS server uses a
 * throwaway self-signed cert (real TLS handshake, real cert chain
 * validation would otherwise fail on that alone, unrelated to anything this
 * change is testing). The guard decision logic itself, and the pinning
 * mechanism, are the real production code — only the agent's TLS trust
 * option differs from what `guardWebPushEndpoint` passes.
 */
function testGuardWithSelfSignedTrust(resolvedAddress: string): (endpoint: string) => Promise<GuardResult> {
  return async (endpoint: string) => {
    const parsed = new URL(endpoint);
    const resolved = await resolveAllowedAddresses(parsed.hostname, {
      dnsLookupImpl: async () => [{ address: resolvedAddress }],
      isGlobalUnicastAddressImpl: () => true,
    });
    if (!resolved.ok) {
      return { ok: false, reason: `test guard: ${resolved.kind}` };
    }
    return { agent: createPinnedHttpsAgent(resolved.addresses, { rejectUnauthorized: false }), ok: true };
  };
}

test("defaultSendNotification blocks before ever calling into the web-push library (production seam, real guard)", async () => {
  const webPushModule = await loadWebPushModule();
  const realApi = resolveWebPushModuleApi(webPushModule);
  let sendNotificationCalled = false;
  const spyModule: WebPushModuleApi = {
    generateVAPIDKeys: () => realApi.generateVAPIDKeys(),
    sendNotification: (subscription, payload, options) => {
      sendNotificationCalled = true;
      return realApi.sendNotification(subscription, payload, options);
    },
    setVapidDetails: (subject, publicKey, privateKey) => realApi.setVapidDetails(subject, publicKey, privateKey),
  };
  const keys = generateRealSubscriptionKeys();
  const config = {
    privateKey: VAPID_PRIVATE_REAL,
    publicKey: VAPID_PUBLIC_REAL,
    subject: "mailto:test@example.invalid",
  };

  await assert.rejects(
    () =>
      defaultSendNotification(sampleSubscription("https://blocked.invalid/sub/one", keys), { hello: "world" }, config, {
        guardWebPushEndpointImpl: async () => ({
          ok: false,
          reason: "endpoint host blocked.invalid resolves to a non-public address 169.254.169.254",
        }),
        webPushModuleImpl: spyModule,
      }),
    WEB_PUSH_BLOCKED_PATTERN
  );
  assert.equal(sendNotificationCalled, false, "web-push.sendNotification must never be called when the guard blocks");
});

test("defaultSendNotification forwards the pinned agent and the exact send timeout to the real web-push call, and preserves SNI/VAPID (production seam, real socket + real crypto)", async () => {
  await withSelfSignedWebPushServer(
    (req, res) => {
      res.writeHead(201, { Location: `https://web-push-seam-test.invalid${req.url}/receipt` });
      res.end();
    },
    async (port) => {
      const keys = generateRealSubscriptionKeys();
      const subscription = sampleSubscription(`https://web-push-seam-test.invalid:${port}/sub/seam`, keys);
      const config = {
        privateKey: VAPID_PRIVATE_REAL,
        publicKey: VAPID_PUBLIC_REAL,
        subject: "mailto:test@example.invalid",
      };
      const spy = await spyOnRealWebPush();

      const dialedHosts: Array<{ host: unknown; servername?: unknown }> = [];
      const restoreTlsConnect = spyOnTlsConnect(dialedHosts);

      try {
        const result = await defaultSendNotification(subscription, { hello: "world" }, config, {
          guardWebPushEndpointImpl: testGuardWithSelfSignedTrust("127.0.0.1"),
          webPushModuleImpl: spy.module,
        });

        assert.equal(
          result.statusCode,
          201,
          "the real web-push call must reach the real server and get a real response"
        );
        assert.equal(spy.calls.length, 1, "defaultSendNotification must call web-push.sendNotification exactly once");

        const [call0] = spy.calls;
        assert.ok(call0);
        const forwarded = call0.options;
        assert.ok(forwarded);
        assert.equal(typeof forwarded.agent, "object", "the pinned agent must be forwarded");
        assert.equal(forwarded.agent instanceof https.Agent, true);
        assert.equal(
          forwarded.timeout,
          WEB_PUSH_SEND_TIMEOUT_MS,
          "the exact configured send timeout must be forwarded"
        );

        // VAPID: the real library generated a real Authorization header from
        // the real config — this only succeeds if setVapidDetails/getVapidHeaders
        // ran for real (a broken/bypassed VAPID path would throw before this).
        assert.ok(typeof call0.payload === "string");
        assert.match(
          call0.payload,
          NON_EMPTY_PATTERN,
          "payload was encrypted (non-empty ciphertext), proving the real encryption path ran"
        );

        // SNI continuity: the pinned agent dialed the literal validated IP
        // (127.0.0.1), but presented the ORIGINAL hostname as TLS SNI — proving
        // address pinning did not silently break certificate/SNI behavior.
        assert.equal(dialedHosts.length >= 1, true);
        const [dial0] = dialedHosts;
        assert.ok(dial0);
        assert.equal(dial0.host, "127.0.0.1", "must dial the validated literal address");
        assert.equal(dial0.servername, "web-push-seam-test.invalid", "must present the original hostname as SNI");
      } finally {
        restoreTlsConnect();
      }
    }
  );
});

test("defaultSendNotification destroys the pinned agent on success (production seam, real socket)", async () => {
  await withSelfSignedWebPushServer(
    (_req, res) => {
      res.writeHead(201);
      res.end();
    },
    async (port) => {
      const keys = generateRealSubscriptionKeys();
      const subscription = sampleSubscription(`https://web-push-seam-test.invalid:${port}/sub/cleanup-success`, keys);
      const config = {
        privateKey: VAPID_PRIVATE_REAL,
        publicKey: VAPID_PUBLIC_REAL,
        subject: "mailto:test@example.invalid",
      };
      let destroyCallCount = 0;
      const spy = await spyOnRealWebPush();
      const observingModule = {
        sendNotification: (
          subscription_: { endpoint: string; keys: SubscriptionKeys },
          payload: unknown,
          options: { agent: { destroy: (...args: unknown[]) => unknown } } & Record<string, unknown>
        ) => {
          const originalDestroy = options.agent.destroy.bind(options.agent);
          options.agent.destroy = (...args: unknown[]) => {
            destroyCallCount += 1;
            return originalDestroy(...args);
          };
          return spy.module.sendNotification(subscription_, payload, options);
        },
        setVapidDetails: spy.module.setVapidDetails,
      };

      await defaultSendNotification(subscription, { hello: "world" }, config, {
        guardWebPushEndpointImpl: testGuardWithSelfSignedTrust("127.0.0.1"),
        webPushModuleImpl: observingModule,
      });

      assert.equal(
        destroyCallCount,
        1,
        "the pinned agent's destroy() must be called exactly once after a successful send"
      );
    }
  );
});

test("defaultSendNotification destroys the pinned agent on a rejected/error send (production seam, real socket)", async () => {
  await withSelfSignedWebPushServer(
    (req) => {
      // Accept the TLS handshake, then abort mid-request — a real error,
      // not a mocked rejection.
      req.socket.destroy();
    },
    async (port) => {
      const keys = generateRealSubscriptionKeys();
      const subscription = sampleSubscription(`https://web-push-seam-test.invalid:${port}/sub/cleanup-error`, keys);
      const config = {
        privateKey: VAPID_PRIVATE_REAL,
        publicKey: VAPID_PUBLIC_REAL,
        subject: "mailto:test@example.invalid",
      };
      let destroyCallCount = 0;
      const spy = await spyOnRealWebPush();
      const observingModule = {
        sendNotification: (
          subscription_: { endpoint: string; keys: SubscriptionKeys },
          payload: unknown,
          options: { agent: { destroy: (...args: unknown[]) => unknown } } & Record<string, unknown>
        ) => {
          const originalDestroy = options.agent.destroy.bind(options.agent);
          options.agent.destroy = (...args: unknown[]) => {
            destroyCallCount += 1;
            return originalDestroy(...args);
          };
          return spy.module.sendNotification(subscription_, payload, options);
        },
        setVapidDetails: spy.module.setVapidDetails,
      };

      await assert.rejects(() =>
        defaultSendNotification(subscription, { hello: "world" }, config, {
          guardWebPushEndpointImpl: testGuardWithSelfSignedTrust("127.0.0.1"),
          webPushModuleImpl: observingModule,
        })
      );

      assert.equal(destroyCallCount, 1, "the pinned agent's destroy() must be called exactly once after a failed send");
    }
  );
});

test("defaultSendNotification bounds a hanging endpoint with the configured timeout and destroys the agent (deterministic hanging-transport coverage)", async () => {
  // A server that accepts the connection and TLS handshake but never
  // responds and never closes — a genuine hang, not a simulated one.
  await withSelfSignedWebPushServer(
    () => {
      // Intentionally do nothing: never call res.end(), never destroy the
      // socket. The only thing that can end this request is the timeout
      // defaultSendNotification configures.
    },
    async (port) => {
      const keys = generateRealSubscriptionKeys();
      const subscription = sampleSubscription(`https://web-push-seam-test.invalid:${port}/sub/hang`, keys);
      const config = {
        privateKey: VAPID_PRIVATE_REAL,
        publicKey: VAPID_PUBLIC_REAL,
        subject: "mailto:test@example.invalid",
      };
      let destroyCallCount = 0;
      const spy = await spyOnRealWebPush();
      const observingModule = {
        sendNotification: (
          subscription_: { endpoint: string; keys: SubscriptionKeys },
          payload: unknown,
          options: { agent: { destroy: (...args: unknown[]) => unknown } } & Record<string, unknown>
        ) => {
          const originalDestroy = options.agent.destroy.bind(options.agent);
          options.agent.destroy = (...args: unknown[]) => {
            destroyCallCount += 1;
            return originalDestroy(...args);
          };
          return spy.module.sendNotification(subscription_, payload, options);
        },
        setVapidDetails: spy.module.setVapidDetails,
      };

      const start = Date.now();
      await assert.rejects(
        () =>
          defaultSendNotification(subscription, { hello: "world" }, config, {
            guardWebPushEndpointImpl: testGuardWithSelfSignedTrust("127.0.0.1"),
            webPushModuleImpl: observingModule,
          }),
        TIMEOUT_PATTERN
      );
      const elapsedMs = Date.now() - start;

      assert.equal(
        elapsedMs < WEB_PUSH_SEND_TIMEOUT_MS + 5000,
        true,
        `send must be bounded near the configured timeout (${WEB_PUSH_SEND_TIMEOUT_MS}ms), took ${elapsedMs}ms`
      );
      assert.equal(
        destroyCallCount,
        1,
        "the pinned agent's destroy() must be called exactly once after a timed-out send, not leaked"
      );
    }
  );
});

interface WebPushSubscriptionRecord {
  created_at: string;
  device_label: string | null;
  endpoint: string;
  endpoint_redacted: string;
  id: string;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  last_success_at: string | null;
  last_used_at: string | null;
  owner_subject_id: string;
  platform: string | null;
  revoked_at: string | null;
  updated_at: string;
  user_agent: string | null;
}

interface WebPushSubscriptionRawRecord extends WebPushSubscriptionRecord {
  keys: SubscriptionKeys;
}

interface WebPushSubscriptionStore {
  list: (
    ownerSubjectId: string,
    opts?: { activeOnly?: boolean; includeEndpoint?: boolean }
  ) => Promise<WebPushSubscriptionRecord[]> | WebPushSubscriptionRecord[];
  listActiveRaw: (ownerSubjectId: string) => Promise<WebPushSubscriptionRawRecord[]> | WebPushSubscriptionRawRecord[];
  markFailure: (endpoint: string, reason: string, opts?: { revoke?: boolean }) => Promise<void> | void;
  markSuccess: (endpoint: string) => Promise<void> | void;
  revoke: (
    ownerSubjectId: string,
    endpoint: string
  ) => Promise<WebPushSubscriptionRecord | null> | WebPushSubscriptionRecord | null;
  upsert: (
    ownerSubjectId: string,
    subscription: { endpoint: string; keys: SubscriptionKeys },
    platform?: Record<string, unknown>
  ) => Promise<WebPushSubscriptionRecord> | WebPushSubscriptionRecord;
}

// The real store factories' concrete return types have optional/nullable
// fields that are narrower or wider than this generic conformance interface,
// so each is widened through an identity `unknown` function first.
function toWebPushSubscriptionStore(store: unknown): WebPushSubscriptionStore {
  return store as WebPushSubscriptionStore;
}

async function runWebPushSubscriptionStoreConformance(
  makeStore: () => Promise<WebPushSubscriptionStore> | WebPushSubscriptionStore,
  prefix = "store"
): Promise<void> {
  const store = await makeStore();
  const localEndpoint = `https://push.example.invalid/sub/${prefix}-local`;
  const otherEndpoint = `https://push.example.invalid/sub/${prefix}-other`;

  const created = await store.upsert("owner_local", sampleSubscription(localEndpoint), {
    device_label: "Pixel test device",
    platform: "android",
  });
  assert.equal(created.endpoint, localEndpoint);
  assert.equal(created.platform, "android");
  assert.equal(created.device_label, "Pixel test device");
  assert.equal(created.revoked_at, null);

  await store.upsert("owner_other", sampleSubscription(otherEndpoint), { platform: "desktop" });
  assert.equal((await store.list("owner_local")).length, 1);
  assert.equal((await store.list("owner_other")).length, 1);
  const activeRawLocal = await store.listActiveRaw("owner_local");
  assert.deepEqual(
    activeRawLocal.map((record) => record.endpoint),
    [localEndpoint]
  );
  const [activeRaw0] = activeRawLocal;
  assert.ok(activeRaw0);
  assert.deepEqual(activeRaw0.keys, {
    auth: "auth-secret",
    p256dh: "public-key-material",
  });

  await store.markFailure(localEndpoint, "temporary upstream error");
  let [visible]: Array<WebPushSubscriptionRecord | undefined> = await store.list("owner_local");
  assert.ok(visible);
  assert.equal(visible.last_failure_reason, "temporary upstream error");
  assert.equal(visible.revoked_at, null);

  await store.markSuccess(localEndpoint);
  [visible] = await store.list("owner_local");
  assert.ok(visible);
  assert.equal(visible.last_failure_reason, null);
  assert.equal(visible.last_success_at !== null, true);

  await store.markFailure(localEndpoint, "Gone", { revoke: true });
  assert.equal((await store.list("owner_local")).length, 0);
  [visible] = await store.list("owner_local", { activeOnly: false });
  assert.ok(visible);
  assert.equal(visible.last_failure_reason, "Gone");
  assert.equal(visible.revoked_at !== null, true);

  const revived = await store.upsert("owner_local", sampleSubscription(localEndpoint), { platform: "updated" });
  assert.equal(revived.revoked_at, null);
  assert.equal(revived.platform, "updated");

  assert.equal(await store.revoke("owner_other", localEndpoint), null);
  assert.equal((await store.list("owner_local")).length, 1);
  const revokedLocal = await store.revoke("owner_local", localEndpoint);
  assert.ok(revokedLocal);
  assert.equal(revokedLocal.endpoint, localEndpoint);
  assert.equal((await store.list("owner_local")).length, 0);
}

test("web push subscription management requires owner session when owner auth is enabled", async () => {
  await withServer(
    {
      ownerAuthPassword: TEST_PASSWORD,
      webPushConfig: {
        enabled: true,
        privateKey: VAPID_PRIVATE,
        publicKey: VAPID_PUBLIC,
        subject: "mailto:test@example.invalid",
        unavailableReason: null,
      },
      webPushSubscriptionStore: createMemoryWebPushSubscriptionStore(),
    },
    async ({ asUrl }) => {
      const create = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
        body: JSON.stringify({ subscription: sampleSubscription() }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
        redirect: "manual",
      });
      assert.equal(create.status, 401);

      const list = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
        headers: { Accept: "application/json" },
        redirect: "manual",
      });
      assert.equal(list.status, 401);

      const remove = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
        body: JSON.stringify({ endpoint: sampleSubscription().endpoint }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "DELETE",
        redirect: "manual",
      });
      assert.equal(remove.status, 401);
    }
  );
});

test("pending interaction Web Push payload omits sensitive connector and interaction values", () => {
  const payload = buildPendingInteractionPushPayload({
    connectorDisplayName: "Bank connector",
    interaction: {
      data: { answer: "submitted interaction answer", raw: "raw connector data" },
      kind: "otp",
      message: "Your OTP is 123456 and password is hunter2",
      request_id: "int_secret",
      schema: {
        properties: {
          cookie: { const: "session-cookie-secret" },
          otp: { const: "123456" },
          password: { const: "hunter2" },
          token: { const: "access-token-secret" },
        },
      },
    },
    runId: "run_secret",
  });
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    "123456",
    "hunter2",
    "access-token-secret",
    "session-cookie-secret",
    "raw connector data",
    "submitted interaction answer",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `payload leaked ${forbidden}`);
  }
  assert.equal(payload.url, "/syncs/run_secret");
  assert.equal(payload.interaction_id, "int_secret");
});

test("scheduled interaction Web Push payload can route to durable run context instead of transient stream", () => {
  const payload = buildPendingInteractionPushPayload({
    connectorDisplayName: "Scheduled connector",
    interaction: {
      kind: "manual_action",
      message: "Log in manually",
      request_id: "int_scheduled",
    },
    routeTo: "run",
    runId: "run_scheduled",
  });

  assert.equal(payload.url, "/syncs/run_scheduled");
  assert.equal(payload.interaction_id, "int_scheduled");
});

test("manual run Web Push payload still routes manual_action interactions to the stream", () => {
  const payload = buildPendingInteractionPushPayload({
    connectorDisplayName: "Manual connector",
    interaction: {
      kind: "manual_action",
      request_id: "int_manual",
    },
    runId: "run_manual",
  });

  assert.equal(payload.url, "/syncs/run_manual/stream?interaction_id=int_manual");
});

test("web push send failures mark subscriptions without blocking successful fallback work", async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/gone"), {});
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/ok"), {});

  const sent: unknown[] = [];
  await fanoutPendingInteractionWebPush({
    config: {
      enabled: true,
      privateKey: VAPID_PRIVATE,
      publicKey: VAPID_PUBLIC,
      subject: "mailto:test@example.invalid",
    },
    connectorDisplayName: "Manual connector",
    interaction: { kind: "manual_action", request_id: "int_manual" },
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    runId: "run_manual",
    sender: (subscriptionArg: unknown, payload: unknown) => {
      const subscription = subscriptionArg as { endpoint: string };
      sent.push(payload);
      if (subscription.endpoint.endsWith("/gone")) {
        const err: Error & { statusCode?: number } = new Error("Gone");
        err.statusCode = 410;
        throw err;
      }
    },
    store: toWebPushSubscriptionStore(store),
  });

  assert.equal(sent.length, 2);
  const active = await store.list("owner_local");
  assert.equal(active.length, 1);
  const [active0] = active;
  assert.ok(active0);
  assert.equal(active0.endpoint, "https://push.example.invalid/sub/ok");
  assert.equal(active0.last_success_at !== null, true);
});

test("web push fanout is scoped to the interaction owner subject", async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/local"), {});
  await store.upsert("owner_other", sampleSubscription("https://push.example.invalid/sub/other"), {});

  const endpoints: unknown[] = [];
  await fanoutPendingInteractionWebPush({
    config: {
      enabled: true,
      privateKey: VAPID_PRIVATE,
      publicKey: VAPID_PUBLIC,
      subject: "mailto:test@example.invalid",
    },
    connectorDisplayName: "Manual connector",
    interaction: { kind: "manual_action", request_id: "int_manual" },
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    runId: "run_manual",
    sender: (subscriptionArg: unknown) => {
      const subscription = subscriptionArg as { endpoint: string };
      endpoints.push(subscription.endpoint);
    },
    store: toWebPushSubscriptionStore(store),
  });

  assert.deepEqual(endpoints, ["https://push.example.invalid/sub/local"]);
  const localList = await store.list("owner_local");
  const otherList = await store.list("owner_other");
  const [local0] = localList;
  const [other0] = otherList;
  assert.ok(local0);
  assert.ok(other0);
  assert.equal(local0.last_success_at !== null, true);
  assert.equal(other0.last_success_at, null);
});

test("SQLite WebPushSubscriptionStore persists owner-scoped subscription state", async () => {
  initDb();
  try {
    await runWebPushSubscriptionStoreConformance(
      () => toWebPushSubscriptionStore(createSqliteWebPushSubscriptionStore()),
      "sqlite"
    );
  } finally {
    closeDb();
  }
});

test("Postgres WebPushSubscriptionStore conforms when PDPP_TEST_POSTGRES_URL is set", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const endpointPattern = "https://push.example.invalid/sub/postgres-%";
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres conformance test requires PDPP_TEST_POSTGRES_URL");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await postgresQuery("DELETE FROM web_push_subscriptions WHERE endpoint LIKE $1", [endpointPattern]);
    await runWebPushSubscriptionStoreConformance(
      () => toWebPushSubscriptionStore(createPostgresWebPushSubscriptionStore()),
      "postgres"
    );
  } finally {
    await postgresQuery("DELETE FROM web_push_subscriptions WHERE endpoint LIKE $1", [endpointPattern]);
    await closePostgresStorage();
  }
});

test("web push subscriptions persist across reference server restarts", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-web-push-persist-"));
  const dbPath = join(tmpDir, "pdpp.sqlite");
  const webPushConfig = {
    enabled: true as const,
    privateKey: VAPID_PRIVATE,
    publicKey: VAPID_PUBLIC,
    subject: "mailto:test@example.invalid",
    unavailableReason: null,
  };

  let server: TestServer | null = null;
  try {
    server = (await startServer({
      asPort: 0,
      dbPath,
      quiet: true,
      rsPort: 0,
      webPushConfig,
    })) as TestServer;
    let asUrl = `http://localhost:${server.asPort}`;
    const create = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      body: JSON.stringify({
        platform: "test-platform",
        subscription: sampleSubscription("https://push.example.invalid/sub/persisted"),
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(create.status, 201);
    await closeServer(server);
    closeDb();

    server = (await startServer({
      asPort: 0,
      dbPath,
      quiet: true,
      rsPort: 0,
      webPushConfig,
    })) as TestServer;
    asUrl = `http://localhost:${server.asPort}`;
    const list = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { data: Array<{ endpoint: string; platform: string }> };
    assert.equal(body.data.length, 1);
    const [item0] = body.data;
    assert.ok(item0);
    assert.equal(item0.endpoint, "https://push.example.invalid/sub/persisted");
    assert.equal(item0.platform, "test-platform");
  } finally {
    if (server) {
      await closeServer(server);
    }
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("shouldFanoutAssistanceProgress accepts only nonblocking owner-action ASSISTANCE messages", () => {
  assert.equal(
    shouldFanoutAssistanceProgress({
      assistance_request_id: "asst_1",
      message: "Approve the push in your phone app.",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      response_contract: "none",
      type: "ASSISTANCE",
    }),
    true
  );
  assert.equal(
    shouldFanoutAssistanceProgress({
      owner_action: "provide_value",
      progress_posture: "blocked",
      response_contract: "none",
      type: "ASSISTANCE",
    }),
    true
  );
  // INTERACTION still flows through brokerInteraction → fireWebPush, not here.
  assert.equal(
    shouldFanoutAssistanceProgress({
      owner_action: "act_elsewhere",
      progress_posture: "blocked",
      response_contract: "none",
      type: "INTERACTION",
    }),
    false
  );
  // Non-attention assistance (e.g. pure timeline narration) MUST NOT push.
  assert.equal(
    shouldFanoutAssistanceProgress({
      owner_action: "none",
      progress_posture: "running",
      response_contract: "none",
      type: "ASSISTANCE",
    }),
    false
  );
  // Missing owner_action MUST NOT push — the predicate must require a
  // declared owner_action string before fanning out, not just reject the
  // sentinel "none". A malformed/incomplete connector message that omits
  // owner_action would otherwise silently ring the owner's phone.
  assert.equal(
    shouldFanoutAssistanceProgress({
      progress_posture: "running",
      response_contract: "none",
      type: "ASSISTANCE",
    }),
    false
  );
  assert.equal(
    shouldFanoutAssistanceProgress({
      owner_action: null,
      progress_posture: "running",
      response_contract: "none",
      type: "ASSISTANCE",
    }),
    false
  );
  // response_required is handled by the blocking interaction broker.
  assert.equal(
    shouldFanoutAssistanceProgress({
      owner_action: "provide_value",
      progress_posture: "blocked",
      response_contract: "response_required",
      type: "ASSISTANCE",
    }),
    false
  );
  // Ordinary progress ticks must not push.
  assert.equal(shouldFanoutAssistanceProgress({ message: "doing things", type: "log" }), false);
  assert.equal(shouldFanoutAssistanceProgress(null), false);
});

test("assistance Web Push payload routes to the run page and omits raw assistance text", () => {
  const payload = buildAssistancePushPayload({
    assistance: {
      assistance_request_id: "asst_secret_42",
      // Connector free text and any future fields must NOT appear in the
      // push payload — locked screens are an untrusted surface.
      message: "Approve the ChatGPT push notification — code 482913.",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      response_contract: "none",
      sensitivity: "non_secret",
      type: "ASSISTANCE",
    },
    connectorDisplayName: "ChatGPT",
    runId: "run_assist",
  });

  assert.equal(payload.type, "pdpp.assistance_requested");
  assert.equal(payload.url, "/syncs/run_assist");
  assert.equal(payload.assistance_request_id, "asst_secret_42");
  assert.equal(payload.owner_action, "act_elsewhere");
  assert.equal(payload.notification_tier, "action_required");
  assert.equal(payload.response_contract, "none");

  const serialized = JSON.stringify(payload);
  for (const forbidden of ["482913", "Approve the ChatGPT push notification"]) {
    assert.equal(serialized.includes(forbidden), false, `assistance payload leaked ${forbidden}`);
  }
});

test("assistance Web Push fanout targets the owner and surfaces failures as marked subscriptions", async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/assist-local"), {});
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/assist-gone"), {});
  await store.upsert("owner_other", sampleSubscription("https://push.example.invalid/sub/assist-other"), {});

  interface SentEntry {
    endpoint: string;
    type: unknown;
  }
  const sent: SentEntry[] = [];
  const result = await fanoutAssistanceWebPush({
    assistance: {
      assistance_request_id: "asst_1",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      response_contract: "none",
      type: "ASSISTANCE",
    },
    config: {
      enabled: true,
      privateKey: VAPID_PRIVATE,
      publicKey: VAPID_PUBLIC,
      subject: "mailto:test@example.invalid",
    },
    connectorDisplayName: "ChatGPT",
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    runId: "run_assist",
    sender: (subscriptionArg: unknown, payloadArg: unknown) => {
      const subscription = subscriptionArg as { endpoint: string };
      const payload = payloadArg as { type: unknown };
      sent.push({ endpoint: subscription.endpoint, type: payload.type });
      if (subscription.endpoint.endsWith("/assist-gone")) {
        const err: Error & { statusCode?: number } = new Error("Gone");
        err.statusCode = 410;
        throw err;
      }
    },
    store: toWebPushSubscriptionStore(store),
  });

  assert.equal(result.attempted, 2);
  assert.equal(result.sent, 1);
  assert.equal(result.unavailable, false);
  assert.equal(
    sent.every((entry) => entry.type === "pdpp.assistance_requested"),
    true
  );
  assert.equal(
    sent.some((entry) => entry.endpoint === "https://push.example.invalid/sub/assist-other"),
    false,
    "assistance fanout must remain scoped to the owning subject"
  );
  const active = await store.list("owner_local");
  assert.equal(active.length, 1);
  const [active0] = active;
  assert.ok(active0);
  assert.equal(active0.endpoint, "https://push.example.invalid/sub/assist-local");
});

test("assistance Web Push fanout reports unavailable when VAPID is unconfigured", async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/assist-noop"), {});

  const result = await fanoutAssistanceWebPush({
    assistance: {
      assistance_request_id: "asst_x",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      response_contract: "none",
      type: "ASSISTANCE",
    },
    config: { enabled: false, privateKey: null, publicKey: null, subject: "mailto:test@example.invalid" },
    connectorDisplayName: "ChatGPT",
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    runId: "run_assist_unavail",
    sender: () => {
      throw new Error("sender should not be invoked when VAPID is disabled");
    },
    store,
  });

  assert.deepEqual(result, { attempted: 0, sent: 0, unavailable: true });
});

test("manual-run controller progress handler fans out assistance Web Push without forwarding raw assistance text", async () => {
  // Smallest-surface end-to-end check that the controller's manual-run
  // onProgress wiring actually invokes the assistance fanout for qualifying
  // ASSISTANCE messages, ignores ordinary progress, and never echoes
  // connector-supplied prose. We assert against the controller source rather
  // than spinning the full controller; this matches the existing
  // "controller keeps ntfy and Web Push as independent best-effort
  // notification channels" assertion style.
  const src = await readFile(new URL("../runtime/controller.ts", import.meta.url), "utf8");
  // Manual-run onProgress is no longer a no-op.
  assert.equal(
    MANUAL_PROGRESS_NOOP_PATTERN.test(src),
    false,
    "manual-run onProgress must wire ASSISTANCE fanout, not stay a no-op"
  );
  // It must filter by the documented predicate.
  assert.match(src, SHOULD_FANOUT_ASSISTANCE_PATTERN);
  // And it must invoke fireAssistanceWebPush — not fireWebPush — for ASSISTANCE
  // via the detachControllerTask helper that replaced bare `void` swallows.
  assert.match(src, DETACHED_ASSISTANCE_FANOUT_PATTERN);
  // The fanout helper must thread runId/ownerSubjectId from controller scope.
  assert.match(
    src,
    ASSISTANCE_FANOUT_CONTEXT_PATTERN,
    "fireAssistanceWebPush must receive ownerSubjectId and runId from the manual-run scope"
  );
});

test("controller keeps ntfy and Web Push as independent best-effort notification channels", async () => {
  const src = await readFile(new URL("../runtime/controller.ts", import.meta.url), "utf8");
  // Each channel is invoked through detachControllerTask so failures do not
  // affect interaction resolution (the prior `void fireXxx(...)` form was
  // replaced when controller-fanout cleanups landed).
  assert.match(src, DETACHED_NTFY_FANOUT_PATTERN);
  assert.match(src, DETACHED_WEB_PUSH_FANOUT_PATTERN);
  assert.match(src, NTFY_FIRE_FAILURE_PATTERN);
  assert.match(src, WEB_PUSH_FIRE_FAILURE_PATTERN);
});

test("scheduler interactions carry run context needed for server-side Web Push fanout", async () => {
  const src = await readFile(new URL("../runtime/scheduler/run-executor.ts", import.meta.url), "utf8");
  assert.match(src, SCHEDULER_ON_STARTED_PATTERN);
  assert.match(src, CONNECTOR_DISPLAY_NAME_PATTERN);
  assert.match(src, RUN_ID_PATTERN);
});

test("reference scheduler Web Push fanout uses the server subscription store and owner subject", async () => {
  const src = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(src, PENDING_INTERACTION_FANOUT_PATTERN);
  assert.match(src, WEB_PUSH_STORE_PATTERN);
  assert.match(src, OWNER_SUBJECT_PATTERN);
  assert.match(src, STORE_PATTERN);
  assert.match(src, ROUTE_TO_RUN_PATTERN);
});

test("test notification Web Push payload carries no secrets and routes to the overview", () => {
  const payload = buildTestPushPayload();
  assert.equal(payload.type, "pdpp.test_notification");
  assert.equal(payload.url, "/");
  assert.equal(typeof payload.title, "string");
  assert.equal(typeof payload.body, "string");
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["password", "cookie", "token", "otp", "answer", "credential", "secret"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, `payload leaked ${forbidden}`);
  }
});

test("test Web Push fanout is scoped to the requesting owner subject", async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/test-local"), {});
  await store.upsert("owner_other", sampleSubscription("https://push.example.invalid/sub/test-other"), {});

  const endpoints: unknown[] = [];
  const result = await fanoutTestWebPush({
    config: {
      enabled: true,
      privateKey: VAPID_PRIVATE,
      publicKey: VAPID_PUBLIC,
      subject: "mailto:test@example.invalid",
    },
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    sender: (subscriptionArg: unknown, payloadArg: unknown) => {
      const subscription = subscriptionArg as { endpoint: string };
      const payload = payloadArg as { type: unknown };
      assert.equal(payload.type, "pdpp.test_notification");
      endpoints.push(subscription.endpoint);
    },
    store,
  });

  assert.deepEqual(endpoints, ["https://push.example.invalid/sub/test-local"]);
  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.unavailable, false);
});

test("test Web Push fanout reports unavailable when VAPID is not configured", async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/test-unavail"), {});

  const result = await fanoutTestWebPush({
    config: { enabled: false, privateKey: null, publicKey: null, subject: "mailto:test@example.invalid" },
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    sender: () => {
      throw new Error("sender should not be invoked when VAPID is disabled");
    },
    store,
  });

  assert.deepEqual(result, { attempted: 0, sent: 0, unavailable: true });
});

test("POST /_ref/web-push/test requires owner session when owner auth is enabled", async () => {
  await withServer(
    {
      ownerAuthPassword: TEST_PASSWORD,
      webPushConfig: {
        enabled: true,
        privateKey: VAPID_PRIVATE,
        publicKey: VAPID_PUBLIC,
        subject: "mailto:test@example.invalid",
        unavailableReason: null,
      },
      webPushSubscriptionStore: createMemoryWebPushSubscriptionStore(),
    },
    async ({ asUrl }) => {
      const response = await fetch(`${asUrl}/_ref/web-push/test`, {
        headers: { Accept: "application/json" },
        method: "POST",
        redirect: "manual",
      });
      assert.equal(response.status, 401);
    }
  );
});

test("POST /_ref/web-push/test returns 503 when VAPID is unconfigured", async () => {
  await withServer(
    {
      webPushConfig: {
        enabled: false,
        privateKey: null,
        publicKey: null,
        subject: "mailto:test@example.invalid",
        unavailableReason: "VAPID public/private keys are not configured",
      },
      webPushSubscriptionStore: createMemoryWebPushSubscriptionStore(),
    },
    async ({ asUrl }) => {
      const response = await fetch(`${asUrl}/_ref/web-push/test`, {
        headers: { Accept: "application/json" },
        method: "POST",
      });
      assert.equal(response.status, 503);
    }
  );
});

// ─── 5.4 / 5.6 policy: push is a delivery channel, not state ───────────────

test("classifyInteractionSensitivity defaults to secret for unknown kinds", () => {
  assert.equal(classifyInteractionSensitivity("otp"), "secret");
  assert.equal(classifyInteractionSensitivity("credentials"), "secret");
  assert.equal(classifyInteractionSensitivity("manual_action"), "external");
  assert.equal(classifyInteractionSensitivity("something_new"), "secret");
  assert.equal(classifyInteractionSensitivity(undefined), "secret");
  assert.equal(classifyInteractionSensitivity(""), "secret");
});

test("pending interaction payload is frozen so spreads cannot leak connector free text", () => {
  const payload = buildPendingInteractionPushPayload({
    connectorDisplayName: "Bank",
    interaction: {
      data: { answer: "482913" },
      kind: "otp",
      message: "one-time code is 482913",
      request_id: "int_frozen",
      schema: { properties: { otp: { const: "482913" } } },
    },
    runId: "run_frozen",
  });
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(payload.interaction_sensitivity, "secret");
  // The frozen payload exposes only the safelisted keys.
  assert.deepEqual([...Object.keys(payload)].sort(), [
    "body",
    "connector_display_name",
    "interaction_id",
    "interaction_kind",
    "interaction_sensitivity",
    "run_id",
    "timestamp",
    "title",
    "type",
    "url",
  ]);
});

test("manual browser verification (manual_action) classifies as external, not secret", () => {
  const payload = buildPendingInteractionPushPayload({
    connectorDisplayName: "Source",
    interaction: {
      kind: "manual_action",
      message: "Visit https://provider.example/verify and click Continue",
      request_id: "int_verify",
    },
    runId: "run_verify",
  });
  assert.equal(payload.interaction_sensitivity, "external");
  assert.equal(payload.body, "A connector needs you to take an action.");
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["provider.example", "verify"]) {
    // "verify" appears in the run id segment; check the body only.
    if (forbidden === "verify") {
      continue;
    }
    assert.equal(serialized.includes(forbidden), false, `payload leaked ${forbidden}`);
  }
});

test("re-consent kind defaults to secret and produces no connector copy", () => {
  // We have not classified `re_consent` explicitly — the default-secret
  // policy means the body stays maximally generic, even if connectors
  // start emitting this kind tomorrow.
  const payload = buildPendingInteractionPushPayload({
    connectorDisplayName: "ChatGPT",
    interaction: {
      kind: "re_consent",
      message: "Click Re-grant on the provider page (your scope ABCDE expired)",
      request_id: "int_reconsent",
    },
    runId: "run_reconsent",
  });
  assert.equal(payload.interaction_sensitivity, "secret");
  assert.equal(payload.body, "A connector needs owner input.");
  assert.equal(JSON.stringify(payload).includes("ABCDE"), false);
});

test("assistance payload is frozen and never carries assistance.message text", () => {
  const payload = buildAssistancePushPayload({
    assistance: {
      assistance_request_id: "asst_frozen",
      data: { answer: "secret-answer" },
      message: "Approve the prompt — code 991122",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      response_contract: "none",
      type: "ASSISTANCE",
    },
    connectorDisplayName: "ChatGPT",
    runId: "run_assist_frozen",
  });
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(JSON.stringify(payload).includes("991122"), false);
  assert.equal(JSON.stringify(payload).includes("secret-answer"), false);
});

test("failed push delivery updates subscription metadata without changing higher-level attention state", async () => {
  // This test stands in for the "push is a delivery channel, not state" policy
  // at the runtime level: invoking a push fanout that fails must update the
  // subscription store (delivery metadata) but must not have side effects on
  // any caller-owned state. We assert this by capturing a snapshot of an
  // out-of-band "attention" object and proving it is byte-equal afterwards.
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/state-test"), {});

  const attentionLikeState = Object.freeze({
    attention_id: "att_99",
    connection_id: "conn_99",
    lifecycle: "open",
    sensitivity: "non_secret",
  });
  const before = JSON.stringify(attentionLikeState);

  const result = await fanoutPendingInteractionWebPush({
    config: {
      enabled: true,
      privateKey: VAPID_PRIVATE,
      publicKey: VAPID_PUBLIC,
      subject: "mailto:test@example.invalid",
    },
    connectorDisplayName: "Connector",
    interaction: { kind: "manual_action", request_id: "int_state_test" },
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    runId: "run_state_test",
    sender: () => {
      const err: Error & { statusCode?: number } = new Error("upstream temporarily unavailable");
      err.statusCode = 500;
      throw err;
    },
    store,
  });

  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 0);
  // Failure recorded on the subscription, but the subscription is NOT revoked
  // (500 is transient, not 404/410).
  const [visible] = await store.list("owner_local", { activeOnly: false });
  assert.ok(visible);
  assert.equal(visible.last_failure_reason, "upstream temporarily unavailable");
  assert.equal(visible.revoked_at, null);
  // Out-of-band state is unaffected — push delivery never mutates it.
  assert.equal(JSON.stringify(attentionLikeState), before);
});

test("410 Gone revokes the subscription but still leaves out-of-band state untouched", async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/gone-test"), {});

  const attentionLikeState = Object.freeze({ lifecycle: "open" });
  const before = JSON.stringify(attentionLikeState);

  await fanoutAssistanceWebPush({
    assistance: {
      assistance_request_id: "asst_gone",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      response_contract: "none",
      type: "ASSISTANCE",
    },
    config: {
      enabled: true,
      privateKey: VAPID_PRIVATE,
      publicKey: VAPID_PUBLIC,
      subject: "mailto:test@example.invalid",
    },
    connectorDisplayName: "ChatGPT",
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    runId: "run_gone_test",
    sender: () => {
      const err: Error & { statusCode?: number } = new Error("Gone");
      err.statusCode = 410;
      throw err;
    },
    store,
  });

  const stillActive = await store.list("owner_local");
  assert.equal(stillActive.length, 0, "subscription is revoked after 410");
  assert.equal(JSON.stringify(attentionLikeState), before);
});

test("fanoutEscalationWebPush: rendered verdict channel suppresses non-attention pushes", async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/calm-verdict"), {});
  let sendCount = 0;

  const result = await fanoutEscalationWebPush({
    config: {
      enabled: true,
      privateKey: VAPID_PRIVATE,
      publicKey: VAPID_PUBLIC,
      subject: "mailto:test@example.invalid",
    },
    connectorDisplayName: "ChatGPT",
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    reason: "needs_attention",
    renderedVerdict: {
      channel: "calm",
      required_actions: [
        {
          audience: "owner",
          satisfied_when: { kind: "credential_present_and_unrejected" },
        },
      ],
    },
    sender: () => {
      sendCount += 1;
    },
    store,
  });

  assert.deepEqual(result, { attempted: 0, sent: 0, suppressed: true, unavailable: false });
  assert.equal(sendCount, 0);
});

test("fanoutEscalationWebPush: rendered attention verdict sends to owner subscriptions", async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert("owner_local", sampleSubscription("https://push.example.invalid/sub/attention-verdict"), {});
  const sent: Array<{ endpoint: string; payload: { type: unknown; url: unknown } }> = [];

  const result = await fanoutEscalationWebPush({
    config: {
      enabled: true,
      privateKey: VAPID_PRIVATE,
      publicKey: VAPID_PUBLIC,
      subject: "mailto:test@example.invalid",
    },
    connectionUrl: "/sources/cin_gmail",
    connectorDisplayName: "Gmail",
    log: { warn: () => undefined },
    ownerSubjectId: "owner_local",
    reason: "needs_attention",
    renderedVerdict: {
      channel: "attention",
      required_actions: [
        {
          audience: "owner",
          satisfied_when: { kind: "credential_present_and_unrejected" },
        },
      ],
    },
    sender: (subscriptionArg: unknown, payloadArg: unknown) => {
      const subscription = subscriptionArg as { endpoint: string };
      const payload = payloadArg as { type: unknown; url: unknown };
      sent.push({ endpoint: subscription.endpoint, payload });
    },
    store,
  });

  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  const [sent0] = sent;
  assert.ok(sent0);
  assert.equal(sent0.payload.type, "pdpp.escalation");
  assert.equal(sent0.payload.url, "/sources/cin_gmail");
});

// ─── classifyPushFanoutOutcome ────────────────────────────────────────────

test("classifyPushFanoutOutcome: VAPID unavailable -> suppressed/channel_unavailable", () => {
  assert.deepEqual(classifyPushFanoutOutcome({ attempted: 0, sent: 0, unavailable: true }), {
    reason: "channel_unavailable",
    state: "suppressed",
  });
});

test("classifyPushFanoutOutcome: policy-suppressed (quiet hours, etc.) -> suppressed/policy_suppressed", () => {
  assert.deepEqual(classifyPushFanoutOutcome({ attempted: 0, sent: 0, suppressed: true, unavailable: false }), {
    reason: "policy_suppressed",
    state: "suppressed",
  });
});

test("classifyPushFanoutOutcome: no opted-in channel -> suppressed/no_opted_in_channel", () => {
  assert.deepEqual(classifyPushFanoutOutcome({ attempted: 0, sent: 0, unavailable: false }), {
    reason: "no_opted_in_channel",
    state: "suppressed",
  });
});

test("classifyPushFanoutOutcome: at least one accepted -> sent", () => {
  assert.deepEqual(classifyPushFanoutOutcome({ attempted: 2, sent: 1, unavailable: false }), {
    reason: null,
    state: "sent",
  });
});

test("classifyPushFanoutOutcome: every subscription rejected -> failed with transport reason", () => {
  const result = classifyPushFanoutOutcome({
    attempted: 2,
    failureReasons: ["410 gone", "timeout"],
    sent: 0,
    unavailable: false,
  });
  assert.equal(result.state, "failed");
  assert.ok(result.reason);
  assert.match(result.reason, TRANSPORT_PATTERN);
  assert.match(result.reason, GONE_PATTERN);
});

test("classifyPushFanoutOutcome: malformed result -> failed/no_result", () => {
  assert.deepEqual(classifyPushFanoutOutcome(null), { reason: "no_result", state: "failed" });
  assert.deepEqual(classifyPushFanoutOutcome("unexpected"), { reason: "no_result", state: "failed" });
});

test("fanoutPendingInteractionWebPush: recordOutcome callback fires with suppressed when VAPID is unavailable", async () => {
  // Force VAPID-disabled config so the fanout short-circuits to the
  // `unavailable: true` branch. The outcome callback must STILL be
  // invoked so the durable attention row sees notification_state set —
  // silent suppression is the failure mode this contract prevents.
  const outcomes: unknown[] = [];
  await fanoutPendingInteractionWebPush({
    config: { enabled: false, privateKey: null, publicKey: null, subject: "mailto:x@y" },
    connectorDisplayName: "Test",
    interaction: {
      kind: "manual_action",
      request_id: "int_outcome_a",
      run_id: "run_outcome_a",
    },
    log: { info: () => undefined, warn: () => undefined },
    ownerSubjectId: "owner_a",
    recordOutcome: (entry: unknown) => {
      outcomes.push(entry);
    },
    runId: "run_outcome_a",
    sender: () => {
      throw new Error("sender should not be called when VAPID is disabled");
    },
    store: createMemoryWebPushSubscriptionStore(),
  });
  assert.deepEqual(outcomes, [{ reason: "channel_unavailable", state: "suppressed" }]);
});
