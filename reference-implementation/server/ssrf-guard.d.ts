// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ambient declarations for the shared SSRF guard helpers.
 *
 * The implementation is still JS (`ssrf-guard.js`, mirroring `cimd.js`'s own
 * JS+ambient-.d.ts pairing). Consuming TS modules need explicit parameter and
 * return types here — TypeScript's inference on JS destructuring defaults
 * does not reliably narrow discriminated-union returns.
 *
 * Keep this file in lockstep with ssrf-guard.js.
 */

export const MAX_VALIDATED_ADDRESSES: number;

export function isGlobalUnicastAddress(ip: string): boolean;

/** @deprecated Legacy alias: `isForbiddenIp(ip) === !isGlobalUnicastAddress(ip)`. Prefer `isGlobalUnicastAddress`. */
export function isForbiddenIp(ip: string): boolean;

export type DnsLookupAll = (hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>>;

export interface ResolveAllowedAddressesOptions {
  dnsLookupImpl?: DnsLookupAll;
  isGlobalUnicastAddressImpl?: (ip: string) => boolean;
  maxAddresses?: number;
}

export type ResolveAllowedAddressesResult =
  | { ok: true; addresses: readonly string[] }
  | { ok: false; kind: "dns_failed" | "no_addresses" }
  | { ok: false; kind: "too_many_addresses"; count: number; max: number }
  | { ok: false; kind: "forbidden_address"; address: string };

export function resolveAllowedAddresses(
  hostname: string,
  options?: ResolveAllowedAddressesOptions
): Promise<ResolveAllowedAddressesResult>;

/**
 * An `undici.Agent`-shaped dispatcher pinned to `validatedAddresses`. Typed as
 * `unknown` here (not `undici.Agent`) because Node's global `fetch` types come
 * from a separate `undici-types` package instance than the `undici` npm
 * dependency this is built from — structurally identical at runtime, nominally
 * distinct in TypeScript. Callers cast at the `fetch({ dispatcher })` boundary.
 */
export function createPinnedDispatcher(validatedAddresses: readonly string[]): {
  close(): Promise<void>;
};

/**
 * A `node:https.Agent` subclass instance pinned to `validatedAddresses`, for
 * callers that use `node:https` directly (e.g. the `web-push` package's
 * caller-supplied `agent` option, which is validated with
 * `instanceof https.Agent`).
 */
export function createPinnedHttpsAgent(
  validatedAddresses: readonly string[],
  agentOptions?: Record<string, unknown>
): unknown;
