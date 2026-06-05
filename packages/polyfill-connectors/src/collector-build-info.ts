/**
 * Build identity for the local collector runtime.
 *
 * This is the single source of the build-derived agent version the collector
 * reports on its heartbeats (`device_exporters.agent_version`). It exists so an
 * owner can tell *which build* a host is running — and therefore whether the
 * host is on stale collector code — without inspecting `dist/` mtimes on the
 * machine, the manual ritual the `ri-local-collector-permanent-green-current-v1`
 * audit had to perform.
 *
 * Provenance is honest by construction:
 *
 * - The committed value below is the **source** identity. Dev runs, `tsx`, and
 *   unit tests import this module directly and deterministically read
 *   `revision: "source"`, with no working-tree mutation and no build step. A
 *   `source` revision truthfully says "this is an unbuilt in-repo run, not a
 *   published build" — the same honesty the `deployment_posture` surface encodes
 *   with `repo_dist_override` / `is_placeholder_version`.
 * - The `@pdpp/local-collector` build (`scripts/postbuild.mjs`) overwrites the
 *   built (compiled) copy of this module in `dist/` with the real package
 *   version, a short git revision, and a build timestamp. A built artifact
 *   therefore reports its true revision; a git-less CI build falls back to the
 *   `source` sentinel rather than fabricating one.
 *
 * Redaction: this module carries only a semantic version string, a short
 * revision token (a public git short-SHA or the literal `source`), and an
 * optional ISO-8601 build timestamp. It MUST NOT carry a filesystem path, home
 * directory, hostname, branch name, token, cookie, or any source content. A
 * short commit SHA is public information for an open-source repository.
 *
 * Spec: openspec/changes/surface-local-collector-build-version.
 */

/** The literal revision reported by an unbuilt in-repo / `tsx` source run. */
export const COLLECTOR_BUILD_SOURCE_SENTINEL = "source";

export interface CollectorBuildInfo {
  /** ISO-8601 build timestamp, or null for an unbuilt source run. */
  builtAt: string | null;
  /** Short git revision for a built artifact, or the `source` sentinel. */
  revision: string;
  /** Resolved collector package version (the `0.0.0` placeholder by default). */
  version: string;
}

/**
 * Committed source-build identity. Overwritten in `dist/` at build time by
 * `packages/local-collector/scripts/postbuild.mjs`. Do not read `process`,
 * `git`, or the filesystem here — the value must be a static literal so a `tsx`
 * import is deterministic and the build override is a plain module rewrite.
 */
export const COLLECTOR_BUILD_INFO: CollectorBuildInfo = {
  builtAt: null,
  revision: COLLECTOR_BUILD_SOURCE_SENTINEL,
  version: "0.0.0",
};

/**
 * Compose the build-derived agent version reported on heartbeats:
 * `<package-version>+<revision>` (e.g. `0.0.0+43f63825f03a` for a built
 * artifact, `0.0.0+source` for an unbuilt source run).
 *
 * The `+` separator keeps the version SemVer-build-metadata shaped and is the
 * single delimiter an owner splits on to recover the revision.
 */
export function buildAgentVersion(info: CollectorBuildInfo = COLLECTOR_BUILD_INFO): string {
  return `${info.version}+${info.revision}`;
}
