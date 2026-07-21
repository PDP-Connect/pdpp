#!/usr/bin/env node

/**
 * Scrub captured fixtures for a connector.
 *
 * Usage:
 *   pnpm exec tsx bin/scrub-fixtures.ts <connector> [runId] [--llm-redactions-dir <dir>]
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
 * Optional LLM redaction plans live in a parallel directory. For each raw
 * relative file path, provide `<rel>.redactions.json` containing:
 * {"version":1,"redactions":[{"text":"Alice","replacement":"[REDACTED_NAME]","reason":"person"}]}
 * Missing or invalid plans fail the run before any scrubbed output is written.
 *
 * Exit codes: 0 on success, 1 on error, 2 if no raw files found.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyScrubRules,
  applyStructuredRedactionPlan,
  fileScopeOf,
  loadConnectorScrubRules,
  parseStructuredRedactionPlan,
  type ScrubRule,
} from "../src/scrubber.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface CliArgs {
  connector: string;
  llmRedactionsDir: string | null;
  runId: string | undefined;
}

interface PendingWrite {
  dst: string;
  out: string;
}

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

function parseArgs(argv: readonly string[]): CliArgs | null {
  const positional: string[] = [];
  let llmRedactionsDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--llm-redactions-dir") {
      const value = argv[i + 1];
      if (!value) {
        return null;
      }
      llmRedactionsDir = resolve(process.cwd(), value);
      i++;
      continue;
    }
    if (arg?.startsWith("--")) {
      return null;
    }
    if (arg) {
      positional.push(arg);
    }
  }
  const [connector, runId] = positional;
  if (!(connector && positional.length <= 2)) {
    return null;
  }
  return { connector, llmRedactionsDir, runId };
}

async function applyLlmPlan(content: string, rel: string, planRoot: string | null): Promise<string> {
  if (!planRoot) {
    return content;
  }
  const planPath = join(planRoot, `${rel}.redactions.json`);
  if (!existsSync(planPath)) {
    throw new Error(`missing LLM redaction plan for ${rel}: expected ${planPath}`);
  }
  const planJson = JSON.parse(await readFile(planPath, "utf8")) as unknown;
  const plan = parseStructuredRedactionPlan(planJson);
  return applyStructuredRedactionPlan(content, plan);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Usage: pnpm exec tsx bin/scrub-fixtures.ts <connector> [runId] [--llm-redactions-dir <dir>]");
    process.exit(1);
  }

  const { connector, llmRedactionsDir, runId: runIdArg } = args;
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
  if (llmRedactionsDir) {
    console.log(`Using fail-closed LLM redaction plans from ${llmRedactionsDir}`);
  }

  for (const runId of runIds) {
    const rawDir = join(rawRoot, runId);
    const outDir = join(scrubbedRoot, runId);
    const files = await walk(rawDir);
    if (!files.length) {
      continue;
    }

    console.log(`\n${runId}: ${files.length} files`);
    const pendingWrites: PendingWrite[] = [];
    for (const src of files) {
      const rel = relative(rawDir, src);
      const dst = join(outDir, rel);
      const raw = await readFile(src, "utf8");
      const deterministicOut = applyScrubRules(raw, allRules, fileScopeOf(src));
      const out = await applyLlmPlan(deterministicOut, rel, llmRedactionsDir);
      pendingWrites.push({ dst, out });
    }

    for (const pending of pendingWrites) {
      await mkdir(dirname(pending.dst), { recursive: true });
      await writeFile(pending.dst, pending.out);
    }
    console.log(`  wrote ${pendingWrites.length} scrubbed files to ${relative(PACKAGE_ROOT, outDir)}`);
  }

  console.log("\nDone. Review the scrubbed/ tree before committing.");
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  console.error(msg);
  process.exit(1);
});
