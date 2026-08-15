// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ConnectorSchedule, SchedulerManifest, SchedulerReadinessResult } from "./scheduler-domain-types.ts";

// ─── Automatic-run readiness checks ────────────────────────────────────────

interface RuntimeRequirements {
  readonly bindings?: Record<string, { readonly required?: boolean } | undefined>;
  readonly external_tools?: readonly {
    readonly detect?: {
      readonly args?: readonly string[];
      readonly executable?: string;
      /**
       * Name of an env var that, when set, overrides `detect.executable` with
       * an operator-supplied binary path. Manifest-declared so this module
       * never hardcodes which tool's override var it is checking — the
       * connector names its own override var, the RI just reads it.
       */
      readonly executable_env_override?: string;
      readonly exit_code?: number;
    };
    readonly install_hint?: string;
    readonly name?: string;
  }[];
  /**
   * Declares the local filesystem paths a local-collector connector reads
   * from, so scheduler-readiness can preflight them WITHOUT hardcoding which
   * connector uses which path or env var — the connector declares its own
   * home directory and path layout, the RI just checks whatever it declared.
   * Mirrors the same override contract the connector's own code already
   * implements (e.g. packages/polyfill-connectors/connectors/codex/index.ts's
   * CODEX_HOME/CODEX_SESSIONS_DIR/CODEX_STATE_DB); this module reads that
   * contract generically instead of re-deriving it by connector name.
   */
  readonly local_paths?: {
    /** Env var overriding the connector's home directory (e.g. "CODEX_HOME"). */
    readonly home_env_override?: string;
    /** Home directory used when `home_env_override` is unset, relative to the OS user home (e.g. ".codex"). */
    readonly home_default_relative_to_user_home: string;
    readonly paths: readonly {
      /** Path relative to the resolved home directory (e.g. "sessions"). */
      readonly default_relative_to_home: string;
      /** Env var overriding this specific path (e.g. "CODEX_SESSIONS_DIR"). */
      readonly env_override?: string;
      /** Human-readable label used in the not-ready reason string. */
      readonly label: string;
      /** Only paths marked true are preflight-checked for scheduler readiness. */
      readonly required_for_readiness?: boolean;
    }[];
  };
}

function getRuntimeRequirements(manifest: SchedulerManifest): RuntimeRequirements {
  const requirements = manifest.runtime_requirements;
  if (requirements && typeof requirements === "object") {
    return requirements as RuntimeRequirements;
  }
  return {};
}

async function canAccessPath(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runExecutable(file: string, args: readonly string[], expectedExitCode: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "ignore" });
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === expectedExitCode);
    });
  });
}

function runDetectCommand(tool: NonNullable<RuntimeRequirements["external_tools"]>[number]): Promise<boolean> {
  const expectedExitCode = Number.isInteger(tool.detect?.exit_code) ? Number(tool.detect?.exit_code) : 0;
  const overrideVarName = tool.detect?.executable_env_override;
  const overridePath = overrideVarName ? process.env[overrideVarName]?.trim() : undefined;
  if (overridePath) {
    return runExecutable(overridePath, tool.detect?.args || [], expectedExitCode);
  }

  const executable = tool.detect?.executable;
  if (!executable) {
    return Promise.resolve(true);
  }
  return runExecutable(executable, tool.detect?.args || [], expectedExitCode);
}

function formatMissingToolReason(tool: NonNullable<RuntimeRequirements["external_tools"]>[number]): string {
  const name = tool.name || "required external tool";
  const hint = tool.install_hint ? ` ${tool.install_hint}` : "";
  return `required external tool ${name} is not available.${hint}`;
}

function requiredBindingEnabled(manifest: SchedulerManifest, binding: string): boolean {
  return getRuntimeRequirements(manifest).bindings?.[binding]?.required === true;
}

function browserSurfaceConfigured(): boolean {
  // Direct CDP URL — connector receives the URL in env and talks to it directly.
  if (process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL?.trim()) {
    return true;
  }
  // Managed neko surface (static mode): a single shared n.eko container whose
  // CDP port is exposed at PDPP_NEKO_CDP_HTTP_URL.  The controller owns leasing;
  // the connector does not discover the CDP endpoint itself.
  if (process.env.PDPP_NEKO_CDP_HTTP_URL?.trim()) {
    return true;
  }
  // Managed neko surface (dynamic mode): the allocator spawns per-connector
  // n.eko containers; PDPP_NEKO_MANAGED_CONNECTORS lists the connector IDs
  // eligible for those surfaces.
  if (process.env.PDPP_NEKO_MANAGED_CONNECTORS?.trim()) {
    return true;
  }
  // Managed in-image browser: the browser-capable Core image sets
  // PDPP_RUNTIME_BROWSER=1 and the supervisor (deploy/railway/core-supervisor.ts)
  // starts Xvfb and stamps DISPLAY into this server process's own env before
  // spawning it — not just into connector-child env, so process.env.DISPLAY is
  // directly observable here. This MUST stay identical to the
  // `managedDisplayAvailable` predicate in
  // packages/polyfill-connectors/src/browser-launch.ts (which the actual
  // browser launch gates on) — that module can't be imported here (it isn't in
  // @pdpp/polyfill-connectors's package exports, and the dependency direction
  // between the two packages runs the other way), so the two checks are kept
  // in sync by hand. Changing one without the other reintroduces the exact
  // disagreement this comment exists to prevent.
  if (process.env.PDPP_RUNTIME_BROWSER === "1" && process.env.DISPLAY?.trim()) {
    return true;
  }
  // Explicit opt-in for unmanaged/bring-your-own browser setups.
  if (process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES === "1") {
    return true;
  }
  return false;
}

/**
 * Resolves the connector-declared local home directory and the subset of its
 * declared paths marked `required_for_readiness`, applying each level's env
 * override generically. No connector name is read here — only whatever
 * `runtime_requirements.local_paths` this manifest declared.
 */
function resolveRequiredLocalPaths(
  localPaths: NonNullable<RuntimeRequirements["local_paths"]>
): readonly { readonly label: string; readonly path: string }[] {
  const home =
    (localPaths.home_env_override && process.env[localPaths.home_env_override]?.trim()) ||
    join(homedir(), localPaths.home_default_relative_to_user_home);
  return localPaths.paths
    .filter((entry) => entry.required_for_readiness)
    .map((entry) => ({
      label: entry.label,
      path:
        (entry.env_override && process.env[entry.env_override]?.trim()) || join(home, entry.default_relative_to_home),
    }));
}

async function checkFirstPartyLocalSourceReadiness(manifest: SchedulerManifest): Promise<string | null> {
  if (!requiredBindingEnabled(manifest, "filesystem")) {
    return null;
  }
  const localPaths = getRuntimeRequirements(manifest).local_paths;
  if (!localPaths) {
    return null;
  }
  const missing: string[] = [];
  for (const { label, path } of resolveRequiredLocalPaths(localPaths)) {
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    if (!(await canAccessPath(path))) {
      missing.push(`${label}=${path}`);
    }
  }
  if (missing.length === 0) {
    return null;
  }
  return `required local source path(s) are missing or unreadable: ${missing.join(", ")}`;
}

export async function defaultReadinessChecker(schedule: ConnectorSchedule): Promise<SchedulerReadinessResult> {
  const requirements = getRuntimeRequirements(schedule.manifest);
  for (const tool of requirements.external_tools || []) {
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    if (!(await runDetectCommand(tool))) {
      return { ready: false, reason: formatMissingToolReason(tool) };
    }
  }

  if (requiredBindingEnabled(schedule.manifest, "browser") && !browserSurfaceConfigured()) {
    return {
      ready: false,
      reason: "required browser runtime is not configured for unattended scheduled runs",
    };
  }

  const localSourceReason = await checkFirstPartyLocalSourceReadiness(schedule.manifest);
  if (localSourceReason) {
    return { ready: false, reason: localSourceReason };
  }

  return { ready: true };
}
