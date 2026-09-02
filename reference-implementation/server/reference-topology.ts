// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared reference topology helpers for the local reference product.
 *
 * PDPP protocol truth still lives in the AS/RS surfaces. This module only
 * centralizes how the local reference product derives:
 * - internal AS/RS listen targets
 * - the browser-facing reference origin
 * - whether the current hosting shape is direct or composed
 *
 * These helpers are reference-hosting support, not PDPP protocol semantics.
 */

export const REFERENCE_MODE_DIRECT = "direct";
export const REFERENCE_MODE_COMPOSED = "composed";

export const DEFAULT_REFERENCE_BROWSER_ORIGIN = "http://localhost:3002";
export const DEFAULT_AS_INTERNAL_URL = "http://localhost:7662";
export const DEFAULT_RS_INTERNAL_URL = "http://localhost:7663";

export type ReferenceMode = typeof REFERENCE_MODE_DIRECT | typeof REFERENCE_MODE_COMPOSED;

export type ReferenceEnv = Record<string, string | undefined>;

export interface ResolveReferenceModeOptions {
  readonly asPublicUrl?: string | null;
  readonly env?: ReferenceEnv;
  readonly explicitMode?: string | null;
  readonly ignoreAmbient?: boolean;
  readonly referenceOrigin?: string | null;
  readonly rsPublicUrl?: string | null;
}

export interface ResolveReferenceBrowserOriginOptions {
  readonly env?: ReferenceEnv;
  readonly explicitOrigin?: string | null;
  readonly requestOrigin?: string | null;
}

export interface ResolveReferenceTopologyOptions extends ResolveReferenceModeOptions {
  readonly requestOrigin?: string | null;
}

export interface ReferenceTopology {
  readonly asInternalUrl: string;
  readonly asPublicUrl: string;
  readonly browserOrigin: string | null;
  readonly mode: ReferenceMode;
  readonly rsInternalUrl: string;
  readonly rsPublicUrl: string;
}

const TRAILING_SLASHES = /\/+$/;

export function stripTrailingSlash(value: unknown): string {
  return String(value || "").replace(TRAILING_SLASHES, "");
}

function readTrimmedValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function resolveReferenceMode({
  explicitMode,
  ignoreAmbient = false,
  env = process.env,
  asPublicUrl,
  rsPublicUrl,
  referenceOrigin,
}: ResolveReferenceModeOptions = {}): ReferenceMode {
  const normalizedExplicitMode = readTrimmedValue(explicitMode)?.toLowerCase();
  if (normalizedExplicitMode === REFERENCE_MODE_DIRECT) {
    return REFERENCE_MODE_DIRECT;
  }
  if (normalizedExplicitMode === REFERENCE_MODE_COMPOSED) {
    return REFERENCE_MODE_COMPOSED;
  }

  const normalizedAsPublicUrl = readTrimmedValue(asPublicUrl);
  const normalizedRsPublicUrl = readTrimmedValue(rsPublicUrl);
  const normalizedReferenceOrigin = readTrimmedValue(referenceOrigin);
  if (normalizedAsPublicUrl || normalizedRsPublicUrl || normalizedReferenceOrigin) {
    return REFERENCE_MODE_COMPOSED;
  }

  if (ignoreAmbient) {
    return REFERENCE_MODE_DIRECT;
  }

  const ambientMode = readTrimmedValue(env.PDPP_REFERENCE_MODE)?.toLowerCase();
  if (ambientMode === REFERENCE_MODE_DIRECT) {
    return REFERENCE_MODE_DIRECT;
  }
  if (ambientMode === REFERENCE_MODE_COMPOSED) {
    return REFERENCE_MODE_COMPOSED;
  }

  if (
    readTrimmedValue(env.AS_PUBLIC_URL) ||
    readTrimmedValue(env.RS_PUBLIC_URL) ||
    readTrimmedValue(env.PDPP_REFERENCE_ORIGIN)
  ) {
    return REFERENCE_MODE_COMPOSED;
  }

  return REFERENCE_MODE_DIRECT;
}

export function resolveReferenceBrowserOrigin({
  explicitOrigin,
  requestOrigin,
  env = process.env,
}: ResolveReferenceBrowserOriginOptions = {}): string {
  return stripTrailingSlash(
    readTrimmedValue(requestOrigin) ||
      readTrimmedValue(explicitOrigin) ||
      readTrimmedValue(env.PDPP_REFERENCE_ORIGIN) ||
      DEFAULT_REFERENCE_BROWSER_ORIGIN
  );
}

export function resolveReferenceTopology({
  explicitMode,
  referenceOrigin,
  requestOrigin,
  asPublicUrl,
  rsPublicUrl,
  ignoreAmbient = false,
  env = process.env,
}: ResolveReferenceTopologyOptions = {}): ReferenceTopology {
  const mode = resolveReferenceMode({
    asPublicUrl: asPublicUrl ?? null,
    env,
    explicitMode: explicitMode ?? null,
    ignoreAmbient,
    referenceOrigin: referenceOrigin ?? null,
    rsPublicUrl: rsPublicUrl ?? null,
  });

  const browserOrigin =
    mode === REFERENCE_MODE_COMPOSED
      ? resolveReferenceBrowserOrigin({
          env,
          explicitOrigin: referenceOrigin ?? null,
          requestOrigin: requestOrigin ?? null,
        })
      : null;

  // `browserOrigin` falls back to the placeholder `DEFAULT_REFERENCE_BROWSER_ORIGIN`
  // when nothing configures it — fine for its own advisory purpose (the
  // owner-agent-onboarding landing hint), but `asPublicUrl`/`rsPublicUrl` feed
  // the AS/RS's own protocol-critical `resource_metadata`/issuer URLs. Letting
  // the placeholder leak into those meant an operator who never set
  // PDPP_REFERENCE_ORIGIN (or whose deploy artifact stopped baking a stale
  // one) still got a boot-time-fixed wrong port baked into `explicitResource`,
  // silently overriding the correct per-request Host-header derivation that
  // `resolvePublicUrl` already falls back to when no explicit value exists.
  // Only an EXPLICITLY configured origin (requestOrigin/referenceOrigin/env)
  // is trustworthy enough to become the AS/RS's own advertised base; the bare
  // placeholder is not.
  const explicitBrowserOrigin =
    mode === REFERENCE_MODE_COMPOSED
      ? stripTrailingSlash(
          readTrimmedValue(requestOrigin) ||
            readTrimmedValue(referenceOrigin) ||
            readTrimmedValue(env.PDPP_REFERENCE_ORIGIN) ||
            ""
        ) || null
      : null;

  return {
    asInternalUrl: stripTrailingSlash(readTrimmedValue(env.PDPP_AS_URL) || DEFAULT_AS_INTERNAL_URL),
    asPublicUrl: stripTrailingSlash(readTrimmedValue(asPublicUrl) || explicitBrowserOrigin || ""),
    browserOrigin,
    mode,
    rsInternalUrl: stripTrailingSlash(readTrimmedValue(env.PDPP_RS_URL) || DEFAULT_RS_INTERNAL_URL),
    rsPublicUrl: stripTrailingSlash(readTrimmedValue(rsPublicUrl) || explicitBrowserOrigin || ""),
  };
}
