// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployment-owned root for DURABLE connector artifacts — bulk on-disk
 * state a connector accumulates across runs and that MUST survive container
 * replacement (not just restart).
 *
 * WHY this exists: connectors used to compute their own storage paths from
 * `homedir()` (e.g. Slack's `~/.pdpp/slackdump/<workspace>`). The documented
 * deployment (deploy/docker/README.md) mounts exactly ONE volume —
 * `-v pdpp_data:/var/lib/pdpp` — so anything under `$HOME` lived on the
 * container's writable layer and was destroyed on every `docker rm` +
 * `docker run`. A Slack workspace archive would re-download from zero on each
 * container replacement; nine consecutive real runs died on `slackdump_timeout`
 * after re-accumulating ~138-198MB apiece. The artifact was durable in intent
 * and ephemeral in fact.
 *
 * The fix is one deployment-owned root INSIDE the already-persistent volume,
 * not a second volume. Resolution order:
 *
 *   1. `PDPP_CONNECTOR_ARTIFACT_ROOT` — explicit operator override. Always
 *      wins. This is the knob a non-Docker deployment (systemd, Fly, k8s)
 *      points at its own durable mount.
 *
 *   2. The directory holding `PDPP_DB_PATH`, plus `/connector-artifacts`.
 *      This is the load-bearing default: the deployment already had to put
 *      the SQLite database on durable storage for PDPP to work at all, so
 *      that directory is the one path every deployment has PROVEN durable.
 *      Core bakes `PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite`, which lands
 *      artifacts at `/var/lib/pdpp/connector-artifacts/` — inside the
 *      documented volume, no second mount required. A Postgres deployment
 *      that also sets `PDPP_DB_PATH` inherits the same durable directory;
 *      one that does not must set the override (see the fallback below).
 *
 *   3. Local-development fallback: `~/.pdpp/connector-artifacts`. Reached
 *      only when neither env var is set, which is the developer-on-a-laptop
 *      case where `$HOME` genuinely is durable storage. This fallback is
 *      EXPLICIT, never silent: `resolveConnectorArtifactRoot` reports the
 *      `source` it picked, and `describeConnectorArtifactRoot` renders the
 *      one-line disclosure that callers surface through their progress
 *      channel. A container reaching the fallback is a misconfiguration we
 *      want visible in the run log, not a silent data-loss bug.
 *
 * `:memory:` is treated as "no durable database path" rather than as a
 * directory — an in-memory database names no filesystem location, so falling
 * back is the honest answer. This mirrors the reference implementation's own
 * `importBaseDir` handling in reference-implementation/server/index.ts.
 *
 * SCOPE — durable, not scratch. Use this root for artifacts that are
 * expensive to rebuild and are meant to accumulate: Slack's slackdump
 * archive, downloaded statement PDFs, manual-upload imports. Do NOT use it
 * for per-run scratch that is cheap to recreate (temp download staging,
 * debug captures); those belong in `tmpdir()` and their loss costs nothing.
 *
 * NAMING — "artifact root", deliberately not "connector state". This
 * codebase already uses `connector-state` for the grant-scoped cursor store
 * behind `rs.connector-state.get`/`.put`, which is database-backed rows, not
 * bulk files. Two different things should not share a name.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Directory name appended to the resolved durable base. */
const ARTIFACT_DIR_NAME = "connector-artifacts";

/** Sentinel `PDPP_DB_PATH` value that names no filesystem location. */
const IN_MEMORY_DB_PATH = ":memory:";

export interface ConnectorArtifactRootEnv {
  PDPP_CONNECTOR_ARTIFACT_ROOT?: string;
  PDPP_DB_PATH?: string;
}

/**
 * Which of the three resolution rules produced the root.
 *
 * `local-development-fallback` is the only one that is NOT deployment-owned;
 * callers disclose it rather than let it pass unnoticed.
 */
export type ConnectorArtifactRootSource = "explicit-override" | "database-directory" | "local-development-fallback";

export interface ConnectorArtifactRoot {
  /** Absolute path to the durable root. */
  root: string;
  source: ConnectorArtifactRootSource;
  /** True when the root is deployment-owned (rules 1 and 2). */
  deploymentOwned: boolean;
}

function trimmed(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Resolve the durable artifact root. Pure: reads env only, touches no
 * filesystem, creates nothing. Callers `mkdir` their own subdirectory —
 * resolution must stay side-effect free so tests and diagnostics can ask
 * "where would this go?" without provisioning it.
 */
export function resolveConnectorArtifactRoot(
  env: NodeJS.ProcessEnv | ConnectorArtifactRootEnv = process.env
): ConnectorArtifactRoot {
  const override = trimmed(env.PDPP_CONNECTOR_ARTIFACT_ROOT);
  if (override) {
    return { root: override, source: "explicit-override", deploymentOwned: true };
  }

  const dbPath = trimmed(env.PDPP_DB_PATH);
  if (dbPath && dbPath !== IN_MEMORY_DB_PATH) {
    return {
      root: join(dirname(dbPath), ARTIFACT_DIR_NAME),
      source: "database-directory",
      deploymentOwned: true,
    };
  }

  return {
    root: join(homedir(), ".pdpp", ARTIFACT_DIR_NAME),
    source: "local-development-fallback",
    deploymentOwned: false,
  };
}

/**
 * Resolve the durable directory for one connector's artifacts, namespaced by
 * connector so two connectors never collide inside the shared root.
 *
 * `segments` are appended verbatim (e.g. a Slack workspace subdomain). They
 * come from connector-controlled values, not raw remote input; callers that
 * pass anything user-supplied sanitize it first.
 */
export function resolveConnectorArtifactDir(
  connectorName: string,
  segments: readonly string[] = [],
  env: NodeJS.ProcessEnv | ConnectorArtifactRootEnv = process.env
): ConnectorArtifactRoot {
  const resolved = resolveConnectorArtifactRoot(env);
  return { ...resolved, root: join(resolved.root, connectorName, ...segments) };
}

/**
 * One-line disclosure of where durable artifacts landed and why. Connectors
 * emit this through their progress channel so the local-development fallback
 * is stated in the run log instead of being inferred from a missing archive
 * three container replacements later.
 */
export function describeConnectorArtifactRoot(resolved: ConnectorArtifactRoot): string {
  switch (resolved.source) {
    case "explicit-override":
      return `Durable artifact root ${resolved.root} (PDPP_CONNECTOR_ARTIFACT_ROOT).`;
    case "database-directory":
      return `Durable artifact root ${resolved.root} (alongside PDPP_DB_PATH, on the deployment's persistent volume).`;
    default:
      return (
        `Durable artifact root ${resolved.root} (LOCAL-DEVELOPMENT FALLBACK — no ` +
        `PDPP_CONNECTOR_ARTIFACT_ROOT and no PDPP_DB_PATH). This path is NOT on a ` +
        `deployment-managed volume; artifacts here are lost when the container is replaced.`
      );
  }
}
