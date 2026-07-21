// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared route-adapter <-> host contract types for the `server/routes/*.ts`
// family adapters.
//
// PDPP exposes an Express-shaped wrapper from `server/transport.js`. Each
// route-family adapter (extracted from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`) describes the slice of
// that surface it consumes with structural types, because the transport file
// is untyped (`.js`) and pulling in its ambient types would couple every
// adapter to the transport implementation.
//
// The per-adapter `RouteRequest` / `RouteResponse` / `AppLike` shapes stay in
// each adapter on purpose: they document exactly which request fields and HTTP
// verbs that family touches, and they intentionally differ. The types here are
// the parts of the contract that do NOT vary between adapters - a middleware
// handler is always `(...args: unknown[]) => unknown`, the registration arg
// union is always `{ contract? } | middleware | handler`, and the host's PDPP
// error writer always has the same signature. Sharing only the invariant parts
// keeps a single source of truth without widening any adapter's documented
// request/response surface.

// A middleware passed alongside the final route handler (e.g.
// `requireOwnerSession`, `requireCsrf`). The transport forwards these
// positionally, so the structural shape is intentionally permissive.
export type MiddlewareHandler = (...args: unknown[]) => unknown;

// Args accepted by `app.get/post/...` in registration order: an optional
// config object (e.g. `{ contract: 'opId' }`), zero or more middlewares, and
// the final handler. `H` is the adapter's own route-handler type, which is
// bound to that adapter's `RouteRequest` / `RouteResponse`.
export type RouteArg<H> = Readonly<{ bodyLimit?: number; contract?: string }> | MiddlewareHandler | H;

// The host's PDPP error-envelope writer (defined in `server/index.js`). Writes
// the canonical `pdpp_error` response shape and returns whatever the transport
// `res.json(...)` returns. `param` names the offending request field; `extras`
// carries additional envelope fields (e.g. `accepted_versions`). Both are
// optional, so adapters that never pass them are assignment-compatible.
export type PdppErrorFn = (
  res: unknown,
  status: number,
  code: string,
  message: string | undefined,
  param?: string | null,
  extras?: Readonly<Record<string, unknown>> | null
) => unknown;

// Capability-shaped namespace bag — the host resolver returns at least these
// fields. Other resolver-only fields pass through opaquely.
export interface ConnectorNamespace {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly sourceKind?: string | null;
}

export function assertRemoteControlSupported(namespace: ConnectorNamespace): void {
  if (namespace.sourceKind === "local_device") {
    const error = new Error("Local-device connections are collected by their paired device.") as Error & {
      code: string;
    };
    error.code = "local_device_control_unsupported";
    throw error;
  }
}

export interface ActiveBinding {
  readonly connectorId?: string | null;
  readonly connectorInstanceId: string;
  readonly displayName?: string | null;
}

export interface WireConnection {
  connection_id: string;
  display_name?: string;
}

export interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

// Typed ambiguity error the host's `AmbiguousConnectionError` produces. The
// host writer (`handleError`) maps `code: "ambiguous_connection"` to HTTP 409
// and copies `available_connections` / `retry_with` onto the envelope.
export interface AmbiguousConnectionErrorLike extends Error {
  available_connections: WireConnection[];
  code: string;
  retry_with: string;
}
