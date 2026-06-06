#!/usr/bin/env node
// Deterministic preflight check for the Fly.io Core deploy target env contract.
//
// This is the small, offline "doctor" the first-live-test gate runs BEFORE any
// live Fly.io run is requested (see openspec/changes/add-flyio-core-deploy-target
// and deploy/flyio/README.md). The richer live checks — composed-origin metadata
// consistency, owner-gating redirect, restart survival, MCP reachability — run
// against a real stack via `pnpm docker:smoke` and the live go/no-go checklist.
// This script catches the env-contract mistakes that would make those checks fail
// for an avoidable reason:
//
//   - public origin not set, or not HTTPS;
//   - owner data left ungated (empty PDPP_OWNER_PASSWORD on a public origin);
//   - storage left on the non-durable default (no PDPP_DATABASE_URL);
//   - console's private AS/RS targets unset, not *.internal, or pointing at a
//     public URL or localhost;
//   - PDPP_REFERENCE_ORIGIN mismatch between the console and reference apps.
//
// It does not contact Fly.io, Docker, or any network. It reads the dotenv-style
// files an operator intends to set on each app and reports contract violations.
//
// Usage:
//   node scripts/check-flyio-deploy-env.mjs --console console.env --reference reference.env
//   node scripts/check-flyio-deploy-env.mjs --console console.env --reference reference.env --json
//
// Exit codes: 0 = contract satisfied; 1 = one or more violations.

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// A placeholder is an unfilled template value, not a real configured value.
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

// Returns true if the URL uses a *.internal hostname — Fly's private WireGuard
// DNS. These are the only valid values for PDPP_AS_URL / PDPP_RS_URL on Fly.
export function isFlyInternalUrl(url, port) {
  if (isPlaceholder(url)) {
    return false;
  }
  try {
    const parsed = new URL(String(url).trim());
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname.endsWith('.internal') &&
      parsed.port === String(port)
    );
  } catch {
    return false;
  }
}

// Evaluate the console and reference envs against the Fly.io deploy contract.
// Returns an array of violation strings (empty means the contract is satisfied).
// Pure function so the test suite can exercise every branch without a filesystem.
export function evaluateFlyioDeployEnv(consoleEnv, referenceEnv) {
  const violations = [];

  // 1. Single public HTTPS origin must be set on both apps and must match.
  const consoleOrigin = consoleEnv.PDPP_REFERENCE_ORIGIN;
  const referenceOrigin = referenceEnv.PDPP_REFERENCE_ORIGIN;

  if (isPlaceholder(consoleOrigin)) {
    violations.push(
      'PDPP_REFERENCE_ORIGIN is not set on the console app. Set it to the public ' +
        'console HTTPS origin (e.g. https://<app-name>.fly.dev).',
    );
  } else if (!/^https:\/\//.test(String(consoleOrigin).trim())) {
    violations.push(
      `PDPP_REFERENCE_ORIGIN on the console app must be an https:// origin; got "${consoleOrigin}".`,
    );
  }

  if (isPlaceholder(referenceOrigin)) {
    violations.push(
      'PDPP_REFERENCE_ORIGIN is not set on the reference app. Set it to the same ' +
        'public HTTPS origin as the console app.',
    );
  } else if (!/^https:\/\//.test(String(referenceOrigin).trim())) {
    violations.push(
      `PDPP_REFERENCE_ORIGIN on the reference app must be an https:// origin; got "${referenceOrigin}".`,
    );
  }

  if (
    !isPlaceholder(consoleOrigin) &&
    !isPlaceholder(referenceOrigin) &&
    String(consoleOrigin).trim() !== String(referenceOrigin).trim()
  ) {
    violations.push(
      `PDPP_REFERENCE_ORIGIN must match on both apps; console has "${consoleOrigin}", ` +
        `reference has "${referenceOrigin}".`,
    );
  }

  // 2. Owner gate required on both apps, and must match.
  if (isPlaceholder(consoleEnv.PDPP_OWNER_PASSWORD)) {
    violations.push(
      'PDPP_OWNER_PASSWORD is empty on the console app. A public origin with no owner password ' +
        'serves the dashboard and device-approval surfaces anonymously. Set a non-empty secret.',
    );
  }
  if (isPlaceholder(referenceEnv.PDPP_OWNER_PASSWORD)) {
    violations.push(
      'PDPP_OWNER_PASSWORD is empty on the reference app. Set it to the same non-empty ' +
        'value as the console app.',
    );
  }
  if (
    !isPlaceholder(consoleEnv.PDPP_OWNER_PASSWORD) &&
    !isPlaceholder(referenceEnv.PDPP_OWNER_PASSWORD) &&
    String(consoleEnv.PDPP_OWNER_PASSWORD).trim() !== String(referenceEnv.PDPP_OWNER_PASSWORD).trim()
  ) {
    violations.push(
      'PDPP_OWNER_PASSWORD must match on both apps; the values differ.',
    );
  }

  // 3. Console private AS/RS targets must be set and use *.internal hostnames.
  const asUrl = consoleEnv.PDPP_AS_URL;
  const rsUrl = consoleEnv.PDPP_RS_URL;

  if (isPlaceholder(asUrl)) {
    violations.push(
      'PDPP_AS_URL is not set on the console app. Set it to the private reference app ' +
        'Authorization Server (e.g. http://<reference-app>.internal:7662).',
    );
  } else if (!isFlyInternalUrl(asUrl, 7662)) {
    violations.push(
      `PDPP_AS_URL must use a *.internal hostname and port 7662 for the Fly.io private ` +
        `network (e.g. http://<reference-app>.internal:7662); got "${asUrl}". ` +
        'Public URLs and localhost are not valid for the private reference app.',
    );
  }

  if (isPlaceholder(rsUrl)) {
    violations.push(
      'PDPP_RS_URL is not set on the console app. Set it to the private reference app ' +
        'Resource Server (e.g. http://<reference-app>.internal:7663).',
    );
  } else if (!isFlyInternalUrl(rsUrl, 7663)) {
    violations.push(
      `PDPP_RS_URL must use a *.internal hostname and port 7663 for the Fly.io private ` +
        `network (e.g. http://<reference-app>.internal:7663); got "${rsUrl}". ` +
        'Public URLs and localhost are not valid for the private reference app.',
    );
  }

  // 4. Durable storage required on both apps.
  if (isPlaceholder(consoleEnv.PDPP_DATABASE_URL)) {
    violations.push(
      'PDPP_DATABASE_URL is not set on the console app. The non-durable in-memory SQLite ' +
        'default cannot survive restart. Set it to the Fly Postgres connection string ' +
        '(use `fly postgres attach` to wire it automatically).',
    );
  }
  if (isPlaceholder(referenceEnv.PDPP_DATABASE_URL)) {
    violations.push(
      'PDPP_DATABASE_URL is not set on the reference app. Set it to the same Postgres ' +
        'connection string as the console app.',
    );
  }

  return violations;
}

// --- CLI ---

function loadEnvFile(path) {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch (err) {
    process.stderr.write(`Error reading env file "${path}": ${err.message}\n`);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  let consolePath;
  let referencePath;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--console' && args[i + 1]) {
      consolePath = args[++i];
    } else if (args[i] === '--reference' && args[i + 1]) {
      referencePath = args[++i];
    } else if (args[i] === '--json') {
      jsonOutput = true;
    }
  }

  if (!consolePath || !referencePath) {
    process.stderr.write(
      'Usage: node scripts/check-flyio-deploy-env.mjs --console <env-file> --reference <env-file> [--json]\n',
    );
    process.exit(1);
  }

  const consoleEnv = loadEnvFile(consolePath);
  const referenceEnv = loadEnvFile(referencePath);
  const violations = evaluateFlyioDeployEnv(consoleEnv, referenceEnv);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ ok: violations.length === 0, violations }, null, 2) + '\n');
  } else if (violations.length === 0) {
    process.stdout.write('Fly.io deploy env contract: OK\n');
  } else {
    process.stdout.write(`Fly.io deploy env contract: ${violations.length} violation(s)\n\n`);
    for (const v of violations) {
      process.stdout.write(`  • ${v}\n`);
    }
    process.stdout.write('\nSee deploy/flyio/README.md for the correct values.\n');
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
