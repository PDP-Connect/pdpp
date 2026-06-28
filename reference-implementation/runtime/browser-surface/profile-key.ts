export type BrowserSurfaceProfileManifest =
  | {
      readonly capabilities?: unknown;
    }
  | null
  | undefined;

/**
 * Returns the remote-browser profile key used by both runtime leasing and
 * operator health projection. Multi-account/connection profiles are scoped by
 * concrete connector instance so stale legacy surfaces cannot poison another
 * connection's health.
 */
export function readBrowserSurfaceProfileKey(
  connectorId: string,
  connectorInstanceId: string,
  manifest: BrowserSurfaceProfileManifest
): string {
  const caps = manifest && typeof manifest === "object" ? (manifest as { capabilities?: unknown }).capabilities : null;
  const browserSurface =
    caps && typeof caps === "object" ? (caps as { browser_surface?: unknown }).browser_surface : null;
  const profileKey =
    browserSurface && typeof browserSurface === "object"
      ? (browserSurface as { profile_key?: unknown }).profile_key
      : null;
  const baseProfileKey = typeof profileKey === "string" && profileKey.trim() ? profileKey.trim() : connectorId;
  return connectorInstanceId === connectorId ? baseProfileKey : `${baseProfileKey}:${connectorInstanceId}`;
}
