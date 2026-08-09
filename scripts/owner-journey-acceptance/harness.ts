// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-journey acceptance harness orchestrator.
//
// Binds the pure scanner core (scan.ts) to the declarative surface manifest
// (surface-manifest.ts) and the filesystem. Both the CLI entry
// (`scripts/check-owner-journey-acceptance.ts`) and the node:test suite import
// `runLocalAcceptance` from here.
//
// The orchestrator owns file reads and the published-command-surface derivation;
// it returns a structured result object. It performs no console output and no
// process.exit — callers decide how to present and gate.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CommandFreshnessRenderedCommand,
  checkCommandFreshness,
  checkDashboardRouteShellContract,
  checkHelpLinkTargets,
  checkPostSubmitDurability,
  checkSharedShellNavContract,
  type DashboardRouteFile,
  deriveSubcommandSurface,
  extractRenderedCommands,
  type Finding,
  scanForbiddenStrings,
  scanRenderedHelperReachability,
} from "./scan.ts";
import {
  ADVANCED_OWNER_UI_FILES,
  COMMAND_SOURCE_FILES,
  DASHBOARD_ROUTE_ROOT,
  FORBIDDEN_RENDERED_HELPERS,
  FORBIDDEN_STRING_RULES,
  FULL_SCREEN_DASHBOARD_ROUTE_EXCEPTIONS,
  HELP_LINK_RULE,
  NORMAL_OWNER_ROUTE_SCAN_ROOTS,
  NORMAL_OWNER_UI_FILES,
  POST_SUBMIT_RULE,
  PUBLISHED_PACKAGES,
  SHARED_SHELL_FILE,
  SHELL_NAV_REQUIRED_ITEMS,
} from "./surface-manifest.ts";

const PAGE_LOADING_TSX_PATTERN = /\/(?:page|loading)\.tsx$/;

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: scripts/owner-journey-acceptance/ -> ../../ */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

async function readRepoFile(repoRelativePath: string): Promise<string> {
  try {
    return await readFile(path.join(REPO_ROOT, repoRelativePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `owner-journey-acceptance surface manifest declares "${repoRelativePath}", but that file no longer exists. ` +
          "Update NORMAL_OWNER_UI_FILES/ADVANCED_OWNER_UI_FILES/COMMAND_SOURCE_FILES in surface-manifest.ts to point " +
          "at the file's actual successor (do not assume by filename — trace the real import graph).",
        { cause: error }
      );
    }
    throw error;
  }
}

async function walkRepoFiles(repoRelativeDir: string): Promise<string[]> {
  const absoluteDir = path.join(REPO_ROOT, repoRelativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = path.join(repoRelativeDir, entry.name);
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: recursive directory walk — sequential recursion keeps this a plain depth-first walk rather than an unbounded-fanout Promise.all over an unknown tree depth.
      files.push(...(await walkRepoFiles(rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

async function readRouteSources(repoRelativeRoot: string): Promise<DashboardRouteFile[]> {
  const files = await walkRepoFiles(repoRelativeRoot);
  const routeFiles = files.filter((file) => PAGE_LOADING_TSX_PATTERN.test(file)).sort(compareStrings);
  const sources: DashboardRouteFile[] = [];
  for (const file of routeFiles) {
    // biome-ignore lint/performance/noAwaitInLoops: file reads are ordered so the returned sources array stays in the same deterministic order as routeFiles.
    sources.push({ path: file, src: await readRepoFile(file) });
  }
  return sources;
}

function readDashboardRouteSources(): Promise<DashboardRouteFile[]> {
  return readRouteSources(DASHBOARD_ROUTE_ROOT);
}

async function discoverNormalOwnerRouteFiles(explicitFiles: readonly string[]): Promise<string[]> {
  const explicit = new Set(explicitFiles);
  const discovered: string[] = [];
  for (const root of NORMAL_OWNER_ROUTE_SCAN_ROOTS) {
    const rootFiles =
      // biome-ignore lint/performance/noAwaitInLoops: each scan root's directory walk is independent, but sequential iteration keeps route discovery deterministic and attributable per root.
      await walkRepoFiles(root);
    for (const file of rootFiles) {
      if (PAGE_LOADING_TSX_PATTERN.test(file) && !explicit.has(file)) {
        discovered.push(file);
      }
    }
  }
  return [...new Set(discovered)].sort();
}

/**
 * Derive { packageName -> Set<subcommand> } from the manifest's declared
 * dispatch sources. Grounds command-freshness in real package source.
 */
export async function derivePublishedCommandSurface(): Promise<Record<string, Set<string>>> {
  const surfaceByPackage: Record<string, Set<string>> = {};
  for (const [pkgName, meta] of Object.entries(PUBLISHED_PACKAGES)) {
    // biome-ignore lint/performance/noAwaitInLoops: a small, fixed package list — sequential reads keep a failure attributable to one package's dispatch file.
    const src = await readRepoFile(meta.commandDispatchFile);
    surfaceByPackage[pkgName] = deriveSubcommandSurface(src);
  }
  return surfaceByPackage;
}

export interface RunLocalAcceptanceOptions {
  advancedFiles?: readonly string[];
  commandSourceFiles?: readonly string[];
  normalFiles?: readonly string[];
}

export interface RunLocalAcceptanceResult {
  findings: Finding[];
  ok: boolean;
  publishedSurface: Record<string, string[]>;
  renderedCommands: CommandFreshnessRenderedCommand[];
  scannedFiles: {
    advanced: string[];
    commandSource: string[];
    discoveredNormalRoutes: string[];
    normal: string[];
  };
}

/**
 * Run the full local-source acceptance scan.
 */
export async function runLocalAcceptance(opts: RunLocalAcceptanceOptions = {}): Promise<RunLocalAcceptanceResult> {
  const normalFiles = opts.normalFiles ?? NORMAL_OWNER_UI_FILES;
  const advancedFiles = opts.advancedFiles ?? ADVANCED_OWNER_UI_FILES;
  const commandSourceFiles = opts.commandSourceFiles ?? COMMAND_SOURCE_FILES;
  const discoveredNormalRouteFiles = opts.normalFiles
    ? []
    : await discoverNormalOwnerRouteFiles([...normalFiles, ...advancedFiles]);
  const allNormalFiles = [...normalFiles, ...discoveredNormalRouteFiles];

  const surfaceByPackage = await derivePublishedCommandSurface();
  const findings: Finding[] = [];
  const renderedCommands: CommandFreshnessRenderedCommand[] = [];

  // Rendered-page tiers: forbidden-string scan + indirect-leak reachability +
  // any command literals embedded directly in the page.
  const scanRenderedTier = async (file: string, tier: string) => {
    const src = await readRepoFile(file);
    findings.push(...scanForbiddenStrings({ path: file, src, tier, rules: FORBIDDEN_STRING_RULES }));
    findings.push(...scanRenderedHelperReachability({ path: file, src, forbiddenHelpers: FORBIDDEN_RENDERED_HELPERS }));
    const cmds = extractRenderedCommands(src).map((c) => ({ ...c, path: file }));
    const fresh = checkCommandFreshness({ commands: cmds, surfaceByPackage, publishedPackages: PUBLISHED_PACKAGES });
    findings.push(...fresh.findings);
    renderedCommands.push(...fresh.rendered);
  };

  for (const file of allNormalFiles) {
    // biome-ignore lint/performance/noAwaitInLoops: findings accumulate in file order so the report reads deterministically; this is a file-scan tool, not a hot path.
    await scanRenderedTier(file, "normal");
  }
  for (const file of advancedFiles) {
    // biome-ignore lint/performance/noAwaitInLoops: same deterministic-ordering rationale as the normal-tier loop above.
    await scanRenderedTier(file, "advanced");
  }

  // Command-source libraries: not forbidden-string scanned (dead helpers are not
  // owner-facing leaks), but every command literal they build must be a fresh,
  // published subcommand. The reachability guard above is what stops a page from
  // wiring a developer-only helper into rendered output.
  for (const file of commandSourceFiles) {
    // biome-ignore lint/performance/noAwaitInLoops: findings accumulate in file order for a deterministic report.
    const src = await readRepoFile(file);
    const cmds = extractRenderedCommands(src).map((c) => ({ ...c, path: file }));
    const fresh = checkCommandFreshness({ commands: cmds, surfaceByPackage, publishedPackages: PUBLISHED_PACKAGES });
    findings.push(...fresh.findings);
    renderedCommands.push(...fresh.rendered);
  }

  // Help-link new-tab check (scoped to declared static-secret files).
  for (const file of HELP_LINK_RULE.files) {
    // biome-ignore lint/performance/noAwaitInLoops: findings accumulate in file order for a deterministic report.
    const src = await readRepoFile(file);
    findings.push(...checkHelpLinkTargets({ path: file, src }));
  }

  // Post-submit durability check (single declared file).
  {
    const src = await readRepoFile(POST_SUBMIT_RULE.file);
    findings.push(...checkPostSubmitDurability({ path: POST_SUBMIT_RULE.file, src, rule: POST_SUBMIT_RULE }));
  }

  // Shared shell / navigation contract. This pins the current route-map
  // architecture and prevents normal owner routes from silently drifting back
  // to the legacy dashboard shell or one-off chrome.
  {
    const src = await readRepoFile(SHARED_SHELL_FILE);
    findings.push(
      ...checkSharedShellNavContract({
        path: SHARED_SHELL_FILE,
        src,
        requiredItems: SHELL_NAV_REQUIRED_ITEMS,
      })
    );
    findings.push(
      ...checkDashboardRouteShellContract({
        files: await readDashboardRouteSources(),
        fullScreenExceptions: FULL_SCREEN_DASHBOARD_ROUTE_EXCEPTIONS,
      })
    );
  }

  const publishedSurface = Object.fromEntries(Object.entries(surfaceByPackage).map(([k, v]) => [k, [...v].sort()]));

  return {
    findings,
    renderedCommands,
    publishedSurface,
    scannedFiles: {
      normal: allNormalFiles,
      advanced: [...advancedFiles],
      commandSource: [...commandSourceFiles],
      discoveredNormalRoutes: discoveredNormalRouteFiles,
    },
    ok: findings.length === 0,
  };
}
