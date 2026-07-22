// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-journey acceptance harness orchestrator.
//
// Binds the pure scanner core (scan.mjs) to the declarative surface manifest
// (surface-manifest.mjs) and the filesystem. Both the CLI entry
// (`scripts/check-owner-journey-acceptance.mjs`) and the node:test suite import
// `runLocalAcceptance` from here.
//
// The orchestrator owns file reads and the published-command-surface derivation;
// it returns a structured result object. It performs no console output and no
// process.exit — callers decide how to present and gate.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkCommandFreshness,
  checkDashboardRouteShellContract,
  checkHelpLinkTargets,
  checkPostSubmitDurability,
  checkSharedShellNavContract,
  deriveSubcommandSurface,
  extractRenderedCommands,
  scanForbiddenStrings,
  scanRenderedHelperReachability,
} from "./scan.mjs";
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
} from "./surface-manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: scripts/owner-journey-acceptance/ -> ../../ */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

async function readRepoFile(repoRelativePath) {
  return readFile(path.join(REPO_ROOT, repoRelativePath), "utf8");
}

async function walkRepoFiles(repoRelativeDir) {
  const absoluteDir = path.join(REPO_ROOT, repoRelativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(repoRelativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkRepoFiles(rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

async function readRouteSources(repoRelativeRoot) {
  const files = await walkRepoFiles(repoRelativeRoot);
  const routeFiles = files.filter((file) => /\/(?:page|loading)\.tsx$/.test(file)).sort();
  const sources = [];
  for (const file of routeFiles) {
    sources.push({ path: file, src: await readRepoFile(file) });
  }
  return sources;
}

async function readDashboardRouteSources() {
  return readRouteSources(DASHBOARD_ROUTE_ROOT);
}

async function discoverNormalOwnerRouteFiles(explicitFiles) {
  const explicit = new Set(explicitFiles);
  const discovered = [];
  for (const root of NORMAL_OWNER_ROUTE_SCAN_ROOTS) {
    for (const file of await walkRepoFiles(root)) {
      if (/\/(?:page|loading)\.tsx$/.test(file) && !explicit.has(file)) {
        discovered.push(file);
      }
    }
  }
  return [...new Set(discovered)].sort();
}

/**
 * Derive { packageName -> Set<subcommand> } from the manifest's declared
 * dispatch sources. Grounds command-freshness in real package source.
 *
 * @returns {Promise<Record<string, Set<string>>>}
 */
export async function derivePublishedCommandSurface() {
  const surfaceByPackage = {};
  for (const [pkgName, meta] of Object.entries(PUBLISHED_PACKAGES)) {
    const src = await readRepoFile(meta.commandDispatchFile);
    surfaceByPackage[pkgName] = deriveSubcommandSurface(src);
  }
  return surfaceByPackage;
}

/**
 * Run the full local-source acceptance scan.
 *
 * @param {object} [opts]
 * @param {ReadonlyArray<string>} [opts.normalFiles]
 * @param {ReadonlyArray<string>} [opts.advancedFiles]
 * @param {ReadonlyArray<string>} [opts.commandSourceFiles]
 * @returns {Promise<{
 *   findings: Array,
 *   renderedCommands: Array,
 *   publishedSurface: Record<string, string[]>,
 *   scannedFiles: { normal: string[], advanced: string[], commandSource: string[], discoveredNormalRoutes: string[] },
 *   ok: boolean,
 * }>}
 */
export async function runLocalAcceptance(opts = {}) {
  const normalFiles = opts.normalFiles ?? NORMAL_OWNER_UI_FILES;
  const advancedFiles = opts.advancedFiles ?? ADVANCED_OWNER_UI_FILES;
  const commandSourceFiles = opts.commandSourceFiles ?? COMMAND_SOURCE_FILES;
  const discoveredNormalRouteFiles = opts.normalFiles
    ? []
    : await discoverNormalOwnerRouteFiles([...normalFiles, ...advancedFiles]);
  const allNormalFiles = [...normalFiles, ...discoveredNormalRouteFiles];

  const surfaceByPackage = await derivePublishedCommandSurface();
  const findings = [];
  const renderedCommands = [];

  // Rendered-page tiers: forbidden-string scan + indirect-leak reachability +
  // any command literals embedded directly in the page.
  const scanRenderedTier = async (file, tier) => {
    const src = await readRepoFile(file);
    findings.push(...scanForbiddenStrings({ path: file, rules: FORBIDDEN_STRING_RULES, src, tier }));
    findings.push(...scanRenderedHelperReachability({ forbiddenHelpers: FORBIDDEN_RENDERED_HELPERS, path: file, src }));
    const cmds = extractRenderedCommands(src).map((c) => ({ ...c, path: file }));
    const fresh = checkCommandFreshness({ commands: cmds, publishedPackages: PUBLISHED_PACKAGES, surfaceByPackage });
    findings.push(...fresh.findings);
    renderedCommands.push(...fresh.rendered);
  };

  for (const file of allNormalFiles) {
    await scanRenderedTier(file, "normal");
  }
  for (const file of advancedFiles) {
    await scanRenderedTier(file, "advanced");
  }

  // Command-source libraries: not forbidden-string scanned (dead helpers are not
  // owner-facing leaks), but every command literal they build must be a fresh,
  // published subcommand. The reachability guard above is what stops a page from
  // wiring a developer-only helper into rendered output.
  for (const file of commandSourceFiles) {
    const src = await readRepoFile(file);
    const cmds = extractRenderedCommands(src).map((c) => ({ ...c, path: file }));
    const fresh = checkCommandFreshness({ commands: cmds, publishedPackages: PUBLISHED_PACKAGES, surfaceByPackage });
    findings.push(...fresh.findings);
    renderedCommands.push(...fresh.rendered);
  }

  // Help-link new-tab check (scoped to declared static-secret files).
  for (const file of HELP_LINK_RULE.files) {
    const src = await readRepoFile(file);
    findings.push(...checkHelpLinkTargets({ path: file, src }));
  }

  // Post-submit durability check (single declared file).
  {
    const src = await readRepoFile(POST_SUBMIT_RULE.file);
    findings.push(...checkPostSubmitDurability({ path: POST_SUBMIT_RULE.file, rule: POST_SUBMIT_RULE, src }));
  }

  // Shared shell / navigation contract. This pins the current route-map
  // architecture and prevents normal owner routes from silently drifting back
  // to the legacy dashboard shell or one-off chrome.
  {
    const src = await readRepoFile(SHARED_SHELL_FILE);
    findings.push(
      ...checkSharedShellNavContract({
        path: SHARED_SHELL_FILE,
        requiredItems: SHELL_NAV_REQUIRED_ITEMS,
        src,
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
    ok: findings.length === 0,
    publishedSurface,
    renderedCommands,
    scannedFiles: {
      advanced: [...advancedFiles],
      commandSource: [...commandSourceFiles],
      discoveredNormalRoutes: discoveredNormalRouteFiles,
      normal: allNormalFiles,
    },
  };
}
