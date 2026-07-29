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
// (fetch()/undici and legacy http.request()/https.request()) is checked
// against an explicit allowlist of origins. Anything not on the allowlist is
// refused before a socket is ever opened -- surfaced as a connection-refused
// error (ECONNREFUSED) on the request, matching Node's real connection-failure
// contract, so callers that await the 'error' event (proxies, clients) fail
// cleanly instead of hanging. A request that supplies its OWN connection
// machinery (an explicit http(s).Agent, or a per-request undici dispatcher) is
// deferred to that machinery rather than guarded, since that is the caller's
// declared connection intent (e.g. the product's loopback-pinned SSRF agent).
//
// AUTHORITY IS BIND-DERIVED. The allowlist is not populated by per-test
// registration calls. Instead, the guard patches the ONE bind-lifecycle
// seam that every in-process server passes through -- net.Server.prototype
// .listen (which http.Server and https.Server both inherit unchanged, and
// which Fastify's app.listen() bottoms out at). When a server in THIS
// process finishes binding a port (the 'listening' event -- i.e. the bind
// actually succeeded and reported an address), the guard grants authority
// for that exact bound port over its loopback spellings, and revokes it
// again on 'close'. A test therefore reaches a server it itself started by
// any loopback spelling, and nothing else -- not a different port, not a
// different host, and not a port a foreign/production process happens to
// hold (7662).
//
// This module is inert until installHermeticNetworkGuard() is called. It is
// never imported by product/runtime code paths -- see preload.ts, which is
// the only intended call site, wired into the test runner and gated on
// PDPP_HERMETIC_GUARD.

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

/** Normalize a URL-ish string down to its origin: `protocol//host:port`. */
function normalizeOrigin(input: string): string {
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

// Loopback host spellings that all resolve to the same local interface. When
// a server binds a loopback or wildcard address, a test may reach it by any
// of these spellings, so the grant covers all of them at the bound port --
// and ONLY at the bound port.
const LOOPBACK_HOST_SPELLINGS = ["localhost", "127.0.0.1", "[::1]"] as const;

// Addresses that mean "every local interface". A server bound to one of
// these is reachable via loopback, so the grant uses the loopback spelling
// set rather than the literal wildcard (which is not a dialable host).
const WILDCARD_BIND_ADDRESSES = new Set(["0.0.0.0", "::", ""]);

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

/**
 * Given a bound AddressInfo and whether the server is TLS, produce the exact
 * set of origins to grant. Loopback/wildcard binds grant every loopback
 * spelling at that port; a specific non-loopback bind grants only that exact
 * host:port. Never broadens to another port or an unrelated host.
 */
function boundOrigins(protocol: "http:" | "https:", address: string, port: number): string[] {
  if (WILDCARD_BIND_ADDRESSES.has(address) || isLoopbackAddress(address)) {
    return LOOPBACK_HOST_SPELLINGS.map((host) => `${protocol}//${host}:${port}`);
  }
  // A concrete, non-loopback interface (e.g. a specific LAN IP). Grant only
  // that literal host:port -- do not widen to loopback spellings it was not
  // bound on. IPv6 literals must be bracketed to form a valid origin host.
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

/**
 * Attach the grant/revoke lifecycle to a single server instance the moment
 * its listen() call has been issued. The grant is applied on 'listening'
 * (bind SUCCEEDED and address() is populated) -- never merely on listen()
 * being called -- and withdrawn on 'close'. A bind that fails emits 'error'
 * and never 'listening', so it grants nothing.
 */
function attachBindAuthority(server: NetServer): void {
  // Detect TLS at grant time (a tls.Server is an https listener). Imported
  // lazily to avoid a hard node:tls dependency in the hot patch path.
  let granted: string[] | undefined;

  const onListening = (): void => {
    if (granted) {
      return;
    }
    const info = server.address();
    if (info === null || typeof info === "string") {
      // A Unix-domain socket (string) or no address -- not an IP origin the
      // HTTP guard can key on. Nothing to grant.
      return;
    }
    const protocol = isTlsServer(server) ? "https:" : "http:";
    granted = boundOrigins(protocol, info.address, info.port);
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
}

// node:tls's Server extends net.Server; an https listener IS a tls.Server.
// The constructor is resolved once at install time (async import) and cached
// so the 'listening' handler can classify protocol synchronously.
let tlsServerCtor: (new (...args: never[]) => unknown) | null = null;
function isTlsServer(server: NetServer): boolean {
  return tlsServerCtor !== null && server instanceof tlsServerCtor;
}

/**
 * Patch net.Server.prototype.listen -- the single seam every in-process
 * server (raw http/https/net, and Fastify's app.listen) passes through -- so
 * each server that successfully binds a port grants its own origin and
 * revokes it on close. Returns a restore function.
 */
async function installBindDerivedAuthority(): Promise<() => void> {
  const net = await import("node:net");
  try {
    const tls = await import("node:tls");
    tlsServerCtor = tls.Server as unknown as new (...args: never[]) => unknown;
  } catch {
    tlsServerCtor = null;
  }
  const proto = net.Server.prototype;
  const original = proto.listen as NetServer["listen"];

  if ((original as PatchedListen).__pdppHermeticPatched) {
    // Already patched (idempotent install). Leave it; restore is a no-op.
    return () => undefined;
  }

  const patched: PatchedListen = function patchedListen(this: NetServer, ...args: ListenArgs): NetServer {
    attachBindAuthority(this);
    return (original as (this: NetServer, ...a: ListenArgs) => NetServer).apply(this, args);
  };
  patched.__pdppHermeticPatched = true;
  patched.__pdppOriginalListen = original;
  proto.listen = patched as NetServer["listen"];

  return () => {
    if (proto.listen === (patched as NetServer["listen"])) {
      proto.listen = original;
    }
  };
}

// ─── Outbound request interception ──────────────────────────────────────────

type NodeHttpModule = typeof import("node:http");
type NodeHttpsModule = typeof import("node:https");

/** Extract the plain options object from a `http.request(url, options?, cb?)` /
 * `http.request(options, cb?)` overload pair, whichever position it's in. */
function extractRequestOptionsObject(firstArg: unknown, secondArg: unknown): Record<string, unknown> {
  if (typeof firstArg === "object" && firstArg !== null && !(firstArg instanceof URL)) {
    return firstArg as Record<string, unknown>;
  }
  if (typeof secondArg === "object" && secondArg !== null) {
    return secondArg as Record<string, unknown>;
  }
  return {};
}

function resolveHostFromOptions(opts: Record<string, unknown>): string {
  if (typeof opts.hostname === "string") {
    return opts.hostname;
  }
  if (typeof opts.host === "string") {
    return opts.host;
  }
  return "localhost";
}

/** Resolve the origin a `http(s).request`/`.get` call is about to reach,
 * covering both the string-URL and options-object call signatures. */
function resolveRequestOrigin(firstArg: unknown, secondArg: unknown, defaultProtocol: "http:" | "https:"): string {
  if (typeof firstArg === "string") {
    return normalizeOrigin(firstArg);
  }
  if (firstArg instanceof URL) {
    return normalizeOrigin(firstArg.href);
  }
  // node:http also accepts (options, callback) where options is a plain
  // object with host/port/protocol -- reconstruct just enough to check.
  const opts = extractRequestOptionsObject(firstArg, secondArg);
  const protocol = typeof opts.protocol === "string" ? opts.protocol : defaultProtocol;
  const host = resolveHostFromOptions(opts);
  const port = typeof opts.port === "number" || typeof opts.port === "string" ? `:${opts.port}` : "";
  return normalizeOrigin(`${protocol}//${host}${port}`);
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
 * intent. In the RI suite this is the product's own SSRF-defense agent
 * (createPinnedHttpsAgent), which validates and pins the connection to
 * loopback before dialing -- the hermetic guard's ambient-reach concern is
 * already handled there. This is NOT a host allowlist and NOT a localhost
 * allow: a plain default request to ANY unbound origin is still blocked.
 */
function hasExplicitCustomAgent(firstArg: unknown, secondArg: unknown): boolean {
  const { agent } = extractRequestOptionsObject(firstArg, secondArg);
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

/**
 * Best-effort: also guard undici's global dispatcher, which is what
 * Node's built-in fetch() uses. undici is only resolvable from within
 * reference-implementation's own dependency tree (it is a direct RI
 * dependency), not from the repo root, so this resolves relative to the
 * caller's cwd rather than this module's own location. If it can't be
 * resolved (e.g. invoked from a context without undici on the path) this
 * degrades to legacy-http-only enforcement rather than throwing -- the
 * intended call site (reference-implementation's test runner) always has
 * cwd inside reference-implementation, so resolution succeeds there.
 */
// undici's own type declarations are not resolvable from this package's
// tsconfig (undici is only a direct dependency inside reference-implementation,
// not at the repo root -- see the module-resolution note above). Rather than
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

async function guardUndiciDispatcher(restoreList: Array<() => void>): Promise<void> {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");

  let undici: UndiciModuleShape;
  try {
    const req = createRequire(pathToFileURL(join(process.cwd(), "package.json")).href);
    const resolved = req.resolve("undici");
    undici = (await import(pathToFileURL(resolved).href)) as UndiciModuleShape;
  } catch {
    // No undici resolvable from this cwd -- fetch() calls will fall through
    // to Node's own internal dispatcher unguarded. Legacy http/https client
    // calls are still guarded above.
    return;
  }

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
export async function installHermeticNetworkGuard(): Promise<HermeticGuardHandle> {
  if (activeHandle) {
    return activeHandle;
  }

  const restoreList: Array<() => void> = [];

  // Patch the bind seam FIRST so any server that starts listening after the
  // guard installs auto-grants its origin. (Servers already listening before
  // install are the exception -- but the intended call site preloads the
  // guard before any test code runs, so servers are bound after.)
  restoreList.push(await installBindDerivedAuthority());

  // node:http/node:https's *namespace* object from a dynamic import() is a
  // frozen ES module namespace and cannot be mutated. The `.default` export
  // is Node's underlying CJS module.exports object, which is a regular
  // mutable object -- that's the one every other importer's `import http
  // from 'node:http'` binding actually reads through, so patching it there
  // is what makes the guard visible to the rest of the process.
  const http = (await import("node:http")).default;
  const https = (await import("node:https")).default;
  guardLegacyHttpModule(http, "http:", restoreList);
  guardLegacyHttpModule(https, "https:", restoreList);
  await guardUndiciDispatcher(restoreList);

  const handle: HermeticGuardHandle = {
    installed: true,
    uninstall() {
      for (const restore of restoreList.splice(0, restoreList.length)) {
        restore();
      }
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
