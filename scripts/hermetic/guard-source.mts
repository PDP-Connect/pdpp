// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fail-closed hermetic network guard for test/smoke execution.
//
// Background: a migration lane smoke-ran a migrated RI script with no args.
// Its default fallback resolved to http://localhost:7662 -- the exact port a
// live production reference server runs on on this machine -- and made real
// read-only requests against it. A "check what's listening first" procedural
// fix was rejected: the systemic problem is that ANY test or smoke process
// can silently reach an ambient/production network origin whenever it fails
// to plumb through an explicit fixture URL. This module makes that fail
// LOUD and IMMEDIATE instead of silent.
//
// Design: default-deny. Once installed, every outbound HTTP(S) attempt
// (fetch(), undici's global dispatcher, and legacy http.request()/https.request()) is checked
// against an explicit allowlist of origins. Anything not on the allowlist is
// refused before a socket is ever opened -- surfaced as a connection-refused
// error (ECONNREFUSED) on the request, matching Node's real connection-failure
// contract, so callers that await the 'error' event (proxies, clients) fail
// cleanly instead of hanging. A request that supplies its OWN connection
// machinery (an explicit http(s).Agent, or a per-request undici dispatcher) is
// deferred to that machinery rather than guarded, since that is the caller's
// declared connection intent (e.g. the product's loopback-pinned SSRF agent).
//
// AUTHORITY IS NORMALLY BIND-DERIVED. The guard patches the ONE bind-lifecycle
// seam that every in-process server passes through -- net.Server.prototype
// .listen (which http.Server and https.Server both inherit unchanged, and
// which Fastify's app.listen() bottoms out at). When a server in THIS
// process finishes binding a port (the 'listening' event -- i.e. the bind
// actually succeeded and reported an address), the guard grants authority
// for that exact bound port over its loopback spellings, and revokes it
// again on 'close'. A test therefore reaches a server it itself started by
// any loopback spelling, and nothing else -- not a different port, not a
// different host, and not a port a foreign/production process happens to
// hold (7662). A test that starts a server in a child process must explicitly
// grant the exact returned origin in its parent, then revoke that grant.
//
// This module is inert until installHermeticNetworkGuard() is called. It is
// never imported by product/runtime code paths -- see preload.mjs, which is
// the only intended call site, wired into canonical test launchers and gated on
// PDPP_HERMETIC_GUARD.

import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";

export interface HermeticGuardHandle {
  readonly installed: true;
  uninstall: () => void;
}

type OriginRegistry = Map<string, number>;

// Reference-counted allowlist: origin string -> number of currently-open
// servers granting it. Ref-counting (not a plain Set) so that two servers
// that legitimately map to the same loopback origin spelling -- e.g. an
// IPv4 and an IPv6 listener sharing a port is impossible, but an AS and RS
// on distinct ports never collide; the guard against double-revoke is for a
// single server whose close/error paths both try to revoke -- do not have
// one's close revoke the other's still-live grant. A grant is live while its
// count is > 0.
const registeredOrigins: OriginRegistry = new Map();
let activeHandle: HermeticGuardHandle | undefined;

const TRAILING_SLASH_PATTERN = /\/+$/;

/** Registry key for a Unix-domain socket: `unix:<path>`, e.g. `unix:/run/x.sock`. */
const UNIX_SOCKET_PREFIX = "unix:";

/**
 * Normalize a URL-ish string down to its origin: `protocol//host:port`. A
 * `unix:<absolute path>` key (a socket a server bound, or one a test grants
 * explicitly through registerEphemeralOrigin) passes through unchanged.
 */
function normalizeOrigin(input: string): string {
  if (input.startsWith(UNIX_SOCKET_PREFIX)) {
    return input;
  }
  const url = new URL(input);
  return `${url.protocol}//${url.host}`.replace(TRAILING_SLASH_PATTERN, "");
}

function grantOrigin(origin: string): void {
  registeredOrigins.set(origin, (registeredOrigins.get(origin) ?? 0) + 1);
}

function revokeOrigin(origin: string): void {
  const count = registeredOrigins.get(origin);
  if (count === undefined) {
    return;
  }
  if (count <= 1) {
    registeredOrigins.delete(origin);
    return;
  }
  registeredOrigins.set(origin, count - 1);
}

/**
 * Register an origin (e.g. the URL a test's own `server.listen(0, ...)` just
 * bound) as reachable while the hermetic guard is active. Normally called by
 * the bind-lifecycle hook (see installBindDerivedAuthority), not by tests.
 * Kept exported so the guard's own unit tests can drive the allowlist
 * directly, and so a test with a genuinely explicit, unusual handoff need
 * (documented at its call site) can opt in. Idempotent-safe via ref-count.
 */
export function registerEphemeralOrigin(url: string): void {
  grantOrigin(normalizeOrigin(url));
}

/** Remove a previously registered origin. Mainly useful for guard's own tests. */
export function unregisterEphemeralOrigin(url: string): void {
  revokeOrigin(normalizeOrigin(url));
}

/** True if `url`'s origin is currently allowlisted. */
export function isOriginAllowed(url: string): boolean {
  return (registeredOrigins.get(normalizeOrigin(url)) ?? 0) > 0;
}

export function blockedOriginError(origin: string): Error & { code: string } {
  const error = new Error(
    `blocked non-allowlisted origin ${origin} (hermetic test guard: origin authority is derived from a successful in-process server bind; this origin was never bound by a server in this process, or was bound elsewhere/already closed)`
  ) as Error & { code: string };
  // Carry the standard connection-refused code. The guard refuses to let the
  // connection be established, so semantically this IS a refused connection --
  // and any caller that keys off `err.code` (e.g. a proxy classifying upstream
  // failures) then treats a guard block identically to a real ECONNREFUSED,
  // rather than seeing an unrecognized error. The message still names the
  // hermetic guard, so the block remains fully diagnosable.
  error.code = "ECONNREFUSED";
  return error;
}

// ─── Bind-derived origin authority ──────────────────────────────────────────

// Loopback host spellings per address family. `localhost` is granted only with
// IPv4: it can resolve to 127.0.0.1, where a foreign IPv4 server may hold the
// same port, so an IPv6 bind grants only [::1]. Residual: on a host whose
// resolver returns ::1 for `localhost`, an IPv4-only bind still grants
// `localhost:<port>`, so a foreign ::1 listener on that port is reachable
// through that one spelling.
const IPV4_LOOPBACK_HOSTS = ["localhost", "127.0.0.1"] as const;
const IPV6_LOOPBACK_HOSTS = ["[::1]"] as const;

/**
 * Given a bound AddressInfo and whether the server is TLS, produce the exact
 * set of origins to grant -- only the address family the server actually bound.
 * 0.0.0.0 and 127.0.0.1 grant IPv4 loopback; ::1 grants IPv6 loopback; `::`
 * is dual-stack (IPv4-mapped) and grants both unless the server asked for
 * `ipv6Only`. Another family on the same port may belong to a foreign process,
 * so it is never granted. A specific non-loopback bind grants only that exact
 * host:port. Never broadens to another port or an unrelated host.
 */
function boundOrigins(protocol: "http:" | "https:", address: string, port: number, ipv6Only: boolean): string[] {
  let hosts: readonly string[] | undefined;
  if (address === "0.0.0.0" || address === "127.0.0.1") {
    hosts = IPV4_LOOPBACK_HOSTS;
  } else if (address === "::1") {
    hosts = IPV6_LOOPBACK_HOSTS;
  } else if (address === "::" || address === "") {
    hosts = ipv6Only ? IPV6_LOOPBACK_HOSTS : [...IPV4_LOOPBACK_HOSTS, "[::1]"];
  }
  if (hosts) {
    return hosts.map((host) => `${protocol}//${host}:${port}`);
  }
  // A concrete, non-loopback interface (e.g. a specific LAN IP). Grant only
  // that literal host:port. IPv6 literals must be bracketed to form a valid
  // origin host.
  const literalHost = address.includes(":") ? `[${address}]` : address;
  return [`${protocol}//${literalHost}:${port}`];
}

type NetServer = import("node:net").Server;
type ListenArgs = Parameters<NetServer["listen"]>;

// Marker so re-installing (idempotent) does not double-wrap listen, and so
// uninstall can detect its own patch.
interface PatchedListen {
  __pdppHermeticPatched?: true;
  __pdppOriginalListen?: NetServer["listen"];
  (this: NetServer, ...args: ListenArgs): NetServer;
}

const bindOptions = new WeakMap<NetServer, { ipv6Only: boolean }>();

/**
 * Attach the grant/revoke lifecycle to a single server instance the moment
 * its listen() call has been issued. The grant is applied on 'listening'
 * (bind SUCCEEDED and address() is populated) -- never merely on listen()
 * being called -- and withdrawn on 'close'. A bind that fails emits 'error'
 * and never 'listening', so it grants nothing. Returns the server's options;
 * the caller commits a listen()'s options only once that listen() has returned.
 */
function attachBindAuthority(server: NetServer): { ipv6Only: boolean } {
  // A server can listen, close and listen again with different options. One
  // handler pair serves every listen and reads the options the latest
  // successful listen() committed.
  const existing = bindOptions.get(server);
  if (existing) {
    return existing;
  }
  const options = { ipv6Only: false };
  bindOptions.set(server, options);

  // Detect TLS at grant time (a tls.Server is an https listener). Imported
  // lazily to avoid a hard node:tls dependency in the hot patch path.
  let granted: string[] | undefined;

  const onListening = (): void => {
    if (granted) {
      return;
    }
    const info = server.address();
    if (info === null) {
      return;
    }
    if (typeof info === "string") {
      // A Unix-domain socket: grant exactly that path for socketPath requests.
      granted = [`${UNIX_SOCKET_PREFIX}${info}`];
    } else {
      const protocol = isTlsServer(server) ? "https:" : "http:";
      granted = boundOrigins(protocol, info.address, info.port, options.ipv6Only);
    }
    for (const origin of granted) {
      grantOrigin(origin);
    }
  };

  const revoke = (): void => {
    if (!granted) {
      return;
    }
    for (const origin of granted) {
      revokeOrigin(origin);
    }
    granted = undefined;
  };

  server.on("listening", onListening);
  server.on("close", revoke);
  return options;
}

// node:tls's Server extends net.Server; an https listener IS a tls.Server.
// Resolve its constructor only when a test loads TLS or HTTPS.
let tlsServerCtor: (new (...args: never[]) => unknown) | null = null;
function isTlsServer(server: NetServer): boolean {
  return tlsServerCtor !== null && server instanceof tlsServerCtor;
}

/** True when `listen({ ipv6Only: true })` made a `::` bind IPv6-only. */
function listensIpv6Only(args: ListenArgs): boolean {
  const [options] = args as unknown[];
  return typeof options === "object" && options !== null && (options as { ipv6Only?: unknown }).ipv6Only === true;
}

/**
 * Patch net.Server.prototype.listen when the test first loads a network
 * server module. This avoids loading net/tls in test descendants that only
 * run a helper CLI and never open a server.
 */
function installBindDerivedAuthority(restoreList: Array<() => void>): void {
  const net = process.getBuiltinModule("node:net");
  if (!net) {
    throw new Error("node:net is unavailable to the hermetic test guard");
  }
  const proto = net.Server.prototype;
  const original = proto.listen as NetServer["listen"];

  if ((original as PatchedListen).__pdppHermeticPatched) {
    return;
  }

  const patched: PatchedListen = function patchedListen(this: NetServer, ...args: ListenArgs): NetServer {
    const options = attachBindAuthority(this);
    const ipv6Only = listensIpv6Only(args);
    const result = (original as (this: NetServer, ...a: ListenArgs) => NetServer).apply(this, args);
    // Commit only after listen() returns. Node throws ERR_SERVER_ALREADY_LISTEN
    // when a live server is listened on again, and that rejected call must not
    // change how the live bind is granted.
    options.ipv6Only = ipv6Only;
    return result;
  };
  patched.__pdppHermeticPatched = true;
  patched.__pdppOriginalListen = original;
  proto.listen = patched as NetServer["listen"];

  restoreList.push(() => {
    if (proto.listen === (patched as NetServer["listen"])) {
      proto.listen = original;
    }
  });
}

// ─── Outbound request interception ──────────────────────────────────────────

type NodeHttpModule = typeof import("node:http");
type NodeHttpsModule = typeof import("node:https");

type RequestOptions = Record<string, unknown>;

/** What Node's `urlToHttpOptions` yields for the fields that pick a destination. */
function destinationFromUrl(url: URL): RequestOptions {
  return {
    protocol: url.protocol,
    hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
    port: url.port === "" ? undefined : url.port,
  };
}

/**
 * The options a `http(s).request(url, options?, cb?)` / `request(options, cb?)`
 * call ends up dialing with. Mirrors ClientRequest: a URL argument is expanded
 * first, then the options object is assigned over it, so an options field
 * (including an explicit `undefined`) wins over the URL's.
 */
function effectiveRequestOptions(firstArg: unknown, secondArg: unknown): RequestOptions {
  const isUrlArg = typeof firstArg === "string" || firstArg instanceof URL;
  const fromUrl = isUrlArg ? destinationFromUrl(new URL(String(firstArg))) : {};
  const explicit = isUrlArg ? secondArg : firstArg;
  return typeof explicit === "object" && explicit !== null ? { ...fromUrl, ...explicit } : fromUrl;
}

/** `hostname` wins over `host`; an empty value falls through, as in Node. */
function resolveHostFromOptions(opts: RequestOptions): string {
  for (const candidate of [opts.hostname, opts.host]) {
    if (typeof candidate === "string" && candidate !== "") {
      return candidate;
    }
  }
  return "localhost";
}

/** The allowlist key a `http(s).request`/`.get` call is about to reach: a
 * `unix:<path>` key for a socketPath request, otherwise the origin Node dials. */
function resolveRequestOrigin(firstArg: unknown, secondArg: unknown, defaultProtocol: "http:" | "https:"): string {
  const opts = effectiveRequestOptions(firstArg, secondArg);
  if (typeof opts.socketPath === "string" && opts.socketPath !== "") {
    return `${UNIX_SOCKET_PREFIX}${opts.socketPath}`;
  }
  const protocol = typeof opts.protocol === "string" ? opts.protocol : defaultProtocol;
  const host = resolveHostFromOptions(opts);
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const portValue = opts.port || opts.defaultPort;
  const port = typeof portValue === "number" || typeof portValue === "string" ? `:${portValue}` : "";
  return normalizeOrigin(`${protocol}//${bracketed}${port}`);
}

/**
 * True when the caller supplied an explicit custom `agent` object in the
 * request options. Such a request has opted into its OWN connection strategy
 * -- the same way a `fetch(url, { dispatcher })` supplies a per-request
 * undici dispatcher that already bypasses the guard's GLOBAL dispatcher. The
 * guard governs the DEFAULT connection path -- the plain `fetch`/`http.request`
 * with no custom agent, which is exactly the shape of the incident (a default
 * fallback to http://localhost:7662). It steps aside when the caller brings
 * its own agent, because that agent is the caller's declared connection
 * intent. This is NOT a host allowlist and NOT a localhost allow: a plain
 * default request to ANY unbound origin is still blocked.
 */
function hasExplicitCustomAgent(firstArg: unknown, secondArg: unknown): boolean {
  const { agent } = effectiveRequestOptions(firstArg, secondArg);
  return typeof agent === "object" && agent !== null;
}

function guardLegacyHttpModule<M extends NodeHttpModule | NodeHttpsModule>(
  moduleNamespace: M,
  defaultProtocol: "http:" | "https:",
  restoreList: Array<() => void>
): void {
  const originalRequest = moduleNamespace.request;
  const originalGet = moduleNamespace.get;

  // biome-ignore lint/suspicious/noExplicitAny: the original http(s).request/get is overload-heavy; args are forwarded verbatim
  function blockRequest(this: unknown, original: any, args: unknown[]): ReturnType<NodeHttpModule["request"]> {
    const origin = resolveRequestOrigin(args[0], args[1], defaultProtocol);
    // Create the real ClientRequest, then immediately destroy it with the
    // guard error BEFORE it connects. This surfaces the block as an
    // ASYNCHRONOUS 'error' event on the request -- matching how Node reports a
    // real connection failure (ECONNREFUSED etc.) -- rather than throwing
    // synchronously. A synchronous throw breaks any caller that (correctly)
    // expects connection errors on the 'error' event and has not yet attached
    // its handler (e.g. a streaming proxy that has already hijacked the
    // response), producing a hang instead of a clean failure. destroy() aborts
    // before the socket reaches the target, so nothing is dialed.
    const req = original.apply(this, args) as ReturnType<NodeHttpModule["request"]>;
    req.destroy(blockedOriginError(origin));
    return req;
  }

  function guardedRequest(this: unknown, ...args: unknown[]): ReturnType<NodeHttpModule["request"]> {
    if (
      !(
        hasExplicitCustomAgent(args[0], args[1]) ||
        isOriginAllowed(resolveRequestOrigin(args[0], args[1], defaultProtocol))
      )
    ) {
      return blockRequest.call(this, originalRequest, args);
    }
    // biome-ignore lint/suspicious/noExplicitAny: forwarding arbitrary overload args to the original implementation
    return (originalRequest as any).apply(this, args);
  }

  function guardedGet(this: unknown, ...args: unknown[]): ReturnType<NodeHttpModule["get"]> {
    if (
      !(
        hasExplicitCustomAgent(args[0], args[1]) ||
        isOriginAllowed(resolveRequestOrigin(args[0], args[1], defaultProtocol))
      )
    ) {
      return blockRequest.call(this, originalGet, args);
    }
    // biome-ignore lint/suspicious/noExplicitAny: forwarding arbitrary overload args to the original implementation
    return (originalGet as any).apply(this, args);
  }

  // biome-ignore lint/suspicious/noExplicitAny: module export types are overload-heavy; guarded fns are behaviorally compatible
  moduleNamespace.request = guardedRequest as any;
  // biome-ignore lint/suspicious/noExplicitAny: module export types are overload-heavy; guarded fns are behaviorally compatible
  moduleNamespace.get = guardedGet as any;

  restoreList.push(() => {
    moduleNamespace.request = originalRequest;
    moduleNamespace.get = originalGet;
  });
}

/** True for a redirect response (3xx with a `Location`) that fetch would follow on its own. */
function isRedirectResponse(response: Response): boolean {
  return [301, 302, 303, 307, 308].includes(response.status) && response.headers.has("location");
}

/** The origin of an http(s) URL; null for data: and other schemes. */
function httpOriginOf(target: URL): string | null {
  return target.protocol === "http:" || target.protocol === "https:" ? target.origin : null;
}

/** Guard Node's built-in fetch even when npm's undici package is absent. */
function guardFetch(restoreList: Array<() => void>): void {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    return;
  }
  globalThis.fetch = function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // A per-request dispatcher is the caller's explicit connection machinery,
    // just like an explicit http(s).Agent in guardLegacyHttpModule.
    const dispatcher = (init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher;
    if (typeof dispatcher === "object" && dispatcher !== null) {
      return originalFetch(input, init);
    }
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      ({ url } = input);
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      // Preserve fetch's own rejected-promise contract for malformed inputs.
      return originalFetch(input, init);
    }
    const origin = httpOriginOf(target);
    if (origin === null) {
      // data: and other non-HTTP URLs cannot open an ambient HTTP socket.
      return originalFetch(input, init);
    }
    if (!isOriginAllowed(origin)) {
      return Promise.reject(blockedOriginError(origin));
    }
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    if (redirect !== "follow") {
      // 'manual' and 'error' never take a second hop.
      return originalFetch(input, init);
    }
    // Built-in fetch would follow a redirect without re-checking the allowlist,
    // so fetch stops at the first hop and a redirect response is refused.
    return originalFetch(input, { ...init, redirect: "manual" }).then(async (response) => {
      if (!isRedirectResponse(response)) {
        return response;
      }
      await response.body?.cancel();
      throw new Error(
        "hermetic guard: automatic redirects are refused in tests; pass redirect: 'manual' and handle the Location yourself"
      );
    });
  };
  restoreList.push(() => {
    globalThis.fetch = originalFetch;
  });
}

/** Guard direct undici calls if a test actually imports the npm package. */
// undici's own type declarations are not resolvable from this package's
// tsconfig because it is not a root dependency. Rather than
// add a root dependency purely for ambient types, this narrow local shape
// covers exactly the surface this function touches, matching undici's public
// API (https://undici.nodejs.org/#/docs/api/Dispatcher and
// getGlobalDispatcher/setGlobalDispatcher).
interface UndiciDispatchOptions {
  origin?: string | URL;
}
interface UndiciDispatchHandler {
  onError?: (error: Error) => void;
}
interface UndiciDispatcher {
  close: (...args: unknown[]) => unknown;
  destroy: (...args: unknown[]) => unknown;
  dispatch: (options: UndiciDispatchOptions, handler: UndiciDispatchHandler) => boolean;
}
interface UndiciModuleShape {
  Dispatcher: new () => UndiciDispatcher;
  getGlobalDispatcher: () => UndiciDispatcher;
  setGlobalDispatcher: (dispatcher: UndiciDispatcher) => void;
}

function guardUndiciDispatcher(undici: UndiciModuleShape, restoreList: Array<() => void>): void {
  const { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } = undici;
  const previousDispatcher = getGlobalDispatcher();

  class HermeticGuardDispatcher extends Dispatcher {
    private readonly inner: UndiciDispatcher;

    constructor(inner: UndiciDispatcher) {
      super();
      this.inner = inner;
    }

    // Declared as arrow-function properties (not `override <name>(...) {}`
    // methods) to match UndiciDispatcher's property-style method signatures
    // (see the interface above) -- TypeScript requires a subclass's member
    // kind to agree with the base type's for the same key.
    override dispatch = (options: UndiciDispatchOptions, handler: UndiciDispatchHandler): boolean => {
      const origin = String(options.origin ?? "");
      if (!isOriginAllowed(origin)) {
        const error = blockedOriginError(origin);
        if (typeof handler.onError === "function") {
          handler.onError(error);
          return true;
        }
        throw error;
      }
      return this.inner.dispatch(options, handler);
    };

    override close = (...args: unknown[]): unknown => this.inner.close(...args);

    override destroy = (...args: unknown[]): unknown => this.inner.destroy(...args);
  }

  setGlobalDispatcher(new HermeticGuardDispatcher(previousDispatcher));
  restoreList.push(() => setGlobalDispatcher(previousDispatcher));
}

/**
 * Install the hermetic network guard for the current process. Idempotent:
 * calling this twice without an intervening uninstall() is a no-op and
 * returns the existing handle.
 */
export function installHermeticNetworkGuard(): HermeticGuardHandle {
  if (activeHandle) {
    return activeHandle;
  }

  const restoreList: Array<() => void> = [];
  guardFetch(restoreList);

  let netPatched = false;
  let httpPatched = false;
  let httpsPatched = false;
  let resolvingUndici = false;
  let undiciPatched = false;

  const ensureNet = (): void => {
    if (!netPatched) {
      installBindDerivedAuthority(restoreList);
      netPatched = true;
    }
  };
  const ensureTls = (): void => {
    ensureNet();
    if (!tlsServerCtor) {
      const tls = process.getBuiltinModule("node:tls");
      if (!tls) {
        throw new Error("node:tls is unavailable to the hermetic test guard");
      }
      tlsServerCtor = tls.Server as unknown as new (...args: never[]) => unknown;
    }
  };
  const ensureHttp = (): void => {
    if (httpPatched) {
      return;
    }
    ensureNet();
    const http = process.getBuiltinModule("node:http");
    if (!http) {
      throw new Error("node:http is unavailable to the hermetic test guard");
    }
    guardLegacyHttpModule(http, "http:", restoreList);
    syncBuiltinESMExports();
    httpPatched = true;
  };
  const ensureHttps = (): void => {
    if (httpsPatched) {
      return;
    }
    ensureTls();
    const https = process.getBuiltinModule("node:https");
    if (!https) {
      throw new Error("node:https is unavailable to the hermetic test guard");
    }
    guardLegacyHttpModule(https, "https:", restoreList);
    syncBuiltinESMExports();
    httpsPatched = true;
  };

  // A synchronous resolve hook catches both ESM imports and require calls.
  // Core modules load only when test code requests them; helper Node processes
  // pay for the small fetch wrapper but never load net, http, https, or tls.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      switch (specifier) {
        case "net":
        case "node:net":
          ensureNet();
          break;
        case "tls":
        case "node:tls":
          ensureTls();
          break;
        case "http":
        case "node:http":
          ensureHttp();
          break;
        case "https":
        case "node:https":
          ensureHttps();
          break;
        case "undici":
          if (!(undiciPatched || resolvingUndici)) {
            resolvingUndici = true;
            try {
              const parent = context.parentURL?.startsWith("file:")
                ? context.parentURL
                : `${process.cwd()}/package.json`;
              const undici = createRequire(parent)("undici") as UndiciModuleShape;
              guardUndiciDispatcher(undici, restoreList);
              undiciPatched = true;
            } finally {
              resolvingUndici = false;
            }
          }
          break;
        default:
          break;
      }
      return nextResolve(specifier, context);
    },
  });
  restoreList.push(() => hooks.deregister());

  // Explicit installs in unit tests can happen after a test imported a core
  // module. Patch only those already loaded; preloaded test children take the
  // lazy path because their application modules have not loaded yet.
  const { moduleLoadList } = process as NodeJS.Process & { moduleLoadList: string[] };
  const wasLoaded = (name: string): boolean =>
    moduleLoadList.includes(`NativeModule ${name}`) || moduleLoadList.includes(`NativeModule node:${name}`);
  if (wasLoaded("net")) {
    ensureNet();
  }
  if (wasLoaded("tls")) {
    ensureTls();
  }
  if (wasLoaded("http")) {
    ensureHttp();
  }
  if (wasLoaded("https")) {
    ensureHttps();
  }

  const handle: HermeticGuardHandle = {
    installed: true,
    uninstall() {
      for (const restore of restoreList.splice(0, restoreList.length)) {
        restore();
      }
      tlsServerCtor = null;
      activeHandle = undefined;
    },
  };
  activeHandle = handle;
  return handle;
}

/** True if the guard is currently installed in this process. */
export function isHermeticNetworkGuardInstalled(): boolean {
  return activeHandle !== undefined;
}
