export const REFERENCE_MODE_DIRECT: 'direct';
export const REFERENCE_MODE_COMPOSED: 'composed';

export const DEFAULT_REFERENCE_BROWSER_ORIGIN: string;
export const DEFAULT_AS_INTERNAL_URL: string;
export const DEFAULT_RS_INTERNAL_URL: string;

export function stripTrailingSlash(value: string): string;

export type ReferenceMode = 'direct' | 'composed';

export function resolveReferenceMode(opts?: {
  explicitMode?: string | null;
  ignoreAmbient?: boolean;
  env?: Record<string, string | undefined>;
  asPublicUrl?: string | null;
  rsPublicUrl?: string | null;
  referenceOrigin?: string | null;
}): ReferenceMode;

export function resolveReferenceBrowserOrigin(opts?: {
  explicitOrigin?: string | null;
  requestOrigin?: string | null;
  env?: Record<string, string | undefined>;
}): string;

export function resolveReferenceTopology(opts?: {
  explicitMode?: string | null;
  referenceOrigin?: string | null;
  requestOrigin?: string | null;
  asPublicUrl?: string | null;
  rsPublicUrl?: string | null;
  ignoreAmbient?: boolean;
  env?: Record<string, string | undefined>;
}): {
  mode: ReferenceMode;
  browserOrigin: string | null;
  asInternalUrl: string;
  rsInternalUrl: string;
  asPublicUrl: string;
  rsPublicUrl: string;
};
