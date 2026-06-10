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

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkCommandFreshness,
  checkHelpLinkTargets,
  checkPostSubmitDurability,
  deriveSubcommandSurface,
  extractRenderedCommands,
  scanForbiddenStrings,
  scanRenderedHelperReachability,
} from "./scan.mjs";
import {
  ADVANCED_OWNER_UI_FILES,
  COMMAND_SOURCE_FILES,
  FORBIDDEN_RENDERED_HELPERS,
  FORBIDDEN_STRING_RULES,
  HELP_LINK_RULE,
  NORMAL_OWNER_UI_FILES,
  POST_SUBMIT_RULE,
  PUBLISHED_PACKAGES,
} from "./surface-manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: scripts/owner-journey-acceptance/ -> ../../ */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

async function readRepoFile(repoRelativePath) {
  return readFile(path.join(REPO_ROOT, repoRelativePath), "utf8");
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
 *   scannedFiles: { normal: string[], advanced: string[], commandSource: string[] },
 *   ok: boolean,
 * }>}
 */
export async function runLocalAcceptance(opts = {}) {
  const normalFiles = opts.normalFiles ?? NORMAL_OWNER_UI_FILES;
  const advancedFiles = opts.advancedFiles ?? ADVANCED_OWNER_UI_FILES;
  const commandSourceFiles = opts.commandSourceFiles ?? COMMAND_SOURCE_FILES;

  const surfaceByPackage = await derivePublishedCommandSurface();
  const findings = [];
  const renderedCommands = [];

  // Rendered-page tiers: forbidden-string scan + indirect-leak reachability +
  // any command literals embedded directly in the page.
  const scanRenderedTier = async (file, tier) => {
    const src = await readRepoFile(file);
    findings.push(...scanForbiddenStrings({ path: file, src, tier, rules: FORBIDDEN_STRING_RULES }));
    findings.push(
      ...scanRenderedHelperReachability({ path: file, src, forbiddenHelpers: FORBIDDEN_RENDERED_HELPERS })
    );
    const cmds = extractRenderedCommands(src).map((c) => ({ ...c, path: file }));
    const fresh = checkCommandFreshness({ commands: cmds, surfaceByPackage, publishedPackages: PUBLISHED_PACKAGES });
    findings.push(...fresh.findings);
    renderedCommands.push(...fresh.rendered);
  };

  for (const file of normalFiles) {
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
    const fresh = checkCommandFreshness({ commands: cmds, surfaceByPackage, publishedPackages: PUBLISHED_PACKAGES });
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
    findings.push(...checkPostSubmitDurability({ path: POST_SUBMIT_RULE.file, src, rule: POST_SUBMIT_RULE }));
  }

  const publishedSurface = Object.fromEntries(
    Object.entries(surfaceByPackage).map(([k, v]) => [k, [...v].sort()])
  );

  return {
    findings,
    renderedCommands,
    publishedSurface,
    scannedFiles: {
      normal: [...normalFiles],
      advanced: [...advancedFiles],
      commandSource: [...commandSourceFiles],
    },
    ok: findings.length === 0,
  };
}
