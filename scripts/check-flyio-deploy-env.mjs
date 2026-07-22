#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Deterministic preflight check for the Fly.io Core deploy target env contract.
//
// The selected Fly path is one public Core app plus Fly Postgres. The Core app
// runs the console on Fly's public port and the reference AS/RS listeners on
// loopback, matching the Railway one-service shape.
//
// This script is offline: it reads a dotenv-style file and catches avoidable
// deploy mistakes before a live Fly run:
//   - public origin not set, or not HTTPS;
//   - owner data left ungated;
//   - durable Postgres not attached as PDPP_DATABASE_URL or DATABASE_URL;
//   - topology variables that should remain owned by the platform-core image.
//
// Usage:
//   node scripts/check-flyio-deploy-env.mjs --core core.env
//   node scripts/check-flyio-deploy-env.mjs --core core.env --json

import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLACEHOLDER_RE = /<[^>]+>/;
const FORBIDDEN_CORE_KEYS = ["PORT", "AS_PORT", "RS_PORT", "PDPP_AS_URL", "PDPP_RS_URL"];

export function isPlaceholder(value) {
  if (value === undefined || value === null) {
    return true;
  }
  const trimmed = String(value).trim();
  if (trimmed === "") {
    return true;
  }
  return PLACEHOLDER_RE.test(trimmed);
}

export function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) {
      env[key] = value;
    }
  }
  return env;
}

export function evaluateFlyioCoreEnv(coreEnv) {
  const violations = [];

  const origin = coreEnv.PDPP_REFERENCE_ORIGIN;
  if (isPlaceholder(origin)) {
    violations.push(
      "PDPP_REFERENCE_ORIGIN is not set. Set it to the public Core HTTPS origin (e.g. https://<app-name>.fly.dev)."
    );
  } else if (!/^https:\/\//.test(String(origin).trim())) {
    violations.push(`PDPP_REFERENCE_ORIGIN must be an https:// origin for a public deploy; got "${origin}".`);
  }

  if (isPlaceholder(coreEnv.PDPP_OWNER_PASSWORD)) {
    violations.push(
      "PDPP_OWNER_PASSWORD is empty. A public origin with no owner password serves the " +
        "dashboard and device-approval surfaces anonymously. Set a non-empty secret."
    );
  }

  if (isPlaceholder(coreEnv.PDPP_DATABASE_URL) && isPlaceholder(coreEnv.DATABASE_URL)) {
    violations.push(
      "No durable database URL is set. Use Fly Postgres (`fly launch --db`) or attach Postgres " +
        "with PDPP_DATABASE_URL/DATABASE_URL so data survives restart."
    );
  }

  for (const key of FORBIDDEN_CORE_KEYS) {
    if (!isPlaceholder(coreEnv[key])) {
      violations.push(`core ${key} must not be set as a Fly app variable; the platform-core image keeps it internal.`);
    }
  }

  return violations;
}

function loadEnvFile(path) {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (err) {
    process.stderr.write(`Error reading env file "${path}": ${err.message}\n`);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  let corePath;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--core" && args[i + 1]) {
      corePath = args[++i];
    } else if (args[i] === "--json") {
      jsonOutput = true;
    }
  }

  if (!corePath) {
    process.stderr.write("Usage: node scripts/check-flyio-deploy-env.mjs --core <env-file> [--json]\n");
    process.exit(1);
  }

  const violations = evaluateFlyioCoreEnv(loadEnvFile(corePath));

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify({ ok: violations.length === 0, violations }, null, 2)}\n`);
  } else if (violations.length === 0) {
    process.stdout.write("Fly.io deploy env contract: OK\n");
  } else {
    process.stdout.write(`Fly.io deploy env contract: ${violations.length} violation(s)\n\n`);
    for (const violation of violations) {
      process.stdout.write(`  • ${violation}\n`);
    }
    process.stdout.write("\nSee deploy/flyio/README.md for the correct values.\n");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
