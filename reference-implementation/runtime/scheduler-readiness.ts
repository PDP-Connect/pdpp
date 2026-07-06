import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalConnectorKey } from "../server/connector-key.js";
import type { ConnectorSchedule, SchedulerManifest, SchedulerReadinessResult } from "./scheduler-domain-types.ts";

// ─── Automatic-run readiness checks ────────────────────────────────────────

interface RuntimeRequirements {
  readonly bindings?: Record<string, { readonly required?: boolean } | undefined>;
  readonly external_tools?: readonly {
    readonly detect?: { readonly args?: readonly string[]; readonly executable?: string; readonly exit_code?: number };
    readonly install_hint?: string;
    readonly name?: string;
  }[];
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
  const slackdumpBin = process.env.SLACKDUMP_BIN?.trim();
  if (tool.name === "slackdump" && slackdumpBin) {
    return runExecutable(slackdumpBin, ["version"], expectedExitCode);
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
  // Explicit opt-in for unmanaged/bring-your-own browser setups.
  if (process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES === "1") {
    return true;
  }
  return false;
}

function resolveCodexLocalSourcePaths(): readonly [string, string] {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return [
    process.env.CODEX_SESSIONS_DIR || join(codexHome, "sessions"),
    process.env.CODEX_STATE_DB || join(codexHome, "state_5.sqlite"),
  ];
}

async function checkCodexLocalSourcePathReadiness(): Promise<string | null> {
  const [sessionsDir, stateDbPath] = resolveCodexLocalSourcePaths();
  const missing: string[] = [];
  if (!(await canAccessPath(sessionsDir))) {
    missing.push(sessionsDir);
  }
  if (!(await canAccessPath(stateDbPath))) {
    missing.push(stateDbPath);
  }
  if (missing.length === 0) {
    return null;
  }
  return `Codex local source path(s) are missing or unreadable: ${missing.join(", ")}`;
}

async function checkFirstPartyLocalSourceReadiness(
  connectorId: string,
  manifest: SchedulerManifest
): Promise<string | null> {
  if (!requiredBindingEnabled(manifest, "filesystem")) {
    return null;
  }
  const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
  if (canonicalId === "codex") {
    return checkCodexLocalSourcePathReadiness();
  }
  if (canonicalId === "claude-code") {
    const claudeHome = process.env.CLAUDE_CODE_HOME || join(homedir(), ".claude");
    const projectsDir = process.env.CLAUDE_CODE_PROJECTS_DIR || join(claudeHome, "projects");
    return (await canAccessPath(projectsDir))
      ? null
      : `Claude Code local source path is missing or unreadable: ${projectsDir}`;
  }
  return null;
}

export async function defaultReadinessChecker(schedule: ConnectorSchedule): Promise<SchedulerReadinessResult> {
  const requirements = getRuntimeRequirements(schedule.manifest);
  for (const tool of requirements.external_tools || []) {
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

  const localSourceReason = await checkFirstPartyLocalSourceReadiness(schedule.connectorId, schedule.manifest);
  if (localSourceReason) {
    return { ready: false, reason: localSourceReason };
  }

  return { ready: true };
}
