#!/usr/bin/env node
// Deterministic preflight check for the Railway Core deploy target env contract.
//
// This is the small, offline "doctor" the first-live-test gate runs BEFORE any
// live Railway run is requested (see openspec/changes/add-railway-core-deploy-
// target and deploy/railway/README.md). The richer live checks — composed-
// origin metadata consistency, owner-gating redirect, restart survival, MCP
// reachability — run against a real stack via `pnpm docker:smoke` and the live
// go/no-go checklist. This script catches the env-contract mistakes that would
// make those live checks fail for an avoidable reason:
//
//   - public origin not set, or not HTTPS;
//   - owner data left ungated (empty PDPP_OWNER_PASSWORD on a public origin);
//   - storage left on the non-durable default;
//   - SQLite chosen but PDPP_DB_PATH left at a default that is not a mount;
//   - Postgres chosen but PDPP_DATABASE_URL missing;
//   - console's private AS/RS targets unset.
//
// It does not contact Railway, Docker, or any network. It reads a dotenv-style
// file (the merged variables an operator intends to set across the console and
// reference services) and reports contract violations.
//
// Usage:
//   node scripts/check-railway-deploy-env.mjs deploy/railway/env.example [--json]
//   node scripts/check-railway-deploy-env.mjs <path-to-your-merged-env> [--json]
//
// Exit codes: 0 = contract satisfied; 1 = one or more violations.

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// A placeholder is an unfilled template value, not a real configured value.
// `deploy/railway/env.example` uses angle-bracket placeholders and Railway
// reference-variable syntax on purpose; treat both as "not yet set".
const PLACEHOLDER_RE = /<[^>]+>/;

export function isPlaceholder(value) {
  if (value === undefined || value === null) {
    return true;
  }
  const trimmed = String(value).trim();
  if (trimmed === '') {
    return true;
  }
  return PLACEHOLDER_RE.test(trimmed);
}

// `${{Postgres.DATABASE_URL}}` is a Railway reference variable: it is a real,
// intentional binding that Railway resolves at deploy time, so it counts as
// "configured" for contract purposes even though it is not a literal URL here.
export function isRailwayReference(value) {
  return typeof value === 'string' && /\$\{\{[^}]+\}\}/.test(value.trim());
}

export function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      env[key] = value;
    }
  }
  return env;
}

// The default SQLite path is NOT under the documented Railway volume mount, so
// leaving it as-is silently loses data on redeploy. Any path under a real mount
// (anything that is not the known unmounted default) is accepted.
export const UNMOUNTED_SQLITE_DEFAULT = '/var/lib/pdpp/pdpp.sqlite';

// Evaluate the merged env against the deploy contract. Returns an array of
// violation strings (empty means the contract is satisfied). Pure function so
// the test suite can exercise every branch without a filesystem.
export function evaluateRailwayDeployEnv(env) {
  const violations = [];

  // 1. Single public HTTPS origin.
  const origin = env.PDPP_REFERENCE_ORIGIN;
  if (isPlaceholder(origin)) {
    violations.push(
      'PDPP_REFERENCE_ORIGIN is not set. Set it to the public console HTTPS origin on both services.',
    );
  } else if (!/^https:\/\//.test(origin.trim())) {
    violations.push(
      `PDPP_REFERENCE_ORIGIN must be an https:// origin for a public deploy; got "${origin}".`,
    );
  }

  // 2. Owner gate required.
  if (isPlaceholder(env.PDPP_OWNER_PASSWORD)) {
    violations.push(
      'PDPP_OWNER_PASSWORD is empty. A public origin with no owner password serves the dashboard and ' +
        'device-approval surfaces anonymously. Set a non-empty secret.',
    );
  }

  // 3. Console private AS/RS targets.
  if (isPlaceholder(env.PDPP_AS_URL)) {
    violations.push(
      'PDPP_AS_URL is not set. The console must reach the private reference Authorization Server ' +
        '(e.g. http://reference.railway.internal:7662).',
    );
  }
  if (isPlaceholder(env.PDPP_RS_URL)) {
    violations.push(
      'PDPP_RS_URL is not set. The console must reach the private reference Resource Server ' +
        '(e.g. http://reference.railway.internal:7663).',
    );
  }

  // 4. Storage chosen explicitly and durably.
  const backend = (env.PDPP_STORAGE_BACKEND ?? '').trim().toLowerCase();
  if (backend === 'postgres') {
    const url = env.PDPP_DATABASE_URL;
    if (isPlaceholder(url) && !isRailwayReference(url)) {
      violations.push(
        'PDPP_STORAGE_BACKEND=postgres requires PDPP_DATABASE_URL (e.g. ${{Postgres.DATABASE_URL}}).',
      );
    }
  } else if (backend === 'sqlite') {
    const dbPath = (env.PDPP_DB_PATH ?? '').trim();
    if (dbPath === '' || dbPath === UNMOUNTED_SQLITE_DEFAULT) {
      violations.push(
        `PDPP_STORAGE_BACKEND=sqlite requires PDPP_DB_PATH on a mounted persistent volume. ` +
          `"${dbPath || '(unset)'}" is the unmounted default and loses data on redeploy.`,
      );
    }
  } else {
    violations.push(
      `PDPP_STORAGE_BACKEND must be "postgres" or "sqlite" for a durable deploy; got "${
        env.PDPP_STORAGE_BACKEND ?? '(unset)'
      }". The in-memory default is not durable.`,
    );
  }

  return violations;
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const filePath = args.find((arg) => !arg.startsWith('--'));

  if (!filePath) {
    process.stderr.write(
      'Usage: node scripts/check-railway-deploy-env.mjs <env-file> [--json]\n',
    );
    process.exit(1);
  }

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    process.stderr.write(`Cannot read env file "${filePath}": ${error?.message ?? error}\n`);
    process.exit(1);
  }

  const env = parseEnv(text);
  const violations = evaluateRailwayDeployEnv(env);
  const ok = violations.length === 0;

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, file: filePath, violations }, null, 2)}\n`);
  } else if (ok) {
    process.stdout.write(`Railway deploy env contract satisfied: ${filePath}\n`);
  } else {
    process.stderr.write(
      `Railway deploy env contract violations in ${filePath}:\n` +
        violations.map((v) => `- ${v}`).join('\n') +
        '\n',
    );
  }

  process.exit(ok ? 0 : 1);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main(process.argv);
}
