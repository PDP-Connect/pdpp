/**
 * The persisted surface table retains history. A completed replacement can be
 * current only when a surface independently observed as current during this
 * refresh carries exactly one scoped browser-generation hash.
 */
export interface PersistedBrowserSurfaceGeneration {
  readonly browser_generation_hash?: unknown;
  readonly connector_id: string;
  readonly profile_key: string;
  readonly surface_id: string;
  readonly surface_subject_id?: string;
}

export interface BrowserSurfaceCurrentnessRow extends PersistedBrowserSurfaceGeneration {
  readonly health: "ready" | "starting" | "stopping" | "unhealthy";
}

function isLiveCurrentProcess(surface: BrowserSurfaceCurrentnessRow): boolean {
  // `stopping` rows are retained until stop completion and are explicitly not
  // a process boundary. `unhealthy` is likewise not positive proof that the
  // process remains current; active demand still opens the boundary separately.
  return surface.health === "ready" || surface.health === "starting";
}

interface BrowserSurfaceCurrentnessScope {
  readonly connector_id: string;
  readonly expected_subject: string | undefined;
  readonly profile_key: string;
}

function currentnessScopeFor(input: {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly profile_key: string;
}): BrowserSurfaceCurrentnessScope {
  return {
    connector_id: input.connector_id,
    expected_subject: input.connection_id === input.connector_id ? undefined : input.connection_id,
    profile_key: input.profile_key,
  };
}

function isSurfaceInScope(surface: BrowserSurfaceCurrentnessRow, scope: BrowserSurfaceCurrentnessScope): boolean {
  return (
    surface.connector_id === scope.connector_id &&
    surface.profile_key === scope.profile_key &&
    surface.surface_subject_id === scope.expected_subject
  );
}

function isCurrentScopedSurface(surface: BrowserSurfaceCurrentnessRow, scope: BrowserSurfaceCurrentnessScope): boolean {
  return isSurfaceInScope(surface, scope) && isLiveCurrentProcess(surface);
}

function currentPersistedRemoteSurfaceId(input: {
  readonly persisted_surfaces: readonly BrowserSurfaceCurrentnessRow[];
  readonly remote_surface_id: string | null;
  readonly scope: BrowserSurfaceCurrentnessScope;
}): string | null {
  const remoteSurfaceId = input.remote_surface_id;
  if (!remoteSurfaceId) {
    return null;
  }
  return input.persisted_surfaces.some(
    (surface) => surface.surface_id === remoteSurfaceId && isCurrentScopedSurface(surface, input.scope)
  )
    ? remoteSurfaceId
    : null;
}

/**
 * Current IDs come only from this refresh's live inventory or an independently
 * current remote ID with a live, exactly scoped persisted counterpart. A
 * retained stopping row is history, not an active process.
 */
export function currentSurfaceIdsForReplacementReceipt(input: {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly inventory_surfaces: readonly BrowserSurfaceCurrentnessRow[];
  readonly profile_key: string;
  readonly remote_surface_id: string | null;
  readonly persisted_surfaces: readonly BrowserSurfaceCurrentnessRow[];
}): ReadonlySet<string> {
  const scope = currentnessScopeFor(input);
  const current = new Set<string>();
  const remoteSurfaceId = currentPersistedRemoteSurfaceId({
    persisted_surfaces: input.persisted_surfaces,
    remote_surface_id: input.remote_surface_id,
    scope,
  });
  if (remoteSurfaceId) {
    current.add(remoteSurfaceId);
  }
  for (const surface of input.inventory_surfaces) {
    if (isCurrentScopedSurface(surface, scope)) {
      current.add(surface.surface_id);
    }
  }
  return current;
}

/**
 * A started receipt is a live continuity boundary only while execution needs a
 * process or an independently current process is observable. Dynamic
 * scale-to-zero alone must not revive a dormant stopped-replacement row.
 */
export function shouldJoinCurrentReplacementReceipt(input: {
  readonly current_surface_ids: ReadonlySet<string>;
  readonly demand: "active" | "none";
  readonly surface_mode: "dynamic-managed" | "static-managed";
}): boolean {
  return input.surface_mode !== "dynamic-managed" || input.demand === "active" || input.current_surface_ids.size > 0;
}

export function selectCurrentBrowserGenerationHash(input: {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly current_surface_ids: ReadonlySet<string>;
  readonly profile_key: string;
  readonly surfaces: readonly PersistedBrowserSurfaceGeneration[];
}): string | null {
  if (input.current_surface_ids.size === 0) {
    return null;
  }
  const expectedSubject = input.connection_id === input.connector_id ? undefined : input.connection_id;
  const hashes = new Set(
    input.surfaces
      .filter(
        (surface) =>
          input.current_surface_ids.has(surface.surface_id) &&
          surface.connector_id === input.connector_id &&
          surface.profile_key === input.profile_key &&
          surface.surface_subject_id === expectedSubject
      )
      .map((surface) => surface.browser_generation_hash)
      .filter((hash): hash is string => typeof hash === "string" && hash.length > 0)
  );
  return hashes.size === 1 ? (hashes.values().next().value ?? null) : null;
}
