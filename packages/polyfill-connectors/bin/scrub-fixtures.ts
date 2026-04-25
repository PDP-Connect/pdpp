#!/usr/bin/env node

/**
 * Scrub captured fixtures for a connector.
 *
 * Usage:
 *   pnpm exec tsx bin/scrub-fixtures.ts <connector> [runId]
 *
 * Reads every file under `fixtures/<connector>/raw/<runId>/` (or all runIds
 * if none given), applies default scrub rules (src/scrub-defaults.ts) plus
 * connector-specific rules (connectors/<connector>/scrub-rules.ts if it
 * exists), and writes sanitized copies to `fixtures/<connector>/scrubbed/<runId>/`.
 *
 * The raw/ tree stays gitignored (local-only, PII). The scrubbed/ tree is
 * intended for commit and for use as test fixtures.
 *
 * Scrub rules are {pattern: RegExp, replacement: string, scope: 'all'|'html'|'json'}.
 * Connector rules are applied AFTER defaults so connector-specific patterns
 * can override broader defaults if needed.
 *
 * Exit codes: 0 on success, 1 on error, 2 if no raw files found.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyScrubRules, fileScopeOf, loadConnectorScrubRules, type ScrubRule } from "../src/scrubber.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(p)));
    } else {
      out.push(p);
    }
  }
  return out;
}

async function listRunIds(rawRoot: string, runIdArg: string | undefined): Promise<string[]> {
  if (runIdArg) {
    return [runIdArg];
  }

  const entries = await readdir(rawRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function main(): Promise<void> {
  const [, , connector, runIdArg] = process.argv;
  if (!connector) {
    console.error("Usage: pnpm exec tsx bin/scrub-fixtures.ts <connector> [runId]");
    process.exit(1);
  }

  const rawRoot = join(PACKAGE_ROOT, "fixtures", connector, "raw");
  const scrubbedRoot = join(PACKAGE_ROOT, "fixtures", connector, "scrubbed");

  if (!existsSync(rawRoot)) {
    console.error(`No raw fixtures for '${connector}' at ${rawRoot}`);
    console.error("Run the connector with PDPP_CAPTURE_FIXTURES=1 first.");
    process.exit(2);
  }

  const runIds = await listRunIds(rawRoot, runIdArg);

  const { defaultScrubRules } = (await import(pathToFileURL(join(PACKAGE_ROOT, "src/scrub-defaults.ts")).href)) as {
    defaultScrubRules: ScrubRule[];
  };
  const connectorRules = await loadConnectorScrubRules(PACKAGE_ROOT, connector);
  const allRules: ScrubRule[] = [...defaultScrubRules, ...connectorRules];

  console.log(
    `Scrubbing ${connector} with ${defaultScrubRules.length} default + ${connectorRules.length} connector-specific rules`
  );

  for (const runId of runIds) {
    const rawDir = join(rawRoot, runId);
    const outDir = join(scrubbedRoot, runId);
    const files = await walk(rawDir);
    if (!files.length) {
      continue;
    }

    console.log(`\n${runId}: ${files.length} files`);
    let scrubbed = 0;
    for (const src of files) {
      const rel = relative(rawDir, src);
      const dst = join(outDir, rel);
      await mkdir(dirname(dst), { recursive: true });
      const raw = await readFile(src, "utf8");
      const out = applyScrubRules(raw, allRules, fileScopeOf(src));
      await writeFile(dst, out);
      scrubbed++;
    }
    console.log(`  wrote ${scrubbed} scrubbed files to ${relative(PACKAGE_ROOT, outDir)}`);
  }

  console.log("\nDone. Review the scrubbed/ tree before committing.");
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  console.error(msg);
  process.exit(1);
});
