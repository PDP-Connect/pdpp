#!/usr/bin/env node
/**
 * Scrub captured fixtures for a connector.
 *
 * Usage:
 *   node bin/scrub-fixtures.mjs <connector> [runId]
 *
 * Reads every file under `fixtures/<connector>/raw/<runId>/` (or all runIds
 * if none given), applies default scrub rules (src/scrub-defaults.js) plus
 * connector-specific rules (connectors/<connector>/scrub-rules.js if it
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

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

function scopeMatches(fileScope, ruleScope) {
  if (ruleScope === 'all' || !ruleScope) return true;
  return ruleScope === fileScope;
}

function fileScopeOf(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.json' || ext === '.jsonl') return 'json';
  return 'all';
}

function applyRules(content, rules, fileScope) {
  let out = content;
  for (const rule of rules) {
    if (!scopeMatches(fileScope, rule.scope)) continue;
    const { pattern, replacement } = rule;
    if (!(pattern instanceof RegExp)) {
      console.warn(`skipping rule with non-regex pattern:`, rule);
      continue;
    }
    if (typeof replacement === 'function') {
      out = out.replace(pattern, replacement);
    } else {
      out = out.replace(pattern, replacement);
    }
  }
  return out;
}

async function loadConnectorRules(connector) {
  const file = join(PACKAGE_ROOT, 'connectors', connector, 'scrub-rules.js');
  if (!existsSync(file)) return [];
  const mod = await import(pathToFileURL(file).href);
  const rules = mod.scrubRules || mod.default || [];
  if (!Array.isArray(rules)) {
    console.warn(`${file}: expected scrubRules array; got ${typeof rules}`);
    return [];
  }
  return rules;
}

async function main() {
  const [, , connector, runIdArg] = process.argv;
  if (!connector) {
    console.error('Usage: node bin/scrub-fixtures.mjs <connector> [runId]');
    process.exit(1);
  }

  const rawRoot = join(PACKAGE_ROOT, 'fixtures', connector, 'raw');
  const scrubbedRoot = join(PACKAGE_ROOT, 'fixtures', connector, 'scrubbed');

  if (!existsSync(rawRoot)) {
    console.error(`No raw fixtures for '${connector}' at ${rawRoot}`);
    console.error(`Run the connector with PDPP_CAPTURE_FIXTURES=1 first.`);
    process.exit(2);
  }

  const runIds = runIdArg
    ? [runIdArg]
    : (await readdir(rawRoot)).filter(async (n) => (await stat(join(rawRoot, n))).isDirectory());

  const { defaultScrubRules } = await import(pathToFileURL(join(PACKAGE_ROOT, 'src/scrub-defaults.js')).href);
  const connectorRules = await loadConnectorRules(connector);
  const allRules = [...defaultScrubRules, ...connectorRules];

  console.log(`Scrubbing ${connector} with ${defaultScrubRules.length} default + ${connectorRules.length} connector-specific rules`);

  for (const runId of runIds) {
    const rawDir = join(rawRoot, runId);
    const outDir = join(scrubbedRoot, runId);
    const files = await walk(rawDir);
    if (!files.length) continue;

    console.log(`\n${runId}: ${files.length} files`);
    let scrubbed = 0;
    for (const src of files) {
      const rel = relative(rawDir, src);
      const dst = join(outDir, rel);
      await mkdir(dirname(dst), { recursive: true });
      const raw = await readFile(src, 'utf8');
      const out = applyRules(raw, allRules, fileScopeOf(src));
      await writeFile(dst, out);
      scrubbed++;
    }
    console.log(`  wrote ${scrubbed} scrubbed files to ${relative(PACKAGE_ROOT, outDir)}`);
  }

  console.log('\nDone. Review the scrubbed/ tree before committing.');
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
