// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-exposure posture — the single source of truth for "is this reference
 * deployment internet-facing, and therefore must owner auth be mandatory?"
 *
 * This module is pure: it derives a posture from explicit inputs (env snapshot
 * + start options) and never reads `process.env`, never touches the network,
 * and never imports server-internal route/auth/transport modules. That keeps it
 * exhaustively unit-testable and lets `server/index.js` own the env read.
 *
 * Why this exists (security audit S-1, lane A1):
 *   `requireOwnerSession` historically did `if (!enabled) next()` — when
 *   `PDPP_OWNER_PASSWORD` was unset, EVERY protected `/_ref` owner route was
 *   open. On a hosted deploy that binds a public interface, that is a full
 *   bypass of the owner control plane (connection delete/revoke, deployment
 *   diagnostics env dump, scheduler controls, manual run trigger). Local dev,
 *   by contrast, legitimately wants password-optional convenience.
 *
 * The fix distinguishes the two by an HONEST hosting signal the deployment
 * already carries, then fails closed in the hosted posture:
 *   - hosted + no password  → refuse to boot (the caller throws)
 *   - hosted + password      → normal owner-gated operation
 *   - local-dev (loopback)   → password optional; open behavior preserved
 *
 * Operators retain two explicit overrides:
 *   - PDPP_HOSTED=1 / PDPP_HOSTED=0 — force the classification either way.
 *   - PDPP_ALLOW_UNAUTHENTICATED_OWNER=1 — escape hatch that keeps the open
 *     posture even when hosting is detected (loudly warned, never silent).
 */

export interface OwnerExposureEnv {
  readonly AS_PUBLIC_URL?: string | undefined;
  readonly NODE_ENV?: string | undefined;
  readonly PDPP_ALLOW_UNAUTHENTICATED_OWNER?: string | undefined;
  readonly PDPP_HOSTED?: string | undefined;
  readonly PDPP_LOCK_CONNECTOR_REGISTRY?: string | undefined;
  readonly PDPP_REFERENCE_ORIGIN?: string | undefined;
}

export interface OwnerExposureInputs {
  /** Interface the AS/RS listeners bind to (`opts.bindHost`). */
  readonly bindHost?: string | null | undefined;
  /** Process env snapshot. The caller passes `process.env`. */
  readonly env?: OwnerExposureEnv | undefined;
  /** Whether owner auth is enabled (i.e. a non-empty password is configured). */
  readonly hasOwnerPassword: boolean;
  /**
   * True when running under the Node test runner (NODE_TEST_CONTEXT). Tests
   * fabricate hosted-looking env via the shell, so we never derive a hosted
   * posture from ambient env in that mode — only from explicit options.
   */
  readonly isTestContext?: boolean | undefined;
  /** Explicit public origin from start options (`opts.asPublicUrl`). */
  readonly publicUrlOption?: string | null | undefined;
}

export interface OwnerExposurePosture {
  /**
   * True when `requireOwnerSession` should fall through to open local-dev
   * behavior while owner auth is disabled. False = fail closed (401/redirect).
   */
  readonly allowUnauthenticatedOwnerWhenDisabled: boolean;
  /**
   * The bind host is a non-loopback interface (LAN/public). Used to decide
   * whether to emit the "exposed without a password" stderr warning.
   */
  readonly bindsNonLoopback: boolean;
  /**
   * True when the deployment is internet-facing intent and a non-empty owner
   * password MUST be configured. The caller throws at boot when this is true
   * and `hasOwnerPassword` is false (unless explicitly overridden).
   */
  readonly hosted: boolean;
  /** Human-readable signals that drove the hosted classification (for logs). */
  readonly hostedSignals: readonly string[];
  /**
   * True when `POST /connectors` (manifest upsert) MUST require an owner
   * session. A manifest upsert can bump `version` and invalidate every grant,
   * so we lock it whenever hosted OR when explicitly requested.
   */
  readonly lockConnectorRegistry: boolean;
  /**
   * Set when the caller should refuse to boot: hosted intent with no password
   * and no explicit unauthenticated override. Null when boot may proceed.
   */
  readonly refuseBootReason: string | null;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function isTruthyFlag(value: string | undefined): boolean {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function isFalsyFlag(value: string | undefined): boolean {
  return typeof value === "string" && FALSE_VALUES.has(value.trim().toLowerCase());
}

function stripBrackets(hostname: string): string {
  // IPv6 literals arrive bracketed in URLs (`[::1]`); strip for comparison.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Loopback for *exposure* classification. NOTE: unlike URL-origin loopback
 * checks elsewhere, a bind host of `0.0.0.0` / `::` here is NOT loopback — it
 * means "all interfaces", which is the most-exposed bind possible.
 */
export function isLoopbackBindHost(host: string | null | undefined): boolean {
  if (typeof host !== "string") {
    // Node's default (undefined bindHost) binds all interfaces → exposed.
    return false;
  }
  const normalized = stripBrackets(host.trim().toLowerCase());
  if (!normalized) {
    return false;
  }
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

/**
 * Loopback for an origin URL's hostname. Here `0.0.0.0` is treated as a
 * non-public degenerate dev address (matches the dev-default behavior where
 * the origin is `http://localhost:PORT`).
 */
function isLoopbackOriginHost(hostname: string): boolean {
  const normalized = stripBrackets(hostname.trim().toLowerCase());
  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.endsWith(".local")
  );
}

/**
 * True when `origin` is a parseable absolute URL whose host is NOT loopback —
 * i.e. an internet-facing public origin (`https://app.fly.dev`,
 * `https://pdpp.example.com`). Returns false for loopback origins and for
 * unparseable / empty values.
 */
function isNonLoopbackOrigin(origin: string | null | undefined): boolean {
  if (typeof origin !== "string" || !origin.trim()) {
    return false;
  }
  try {
    const url = new URL(origin.trim());
    return !isLoopbackOriginHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Derive the owner-exposure posture from env + start options. Pure function;
 * see module header for the rationale and the override knobs.
 */
export function resolveOwnerExposurePosture(inputs: OwnerExposureInputs): OwnerExposurePosture {
  const env = inputs.env ?? {};
  const hostedSignals: string[] = [];

  const forcedHosted = isTruthyFlag(env.PDPP_HOSTED);
  const forcedLocal = isFalsyFlag(env.PDPP_HOSTED);
  const allowUnauthenticatedOverride = isTruthyFlag(env.PDPP_ALLOW_UNAUTHENTICATED_OWNER);
  const lockRegistryOverride = isTruthyFlag(env.PDPP_LOCK_CONNECTOR_REGISTRY);

  const bindsNonLoopback = !isLoopbackBindHost(inputs.bindHost);

  // Inferred hosting signals are ignored under the Node test runner: hundreds
  // of tests legitimately set a non-loopback `asPublicUrl` / `AS_PUBLIC_URL` /
  // `PDPP_REFERENCE_ORIGIN` or an explicit bind host to exercise origin,
  // metadata, and CIMD logic WITHOUT intending to test hosted owner-auth (and
  // without a password). Treating those as hosted would break suite
  // hermeticity. So in test context only the EXPLICIT operator overrides
  // (`PDPP_HOSTED=1`, `PDPP_ALLOW_UNAUTHENTICATED_OWNER=1`) drive the posture;
  // tests that need the hosted boot-refusal set `PDPP_HOSTED=1`. In production
  // the inferred signals are honored — that is the whole point of failing
  // closed on a real deploy that forgot the password.
  const considerInferred = !inputs.isTestContext;

  if (forcedHosted) {
    hostedSignals.push("PDPP_HOSTED=1");
  }
  if (considerInferred && env.NODE_ENV === "production") {
    hostedSignals.push("NODE_ENV=production");
  }
  if (considerInferred && isNonLoopbackOrigin(env.PDPP_REFERENCE_ORIGIN)) {
    hostedSignals.push("PDPP_REFERENCE_ORIGIN=<non-loopback>");
  }
  if (considerInferred && isNonLoopbackOrigin(env.AS_PUBLIC_URL)) {
    hostedSignals.push("AS_PUBLIC_URL=<non-loopback>");
  }
  if (considerInferred && isNonLoopbackOrigin(inputs.publicUrlOption)) {
    hostedSignals.push("asPublicUrl=<non-loopback>");
  }
  if (considerInferred && bindsNonLoopback && inputs.bindHost != null) {
    // An explicit non-loopback bind host (e.g. 0.0.0.0 / a LAN IP) is an
    // internet-facing intent. An undefined bindHost also binds all interfaces,
    // but that is the local-dev default and must not, on its own, force hosted
    // mode — so we only count an EXPLICIT non-loopback bind here.
    hostedSignals.push(`bindHost=${inputs.bindHost}`);
  }

  const hosted = forcedLocal ? false : forcedHosted || hostedSignals.length > 0;

  const refuseBoot = hosted && !inputs.hasOwnerPassword && !allowUnauthenticatedOverride;
  const refuseBootReason = refuseBoot
    ? `Refusing to start: this reference deployment looks internet-facing (${hostedSignals.join(", ")}) but PDPP_OWNER_PASSWORD is unset or empty. Set PDPP_OWNER_PASSWORD so the owner control plane (connection delete/revoke, deployment diagnostics, scheduler, manual runs) is not exposed. To intentionally run an unauthenticated owner surface (NOT for public deployments), set PDPP_ALLOW_UNAUTHENTICATED_OWNER=1.`
    : null;

  // When owner auth is disabled, fall through to open behavior ONLY in a
  // local-dev posture (not hosted) or under the explicit override. In hosted
  // mode the boot guard above prevents reaching here without a password, but
  // we still fail closed as defense in depth.
  const allowUnauthenticatedOwnerWhenDisabled = allowUnauthenticatedOverride || !hosted;

  // Lock the connector registry (POST /connectors) whenever hosted or when the
  // operator explicitly opts in. A manifest upsert that bumps `version`
  // invalidates every existing grant — a one-request grant-wipe DoS — so it
  // must be owner-authenticated on any internet-facing surface.
  const lockConnectorRegistry = (hosted || lockRegistryOverride) && !allowUnauthenticatedOverride;

  return {
    hosted,
    hostedSignals,
    bindsNonLoopback,
    refuseBootReason,
    allowUnauthenticatedOwnerWhenDisabled,
    lockConnectorRegistry,
  };
}
