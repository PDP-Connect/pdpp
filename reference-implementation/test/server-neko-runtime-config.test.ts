// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserSurfaceReadinessWebSocketLike } from "../runtime/browser-surface-readiness.ts";
import { resolveNekoBrowserSurfaceControllerOptions as resolveNekoBrowserSurfaceControllerOptionsUntyped } from "../server/index.ts";

const REGEXP_1 = /PDPP_NEKO_ALLOCATOR_URL is required in dynamic n\.eko surface mode/;
const REGEXP_2 = /must exceed the number of retained credential-boundary managed connectors/;

// `server/index.js` is plain JS: `resolveNekoBrowserSurfaceControllerOptions`'s
// destructured-default params (getBrowserSurfaceLeaseStore/createBrowserSurfaceAllocator)
// make TS infer their types from the real BrowserSurfaceLeaseStore /
// NekoSurfaceAllocatorClient (the latter from the external
// @opendatalabs/remote-surface package), which is far richer than the
// minimal fakes these tests construct. Re-typed here via the same documented
// pattern used elsewhere in this cohort: import the real export and cast it
// to a signature matching the minimal structural contract the function body
// actually calls (repairStaleSurfaceActiveLeases/listSurfaces/
// listNonTerminalLeases on the store; ensureSurface on the allocator).
interface TestLeaseRow {
  connector_id: string;
  expires_at: string;
  fencing_token: number;
  lease_id: string;
  priority_class: string;
  profile_key: string;
  requested_at: string;
  retained?: boolean;
  status: string;
  surface_id?: string;
  surface_subject_id: string;
  wait_reason: string;
}

interface TestSurfaceRow {
  [key: string]: unknown;
}

interface TestLeaseStore {
  listNonTerminalLeases: () => Promise<TestLeaseRow[]>;
  listSurfaces: () => Promise<TestSurfaceRow[]>;
  repairStaleSurfaceActiveLeases: () => Promise<void>;
}

interface TestAllocator {
  ensureSurface: (...args: unknown[]) => Promise<unknown>;
}

interface BrowserSurfaceLeaseManagerLike {
  getLease: (leaseId: string) => { retained?: boolean } | undefined;
  getSurface: (surfaceId: string) => { retained?: boolean } | undefined;
  isManagedConnector: (connectorId: string) => boolean;
  pumpQueuedLeases: () => Array<{ lease_id: string; status: string; surface_id?: string }>;
}

interface ResolvedNekoOptions {
  browserSurfaceAllocator?: TestAllocator;
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManagerLike;
  browserSurfaceLeaseStore?: TestLeaseStore;
  browserSurfaceReadinessProbe?: { probe: (input: Record<string, unknown>) => Promise<{ ok: boolean }> };
  browserSurfaceReadinessTimeoutMs?: number;
}

interface ResolveNekoBrowserSurfaceControllerOptionsArgs {
  createBrowserSurfaceAllocator?: (options: Record<string, unknown>) => TestAllocator;
  env: Record<string, string>;
  getBrowserSurfaceLeaseStore: () => TestLeaseStore;
}

// The real inferred parameter type (BrowserSurfaceLeaseStore /
// NekoSurfaceAllocatorClient, the latter from the external
// @opendatalabs/remote-surface package) and the minimal structural contract
// above don't overlap enough for a direct function-value cast, so the call
// itself is typed instead: the argument widened to `unknown` (always
// assignable) and the return narrowed via a single-hop cast to the type
// above -- the same pattern already established in this repo (see
// records-instance-namespace.test.ts's buildSemanticSearchPlanForGrant).
async function resolveNekoBrowserSurfaceControllerOptions(
  args: ResolveNekoBrowserSurfaceControllerOptionsArgs
): Promise<ResolvedNekoOptions> {
  const untyped = resolveNekoBrowserSurfaceControllerOptionsUntyped as (args: unknown) => unknown;
  return (await untyped(args)) as ResolvedNekoOptions;
}

test("n.eko static runtime config builds controller options without allocator", async () => {
  let allocatorCalled = false;
  const store = createEmptyLeaseStore();
  const options = await resolveNekoBrowserSurfaceControllerOptions({
    createBrowserSurfaceAllocator: () => {
      allocatorCalled = true;
      return { ensureSurface: async () => undefined };
    },
    env: {
      PDPP_NEKO_BASE_URL: "http://127.0.0.1:8080",
      PDPP_NEKO_CDP_HTTP_URL: "http://127.0.0.1:9222",
      PDPP_NEKO_MANAGED_CONNECTORS: "connector-a",
      PDPP_NEKO_SURFACE_CAP: "1",
    },
    getBrowserSurfaceLeaseStore: () => store,
  });

  assert.equal(options.browserSurfaceLeaseStore, store);
  assert.ok(options.browserSurfaceLeaseManager);
  assert.equal(options.browserSurfaceAllocator, undefined);
  assert.equal(options.browserSurfaceReadinessTimeoutMs, undefined);
  assert.equal(allocatorCalled, false);
});

test("n.eko dynamic runtime config builds allocator and readiness controller options", async () => {
  const store = createEmptyLeaseStore();
  const allocator = { ensureSurface: async () => undefined };
  const allocatorOptions: Record<string, unknown>[] = [];
  const options = await resolveNekoBrowserSurfaceControllerOptions({
    // biome-ignore lint/suspicious/noShadow: Shadowed name mirrors the protocol field being asserted.
    createBrowserSurfaceAllocator: (options) => {
      allocatorOptions.push(options);
      return allocator;
    },
    env: {
      PDPP_NEKO_ALLOCATOR_URL: "http://allocator.test/api",
      PDPP_NEKO_MANAGED_CONNECTORS: "connector-a",
      PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
      PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
      PDPP_NEKO_READINESS_TIMEOUT_MS: "34567",
      PDPP_NEKO_SURFACE_CAP: "2",
      PDPP_NEKO_SURFACE_MODE: "dynamic",
    },
    getBrowserSurfaceLeaseStore: () => store,
  });

  assert.equal(options.browserSurfaceLeaseStore, store);
  assert.ok(options.browserSurfaceLeaseManager);
  assert.equal(options.browserSurfaceAllocator, allocator);
  assert.equal(options.browserSurfaceReadinessTimeoutMs, 34_567);
  assert.deepEqual(allocatorOptions, [{ baseUrl: "http://allocator.test/api" }]);
});

interface FakeFetchResponse {
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
}

test("dynamic readiness budget governs the semantic CDP preflight, not the five-second library default", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  // A real `Response` has dozens of properties this readiness probe never
  // reads; only `ok`/`status`/`json()` are consumed (see
  // fetchJsonWithBudget in runtime/browser-surface-readiness.ts). The fake
  // and real `fetch` types don't overlap enough for a direct cast, so the
  // call itself is typed instead: the fake fetch is held under its own
  // concrete FakeFetchResponse type, then substituted for the global via an
  // unknown-widened intermediate -- the same two-step pattern used above
  // for resolveNekoBrowserSurfaceControllerOptions.
  // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
  const fakeFetch = async (url: string | Request | URL): Promise<FakeFetchResponse> => {
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/json/version") {
      return {
        json: async () => ({ Browser: "Chrome/test", webSocketDebuggerUrl: "ws://neko.test/page" }),
        ok: true,
        status: 200,
      };
    }
    if (pathname === "/json/list") {
      return {
        json: async () => [
          { id: "page-1", type: "page", url: "https://example.test/", webSocketDebuggerUrl: "ws://neko.test/page-1" },
        ],
        ok: true,
        status: 200,
      };
    }
    if (pathname === "/pdpp/window-settle") {
      return { json: async () => ({ height: 900, settled: true, width: 1440 }), ok: true, status: 200 };
    }
    return { json: async () => ({}), ok: false, status: 404 };
  };
  globalThis.fetch = fakeFetch as typeof fetch;

  type ListenerType = "open" | "message" | "error" | "close";
  // Standard WebSocket readyState constants, both as static members (for the
  // constructor-type check against the real `typeof WebSocket`) and as
  // instance members (per the WebSocket interface) -- the readiness probe
  // itself never reads readyState, but the real constructor type requires
  // both.
  class FakeWebSocket implements BrowserSurfaceReadinessWebSocketLike {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly #listeners: Record<ListenerType, Array<(event: { readonly data?: unknown }) => void>> = {
      close: [],
      error: [],
      message: [],
      open: [],
    };
    constructor() {
      queueMicrotask(() => this.#emit("open", {}));
    }
    addEventListener(type: ListenerType, listener: (event: { readonly data?: unknown }) => void): void {
      this.#listeners[type].push(listener);
    }
    close(): void {
      /* intentionally empty */
    }
    send(raw: string): void {
      const request = JSON.parse(raw);
      setTimeout(
        () =>
          this.#emit("message", {
            data: JSON.stringify({ id: request.id, result: { frameTree: { frame: { id: "root" } } } }),
          }),
        12
      );
    }
    #emit(type: ListenerType, event: { readonly data?: unknown }): void {
      for (const listener of this.#listeners[type]) {
        listener(event);
      }
    }
  }
  // The real DOM `WebSocket` type carries dozens of members
  // (binaryType/bufferedAmount/onopen/...) FakeWebSocket does not implement
  // and never needs to -- the readiness probe only calls
  // addEventListener/close/send (BrowserSurfaceReadinessWebSocketLike,
  // implemented above). The two constructor types don't overlap enough for
  // a direct cast, so this substitutes through a same-shape function type
  // (the constructor signature actually invoked: `new (url) => the
  // structural instance shape`) rather than assigning through a bare
  // `unknown` variable, mirroring the two-hop pattern this repo already
  // uses for genuinely disjoint types (records-instance-namespace.test.ts's
  // buildSemanticSearchPlanForGrant).
  type WebSocketConstructorLike = new (url: string) => BrowserSurfaceReadinessWebSocketLike;
  const fakeWebSocketCtor: WebSocketConstructorLike = FakeWebSocket;
  globalThis.WebSocket = fakeWebSocketCtor as typeof WebSocket;

  const options = await resolveNekoBrowserSurfaceControllerOptions({
    createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
    env: {
      PDPP_NEKO_ALLOCATOR_URL: "http://allocator.test/api",
      PDPP_NEKO_MANAGED_CONNECTORS: "connector-a",
      PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
      PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
      PDPP_NEKO_READINESS_TIMEOUT_MS: "25",
      PDPP_NEKO_SURFACE_CAP: "2",
      PDPP_NEKO_SURFACE_MODE: "dynamic",
    },
    getBrowserSurfaceLeaseStore: () => createEmptyLeaseStore(),
  });

  assert.ok(options.browserSurfaceReadinessProbe, "dynamic mode must produce a readiness probe");
  const result = await options.browserSurfaceReadinessProbe.probe({
    cdp_url: "http://neko.test:9223",
    health: "ready",
    surface_id: "surface-1",
  });
  assert.equal(result.ok, true, "a 12ms semantic CDP response must use the configured 25ms dynamic budget");
});

test("n.eko runtime config treats canonical connector URLs as matching short connector ids", async () => {
  const store = createEmptyLeaseStore();
  const options = await resolveNekoBrowserSurfaceControllerOptions({
    createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
    env: {
      PDPP_NEKO_ALLOCATOR_URL: "http://allocator.test/api",
      PDPP_NEKO_MANAGED_CONNECTORS: "https://registry.pdpp.dev/connectors/chatgpt",
      PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
      PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
      PDPP_NEKO_SURFACE_CAP: "2",
      PDPP_NEKO_SURFACE_MODE: "dynamic",
    },
    getBrowserSurfaceLeaseStore: () => store,
  });

  assert.ok(options.browserSurfaceLeaseManager);
  assert.equal(options.browserSurfaceLeaseManager.isManagedConnector("chatgpt"), true);
  assert.equal(
    options.browserSurfaceLeaseManager.isManagedConnector("https://registry.pdpp.dev/connectors/chatgpt"),
    true
  );
});

test("n.eko explicit dynamic runtime config fails fast without allocator settings", async () => {
  await assert.rejects(
    resolveNekoBrowserSurfaceControllerOptions({
      createBrowserSurfaceAllocator: () => {
        throw new Error("allocator should not be reached after invalid config");
      },
      env: {
        PDPP_NEKO_MANAGED_CONNECTORS: "connector-a",
        PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
        PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
        PDPP_NEKO_SURFACE_CAP: "1",
        PDPP_NEKO_SURFACE_MODE: "dynamic",
      },
      getBrowserSurfaceLeaseStore: () => createEmptyLeaseStore(),
    }),
    REGEXP_1
  );
});

test("fair-slot invariant: a retained connector (ChatGPT) with cap=1 fails config closed", async () => {
  await assert.rejects(
    resolveNekoBrowserSurfaceControllerOptions({
      createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
      env: {
        PDPP_NEKO_ALLOCATOR_URL: "http://allocator.test/api",
        PDPP_NEKO_MANAGED_CONNECTORS: "https://registry.pdpp.dev/connectors/chatgpt",
        PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
        PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
        PDPP_NEKO_SURFACE_CAP: "1",
        PDPP_NEKO_SURFACE_MODE: "dynamic",
      },
      getBrowserSurfaceLeaseStore: () => createEmptyLeaseStore(),
    }),
    REGEXP_2
  );
});

test("fair-slot invariant: cap=3 with ChatGPT + four other connectors passes (one fair transient slot)", async () => {
  const store = createEmptyLeaseStore();
  const options = await resolveNekoBrowserSurfaceControllerOptions({
    createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
    env: {
      PDPP_NEKO_ALLOCATOR_URL: "http://allocator.test/api",
      PDPP_NEKO_MANAGED_CONNECTORS:
        "https://registry.pdpp.dev/connectors/chatgpt,https://registry.pdpp.dev/connectors/chase,https://registry.pdpp.dev/connectors/usaa,https://registry.pdpp.dev/connectors/amazon,https://registry.pdpp.dev/connectors/reddit",
      PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
      PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
      PDPP_NEKO_SURFACE_CAP: "3",
      PDPP_NEKO_SURFACE_MODE: "dynamic",
    },
    getBrowserSurfaceLeaseStore: () => store,
  });
  assert.ok(options.browserSurfaceLeaseManager);
});

test("boot re-derives retained on a rehydrated NONTERMINAL LEASE that has no surface yet, not only on surfaces", async () => {
  // Regression: a queued (waiting_for_browser_surface) ChatGPT lease that was
  // persisted before a restart has no surface row for rederiveRetainedSurfaces
  // to mark. Before this fix, only listSurfaces() was re-derived, so this
  // lease would rehydrate non-retained; once it later materializes a surface
  // (queue promotion), that surface would be created WITHOUT the retained
  // flag and become evictable by routine idle-TTL / capacity-pressure reap —
  // reproducing the exact steady-state auth-loss bug this whole change fixes.
  const persistedLease = {
    connector_id: "https://registry.pdpp.dev/connectors/chatgpt",
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    fencing_token: 1,
    lease_id: "lease_queued_chatgpt",
    priority_class: "background",
    profile_key: "chatgpt:acct-a",
    requested_at: new Date().toISOString(),
    run_id: "run_queued",
    status: "waiting_for_browser_surface",
    surface_subject_id: "acct-a",
    wait_reason: "capacity_full",
    // No `retained` field persisted — this is the pre-fix rehydrated shape.
  };
  const store = {
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listNonTerminalLeases() {
      return [persistedLease];
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listSurfaces() {
      return [];
    },
    async repairStaleSurfaceActiveLeases() {
      /* intentionally empty */
    },
  };

  const options = await resolveNekoBrowserSurfaceControllerOptions({
    createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
    env: {
      PDPP_NEKO_ALLOCATOR_URL: "http://allocator.test/api",
      PDPP_NEKO_MANAGED_CONNECTORS: "https://registry.pdpp.dev/connectors/chatgpt",
      PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
      PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
      PDPP_NEKO_SURFACE_CAP: "3",
      PDPP_NEKO_SURFACE_MODE: "dynamic",
    },
    getBrowserSurfaceLeaseStore: () => store,
  });

  const manager = options.browserSurfaceLeaseManager;
  assert.ok(manager);
  assert.equal(
    manager.getLease("lease_queued_chatgpt")?.retained,
    true,
    "rehydrated queued lease must be re-derived retained"
  );

  // Prove it stays retained through materialization: promote the queued lease
  // into a surface and confirm that surface is created retained too.
  const promoted = manager.pumpQueuedLeases();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0]?.lease_id, "lease_queued_chatgpt");
  assert.equal(promoted[0]?.status, "starting_surface");
  const surfaceId = promoted[0]?.surface_id;
  assert.ok(surfaceId);
  assert.equal(
    manager.getSurface(surfaceId)?.retained,
    true,
    "surface materialized from a rehydrated queued retained lease must be retained"
  );
});

// Note: the PER-CONNECTION fair-slot invariant (two retained ChatGPT surfaces +
// cap=3 = one transient slot; a third retained connection is refused) is enforced
// at retained-surface CREATION time in the lease manager, not by counting observed
// surfaces at boot. See `browser-surface-leases.test.ts` →
// "creating a retained surface that would consume the fair-slot reserve is
// terminally deferred". Counting rehydrated surfaces here would be fail-open: a
// configured retained connection that never acquired a surface is absent from the
// store, so it must be caught when its demand materializes, not at boot.

function createEmptyLeaseStore() {
  return {
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listNonTerminalLeases() {
      return [];
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listSurfaces() {
      return [];
    },
    async repairStaleSurfaceActiveLeases() {
      /* intentionally empty */
    },
  };
}
