#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
//   - credential key provider missing, which would block owner-captured
//     static-secret connector setup after the user has already gathered a
//     provider credential;
//   - storage left on the non-durable default;
//   - SQLite chosen but PDPP_DB_PATH left at a default that is not a mount;
//   - Postgres chosen, or inferred from PDPP_DATABASE_URL, but the database URL is missing;
//   - selected core-service path accidentally carries topology constants that
//     should stay baked into the image/supervisor.
//
// It does not contact Railway, Docker, or any network. It reads the dotenv-style
// files an operator intends to set on the Railway app services and reports
// contract violations. The selected pushbutton path is one `core` service. The
// older split-service path is still supported for manual operator runs.
//
// Usage:
//   node scripts/check-railway-deploy-env.ts --core core.env
//   node scripts/check-railway-deploy-env.ts --console console.env --reference reference.env
//   node scripts/check-railway-deploy-env.ts --core core.env --json
//
// Exit codes: 0 = contract satisfied; 1 = one or more violations.

import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

// A placeholder is an unfilled template value, not a real configured value.
// `deploy/railway/env.example` uses angle-bracket placeholders and Railway
// reference-variable syntax on purpose; treat both as "not yet set".
const PLACEHOLDER_PATTERN = /<[^>]+>/;
const HTTPS_ORIGIN_PATTERN = /^https:\/\//;
const RAILWAY_REFERENCE_PATTERN = /\$\{\{[^}]+\}\}/;

export function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  const trimmed = String(value).trim();
  if (trimmed === "") {
    return true;
  }
  return PLACEHOLDER_PATTERN.test(trimmed);
}

// `${{Postgres.DATABASE_URL}}` and
// `http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:${{reference.PORT}}` are Railway
// reference variables: real, intentional bindings Railway resolves at deploy time.
export function isRailwayReference(value: string | undefined): boolean {
  return typeof value === "string" && RAILWAY_REFERENCE_PATTERN.test(value.trim());
}

export type EnvMap = Record<string, string>;

export function parseEnv(text: string): EnvMap {
  const env: EnvMap = {};
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
    // Strip a single layer of matching quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
export const UNMOUNTED_SQLITE_DEFAULT = "/var/lib/pdpp/pdpp.sqlite";

function envValue(env: EnvMap, key: string): string | undefined {
  return env[key];
}

function requireSame(violations: string[], consoleEnv: EnvMap, referenceEnv: EnvMap, key: string, label: string): void {
  const consoleValue = envValue(consoleEnv, key);
  const referenceValue = envValue(referenceEnv, key);
  if (isPlaceholder(consoleValue)) {
    violations.push(`${label}: console ${key} is not set.`);
  }
  if (isPlaceholder(referenceValue)) {
    violations.push(`${label}: reference ${key} is not set.`);
  }
  if (
    !(isPlaceholder(consoleValue) || isPlaceholder(referenceValue)) &&
    String(consoleValue).trim() !== String(referenceValue).trim()
  ) {
    violations.push(
      `${label}: console and reference ${key} must match; got "${consoleValue}" and "${referenceValue}".`
    );
  }
}

function isRailwayPrivateUrl(url: string | undefined, port: number): boolean {
  if (isPlaceholder(url)) {
    return false;
  }
  if (isRailwayReference(url)) {
    return new RegExp(`^http://\\$\\{\\{[^}]*RAILWAY_PRIVATE_DOMAIN[^}]*\\}\\}:${port}$`).test(String(url).trim());
  }
  try {
    const parsed = new URL(String(url).trim());
    return parsed.protocol === "http:" && parsed.hostname.endsWith(".railway.internal") && parsed.port === String(port);
  } catch {
    return false;
  }
}

function isRailwayPrivateUrlWithPortReference(url: string | undefined, portReference: string): boolean {
  if (isPlaceholder(url) || !isRailwayReference(url)) {
    return false;
  }
  const escaped = String(portReference).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^http://\\$\\{\\{[^}]*RAILWAY_PRIVATE_DOMAIN[^}]*\\}\\}:\\$\\{\\{${escaped}\\}\\}$`).test(
    String(url).trim()
  );
}

function hasDurableDatabaseUrl(env: EnvMap): boolean {
  const databaseUrl = env.PDPP_DATABASE_URL;
  return !isPlaceholder(databaseUrl) || isRailwayReference(databaseUrl);
}

function hasCredentialKeyProvider(env: EnvMap): boolean {
  return !(isPlaceholder(env.PDPP_CREDENTIAL_ENCRYPTION_KEY) && isPlaceholder(env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE));
}

function requireExpectedIfSet(violations: string[], env: EnvMap, key: string, expected: string, message: string): void {
  if (isPlaceholder(env[key])) {
    return;
  }
  if (String(env[key]).trim() !== expected) {
    violations.push(message);
  }
}

// Evaluate the merged env against the deploy contract. Returns an array of
// violation strings (empty means the contract is satisfied). Pure function so
// the test suite can exercise every branch without a filesystem.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exhaustive per-field deploy-contract validation, carried over unchanged from the .mjs source.
export function evaluateRailwayDeployEnv(env: EnvMap): string[] {
  const violations: string[] = [];

  // 1. Single public HTTPS origin.
  const origin = env.PDPP_REFERENCE_ORIGIN;
  if (isPlaceholder(origin)) {
    violations.push("PDPP_REFERENCE_ORIGIN is not set. Set it to the public console HTTPS origin on both services.");
  } else if (!HTTPS_ORIGIN_PATTERN.test(String(origin).trim())) {
    violations.push(`PDPP_REFERENCE_ORIGIN must be an https:// origin for a public deploy; got "${origin}".`);
  }

  // 2. Owner gate required.
  if (isPlaceholder(env.PDPP_OWNER_PASSWORD)) {
    violations.push(
      "PDPP_OWNER_PASSWORD is empty. A public origin with no owner password serves the dashboard and " +
        "device-approval surfaces anonymously. Set a non-empty secret."
    );
  }

  // 3. Instance-level credential key provider. Railway templates should
  // generate PDPP_CREDENTIAL_ENCRYPTION_KEY automatically; Docker/Kubernetes
  // style deployments may use PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE.
  if (!hasCredentialKeyProvider(env)) {
    violations.push(
      "PDPP_CREDENTIAL_ENCRYPTION_KEY or PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE is not set. " +
        "Static-secret connector setup will be blocked until an instance-level credential key provider exists."
    );
  }

  // 4. Console private AS/RS targets.
  if (isPlaceholder(env.PDPP_AS_URL)) {
    violations.push(
      "PDPP_AS_URL is not set. The console must reach the private reference Authorization Server " +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Railway `${{...}}` reference-variable syntax, not JS interpolation.
        "(e.g. http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:${{reference.PORT}})."
    );
  }
  if (isPlaceholder(env.PDPP_RS_URL)) {
    violations.push(
      "PDPP_RS_URL is not set. The console must reach the private reference Resource Server " +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Railway `${{...}}` reference-variable syntax, not JS interpolation.
        "(e.g. http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:7663)."
    );
  }

  // 5. Storage chosen explicitly and durably.
  // biome-ignore lint/suspicious/noUnnecessaryConditions: EnvMap is Record<string, string>, so TS treats dotted access as always-string; the real parseEnv output can still omit the key at runtime, so the fallback stays.
  const configuredBackend = (env.PDPP_STORAGE_BACKEND ?? "").trim().toLowerCase();
  const backend = configuredBackend || (hasDurableDatabaseUrl(env) ? "postgres" : "");
  if (backend === "postgres") {
    const url = env.PDPP_DATABASE_URL;
    if (isPlaceholder(url) && !isRailwayReference(url)) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Railway `${{...}}` reference-variable syntax, not JS interpolation.
      violations.push("Postgres storage requires PDPP_DATABASE_URL (e.g. ${{Postgres.DATABASE_URL}}).");
    }
  } else if (backend === "sqlite") {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: EnvMap is Record<string, string>, so TS treats dotted access as always-string; the real parseEnv output can still omit the key at runtime, so the fallback stays.
    const dbPath = (env.PDPP_DB_PATH ?? "").trim();
    if (dbPath === "" || dbPath === UNMOUNTED_SQLITE_DEFAULT) {
      violations.push(
        "PDPP_STORAGE_BACKEND=sqlite requires PDPP_DB_PATH on a mounted persistent volume. " +
          `"${dbPath || "(unset)"}" is the unmounted default and loses data on redeploy.`
      );
    }
  } else {
    violations.push(
      `PDPP_STORAGE_BACKEND must be "postgres" or "sqlite", or PDPP_DATABASE_URL must be set so Postgres can be inferred; got "${
        // biome-ignore lint/suspicious/noUnnecessaryConditions: EnvMap is Record<string, string>, so TS treats dotted access as always-string; the real parseEnv output can still omit the key at runtime, so the fallback stays.
        env.PDPP_STORAGE_BACKEND ?? "(unset)"
      }". The in-memory default is not durable.`
    );
  }

  return violations;
}

const NON_CORE_RELEVANT_VIOLATION_PATTERN = /^(PDPP_AS_URL|PDPP_RS_URL)/;

export function evaluateRailwayCoreServiceEnv(coreEnv: EnvMap): string[] {
  const violations: string[] = [];
  const deployEnv: EnvMap = {
    ...coreEnv,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: EnvMap is Record<string, string>, so TS treats dotted access as always-string; the real parseEnv output can still omit this key at runtime, so the fallback stays.
    PDPP_AS_URL: coreEnv.PDPP_AS_URL ?? "http://127.0.0.1:7662",
    // biome-ignore lint/suspicious/noUnnecessaryConditions: EnvMap is Record<string, string>, so TS treats dotted access as always-string; the real parseEnv output can still omit this key at runtime, so the fallback stays.
    PDPP_RS_URL: coreEnv.PDPP_RS_URL ?? "http://127.0.0.1:7663",
  };
  violations.push(
    ...evaluateRailwayDeployEnv(deployEnv).filter((violation) => !NON_CORE_RELEVANT_VIOLATION_PATTERN.test(violation))
  );

  for (const key of ["PORT", "AS_PORT", "RS_PORT", "PDPP_AS_URL", "PDPP_RS_URL"]) {
    if (!isPlaceholder(coreEnv[key])) {
      violations.push(
        `core ${key} must not be set as a Railway service variable; the railway-core image keeps it internal.`
      );
    }
  }

  return violations;
}

const REFERENCE_DEPLOY_ENV_FILTERED_VIOLATION_PATTERN =
  /^(PDPP_REFERENCE_ORIGIN|PDPP_OWNER_PASSWORD|PDPP_AS_URL|PDPP_RS_URL)/;

export function evaluateRailwayServiceEnvs({
  consoleEnv,
  referenceEnv,
}: {
  consoleEnv: EnvMap;
  referenceEnv: EnvMap;
}): string[] {
  const violations: string[] = [];

  requireSame(violations, consoleEnv, referenceEnv, "PDPP_REFERENCE_ORIGIN", "public origin");
  const origin = consoleEnv.PDPP_REFERENCE_ORIGIN;
  if (!(isPlaceholder(origin) || HTTPS_ORIGIN_PATTERN.test(String(origin).trim()))) {
    violations.push(`public origin: PDPP_REFERENCE_ORIGIN must be an https:// origin; got "${origin}".`);
  }

  requireExpectedIfSet(
    violations,
    consoleEnv,
    "PDPP_REFERENCE_MODE",
    "composed",
    'composed mode: console PDPP_REFERENCE_MODE must be "composed" when set.'
  );
  requireExpectedIfSet(
    violations,
    referenceEnv,
    "PDPP_REFERENCE_MODE",
    "composed",
    'composed mode: reference PDPP_REFERENCE_MODE must be "composed" when set.'
  );

  requireSame(violations, consoleEnv, referenceEnv, "PDPP_OWNER_PASSWORD", "owner gate");

  const consoleAsUrl = consoleEnv.PDPP_AS_URL;
  if (!isRailwayPrivateUrlWithPortReference(consoleAsUrl, "reference.PORT")) {
    violations.push(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Railway `${{...}}` reference-variable syntax, not JS interpolation.
      "console PDPP_AS_URL must point at the private Railway reference AS (expected http://<reference-service>.railway.internal:${{reference.PORT}})."
    );
  }

  const consoleRsUrl = consoleEnv.PDPP_RS_URL;
  if (!isRailwayPrivateUrl(consoleRsUrl, 7663)) {
    violations.push(
      "console PDPP_RS_URL must point at the private Railway reference RS (expected http://<reference-service>.railway.internal:7663)."
    );
  }

  requireExpectedIfSet(
    violations,
    consoleEnv,
    "PDPP_ENABLE_DASHBOARD",
    "1",
    'console PDPP_ENABLE_DASHBOARD must be "1" when set.'
  );
  if (!isPlaceholder(consoleEnv.PORT)) {
    violations.push("console PORT must not be set; Railway injects the public service port.");
  }

  requireExpectedIfSet(violations, referenceEnv, "NODE_ENV", "production", 'reference NODE_ENV must be "production".');
  requireExpectedIfSet(
    violations,
    referenceEnv,
    "AS_PORT",
    "7662",
    'reference AS_PORT must be "7662" when set outside Railway.'
  );
  requireExpectedIfSet(violations, referenceEnv, "RS_PORT", "7663", 'reference RS_PORT must be "7663".');
  if (!isPlaceholder(referenceEnv.PORT)) {
    violations.push("reference PORT must not be set; Railway injects it and the image maps it to AS_PORT.");
  }
  requireExpectedIfSet(
    violations,
    referenceEnv,
    "PDPP_REFERENCE_OPERATIONAL_DEFAULTS",
    "1",
    'reference PDPP_REFERENCE_OPERATIONAL_DEFAULTS must be "1".'
  );
  requireExpectedIfSet(
    violations,
    referenceEnv,
    "PDPP_RS_URL",
    "http://127.0.0.1:7663",
    'reference PDPP_RS_URL must be "http://127.0.0.1:7663" for hosted-MCP self-calls.'
  );
  requireExpectedIfSet(
    violations,
    referenceEnv,
    "PDPP_EMBEDDING_DOWNLOAD_ALLOWED",
    "0",
    'reference PDPP_EMBEDDING_DOWNLOAD_ALLOWED must be "0" for the Core test.'
  );

  violations.push(
    ...evaluateRailwayDeployEnv(referenceEnv).filter(
      (violation) => !REFERENCE_DEPLOY_ENV_FILTERED_VIOLATION_PATTERN.test(violation)
    )
  );

  return violations;
}

function readEnvFile(filePath: string): EnvMap {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read env file "${filePath}": ${message}`, { cause: error });
  }
  return parseEnv(text);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI entry handling both --core and --console/--reference modes plus json/text output, carried over unchanged from the .mjs source.
function main(argv: string[]): void {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const coreFlag = args.indexOf("--core");
  const consoleFlag = args.indexOf("--console");
  const referenceFlag = args.indexOf("--reference");
  const coreFile = coreFlag === -1 ? null : args[coreFlag + 1];
  const consoleFile = consoleFlag === -1 ? null : args[consoleFlag + 1];
  const referenceFile = referenceFlag === -1 ? null : args[referenceFlag + 1];

  if (coreFile && !coreFile.startsWith("--")) {
    let coreEnv: EnvMap;
    try {
      coreEnv = readEnvFile(coreFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
    const violations = evaluateRailwayCoreServiceEnv(coreEnv);
    const ok = violations.length === 0;
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok, core: coreFile, violations }, null, 2)}\n`);
    } else if (ok) {
      process.stdout.write(`Railway core env contract satisfied: core=${coreFile}\n`);
    } else {
      process.stderr.write(`Railway core env contract violations:\n${violations.map((v) => `- ${v}`).join("\n")}\n`);
    }
    process.exit(ok ? 0 : 1);
  }

  if (!(consoleFile && referenceFile) || consoleFile.startsWith("--") || referenceFile.startsWith("--")) {
    process.stderr.write(
      "Usage: node scripts/check-railway-deploy-env.ts --core <core-env> [--json]\n" +
        "   or: node scripts/check-railway-deploy-env.ts --console <console-env> --reference <reference-env> [--json]\n"
    );
    process.exit(1);
  }

  let consoleEnv: EnvMap;
  let referenceEnv: EnvMap;
  try {
    consoleEnv = readEnvFile(consoleFile);
    referenceEnv = readEnvFile(referenceFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }

  const violations = evaluateRailwayServiceEnvs({ consoleEnv, referenceEnv });
  const ok = violations.length === 0;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok, console: consoleFile, reference: referenceFile, violations }, null, 2)}\n`
    );
  } else if (ok) {
    process.stdout.write(`Railway deploy env contract satisfied: console=${consoleFile} reference=${referenceFile}\n`);
  } else {
    process.stderr.write(`Railway deploy env contract violations:\n${violations.map((v) => `- ${v}`).join("\n")}\n`);
  }

  process.exit(ok ? 0 : 1);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main(process.argv);
}
