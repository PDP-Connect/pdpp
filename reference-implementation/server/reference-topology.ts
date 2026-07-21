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
    readTrimmedValue(explicitOrigin) ||
      readTrimmedValue(env.PDPP_REFERENCE_ORIGIN) ||
      readTrimmedValue(requestOrigin) ||
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
    explicitMode: explicitMode ?? null,
    ignoreAmbient,
    env,
    asPublicUrl: asPublicUrl ?? null,
    rsPublicUrl: rsPublicUrl ?? null,
    referenceOrigin: referenceOrigin ?? null,
  });

  const browserOrigin =
    mode === REFERENCE_MODE_COMPOSED
      ? resolveReferenceBrowserOrigin({
          explicitOrigin: referenceOrigin ?? null,
          requestOrigin: requestOrigin ?? null,
          env,
        })
      : null;

  return {
    mode,
    browserOrigin,
    asInternalUrl: stripTrailingSlash(readTrimmedValue(env.PDPP_AS_URL) || DEFAULT_AS_INTERNAL_URL),
    rsInternalUrl: stripTrailingSlash(readTrimmedValue(env.PDPP_RS_URL) || DEFAULT_RS_INTERNAL_URL),
    asPublicUrl: stripTrailingSlash(readTrimmedValue(asPublicUrl) || browserOrigin || ""),
    rsPublicUrl: stripTrailingSlash(readTrimmedValue(rsPublicUrl) || browserOrigin || ""),
  };
}
