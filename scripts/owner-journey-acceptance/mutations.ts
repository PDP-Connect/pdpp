// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded mutation probes for owner-journey acceptance.
 *
 * The live owner probe is deliberately read-only. This authority is an
 * in-memory, disposable owner-data substitute for exercising mutation
 * semantics without touching a real owner's source, credential, or schedule.
 * A network authority is accepted only when it is explicitly local and marked
 * disposable; callers must opt into it separately from the live read probe.
 */

export interface MutationResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface DisposableMutationAuthority {
  readonly kind: "disposable-local";
  readonly live: false;
  request: (input: { body?: unknown; method: "DELETE" | "GET" | "POST"; path: string }) => Promise<MutationResponse>;
  reset: () => Promise<void>;
}

export interface MutationProbeResult {
  readonly detail: string;
  readonly probes: readonly string[];
  readonly status: "fail" | "pass";
}

interface DisposableState {
  refreshes: number;
  sources: Set<string>;
}

const REFRESH_PATH_RE = /^\/__uat__\/sources\/([^/]+)\/refresh$/;
const DELETE_PATH_RE = /^\/__uat__\/sources\/([^/]+)$/;

function sourceIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const sourceId = (body as Record<string, unknown>).source_id;
  return typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
}

function handleDisposableMutation(
  state: DisposableState,
  { body, method, path }: { body?: unknown; method: "DELETE" | "GET" | "POST"; path: string }
): MutationResponse {
  if (method === "GET" && path === "/__uat__/sources") {
    return { body: { count: state.sources.size, source_ids: [...state.sources].sort() }, status: 200 };
  }
  if (method === "POST" && path === "/__uat__/sources") {
    const sourceId = sourceIdFromBody(body);
    if (!sourceId) {
      return { body: { error: "source_id_required" }, status: 400 };
    }
    state.sources.add(sourceId);
    return { body: { source_id: sourceId, created: true }, status: 201 };
  }

  const refreshMatch = path.match(REFRESH_PATH_RE);
  if (method === "POST" && refreshMatch?.[1]) {
    if (!state.sources.has(refreshMatch[1])) {
      return { body: { error: "source_not_found" }, status: 404 };
    }
    state.refreshes += 1;
    return { body: { refreshed: true, refreshes: state.refreshes }, status: 200 };
  }

  const deleteMatch = path.match(DELETE_PATH_RE);
  if (method === "DELETE" && deleteMatch?.[1]) {
    const deleted = state.sources.delete(deleteMatch[1]);
    return { body: { deleted }, status: deleted ? 200 : 404 };
  }

  return { body: { error: "unsupported_mutation" }, status: 404 };
}

/** Create a local authority whose state is resettable and never represents live owner data. */
export function createDisposableMutationAuthority(): DisposableMutationAuthority {
  const state: DisposableState = { refreshes: 0, sources: new Set() };
  return {
    kind: "disposable-local",
    live: false,
    request: (input) => Promise.resolve(handleDisposableMutation(state, input)),
    reset: () => {
      state.refreshes = 0;
      state.sources.clear();
      return Promise.resolve();
    },
  };
}

/** Run only the small create → refresh → delete path against a disposable authority. */
export async function runBoundedMutationProbes(authority: DisposableMutationAuthority): Promise<MutationProbeResult> {
  const probes: string[] = [];
  await authority.reset();
  const resetBefore = await authority.request({ method: "GET", path: "/__uat__/sources" });
  probes.push("reset starts empty");
  if (resetBefore.status !== 200 || !isSourceList(resetBefore.body, [])) {
    return { detail: "reset did not produce an empty source list", probes, status: "fail" };
  }
  const created = await authority.request({
    body: { source_id: "uat-disposable-source" },
    method: "POST",
    path: "/__uat__/sources",
  });
  probes.push("create disposable source");
  if (created.status !== 201) {
    return { detail: `create returned ${created.status}`, probes, status: "fail" };
  }
  const afterCreate = await authority.request({ method: "GET", path: "/__uat__/sources" });
  probes.push("read durable source state after create");
  if (afterCreate.status !== 200 || !isSourceList(afterCreate.body, ["uat-disposable-source"])) {
    return { detail: "create response did not change durable source state", probes, status: "fail" };
  }
  const refreshed = await authority.request({
    method: "POST",
    path: "/__uat__/sources/uat-disposable-source/refresh",
  });
  probes.push("refresh disposable source");
  if (refreshed.status !== 200) {
    return { detail: `refresh returned ${refreshed.status}`, probes, status: "fail" };
  }
  if (!hasRefreshCount(refreshed.body, 1)) {
    return { detail: "refresh response did not reflect the durable refresh count", probes, status: "fail" };
  }
  const deleted = await authority.request({
    method: "DELETE",
    path: "/__uat__/sources/uat-disposable-source",
  });
  probes.push("delete disposable source");
  if (deleted.status !== 200) {
    return { detail: `delete returned ${deleted.status}`, probes, status: "fail" };
  }
  const refreshAfterDelete = await authority.request({
    method: "POST",
    path: "/__uat__/sources/uat-disposable-source/refresh",
  });
  probes.push("negative refresh after delete");
  if (refreshAfterDelete.status !== 404) {
    return { detail: `deleted source remained refreshable with ${refreshAfterDelete.status}`, probes, status: "fail" };
  }
  const afterDelete = await authority.request({ method: "GET", path: "/__uat__/sources" });
  probes.push("read durable source state after delete");
  if (afterDelete.status !== 200 || !isSourceList(afterDelete.body, [])) {
    return { detail: "delete response did not remove the durable source", probes, status: "fail" };
  }
  await authority.reset();
  const resetAfter = await authority.request({ method: "GET", path: "/__uat__/sources" });
  probes.push("reset restores empty state");
  if (resetAfter.status !== 200 || !isSourceList(resetAfter.body, [])) {
    return { detail: "reset did not restore empty durable state", probes, status: "fail" };
  }
  return {
    detail: "bounded mutation path passed with state-dependent body, negative, and reset proofs",
    probes,
    status: "pass",
  };
}

function isSourceList(body: unknown, expected: readonly string[]): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const sourceIds = (body as Record<string, unknown>).source_ids;
  return (
    Array.isArray(sourceIds) &&
    sourceIds.every((value): value is string => typeof value === "string") &&
    sourceIds.length === expected.length &&
    sourceIds.every((value, index) => value === expected[index]) &&
    (body as Record<string, unknown>).count === expected.length
  );
}

function hasRefreshCount(body: unknown, expected: number): boolean {
  return Boolean(body && typeof body === "object" && (body as Record<string, unknown>).refreshes === expected);
}

/**
 * Resolve an optional network mutation authority without ever accepting a live
 * owner origin. The live read-only harness does not call this function.
 */
export function resolveDisposableMutationAuthority(env: NodeJS.ProcessEnv = process.env): {
  readonly kind: "not-configured" | "rejected" | "configured";
  readonly reason: string;
} {
  const origin = env.PDPP_UAT_MUTATION_ORIGIN?.trim();
  if (!origin) {
    return { kind: "not-configured", reason: "no disposable mutation origin configured" };
  }
  if (env.PDPP_UAT_MUTATION_DISPOSABLE !== "1") {
    return { kind: "rejected", reason: "mutation origin is not explicitly marked disposable" };
  }
  try {
    const url = new URL(origin);
    const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (!localHost) {
      return { kind: "rejected", reason: "mutation authority must be localhost or loopback" };
    }
  } catch {
    return { kind: "rejected", reason: "mutation authority is not a valid URL" };
  }
  return { kind: "configured", reason: "explicit disposable local mutation authority" };
}
