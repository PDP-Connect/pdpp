#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI for the manifest-vs-schema-vs-emit reconciler. Iterates every
 * first-party manifest, finds the matching connector source, and prints
 * any drift. Returns nonzero if any connector has drift, so this is
 * suitable for CI / pre-commit gating. By default, only schema-bearing
 * connectors are checked; `--all` is the broader audit mode that also reports
 * known schemaless-connector coverage gaps.
 *
 * Usage:
 *   pnpm exec tsx bin/reconcile-manifests.ts                  # schema-bearing gate
 *   pnpm exec tsx bin/reconcile-manifests.ts --all            # all manifests audit
 *   pnpm exec tsx bin/reconcile-manifests.ts amazon github    # subset
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ReconcileReport, reconcileFromDisk } from "../src/manifest-reconcile.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const MANIFEST_DIR = join(PKG_ROOT, "manifests");
const CONNECTORS_DIR = join(PKG_ROOT, "connectors");
const JSON_EXT_RE = /\.json$/;

/** Map manifest filename (without .json) to the connectors/ dir. They
 *  match in every case so far; this exists so future divergence has a
 *  single place to encode. */
function connectorDirFor(manifestName: string): string {
  return manifestName;
}

/** Return paths the emit-scanner should read for a connector. We include
 *  index.ts and parsers.ts when they exist; everything else under the
 *  connector dir is left out to keep the scan fast and predictable. */
function emitSourcePathsFor(connectorDir: string): string[] {
  const candidates = ["index.ts", "parsers.ts"];
  return candidates.map((f) => join(connectorDir, f)).filter(existsSync);
}

function listManifestNames(): string[] {
  return readdirSync(MANIFEST_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(JSON_EXT_RE, ""))
    .sort();
}

function listSchemaConnectorNames(): string[] {
  return readdirSync(CONNECTORS_DIR)
    .filter((name) => existsSync(join(CONNECTORS_DIR, name, "schemas.ts")))
    .sort();
}

function buildReport(name: string): ReconcileReport | null {
  const dir = join(CONNECTORS_DIR, connectorDirFor(name));
  if (!existsSync(dir)) {
    return null;
  }
  const schemaPath = join(dir, "schemas.ts");
  return reconcileFromDisk({
    connector: name,
    manifestPath: join(MANIFEST_DIR, `${name}.json`),
    schemaPath: existsSync(schemaPath) ? schemaPath : null,
    emitSourcePaths: emitSourcePathsFor(dir),
  });
}

function printReport(r: ReconcileReport): void {
  const flag = r.ok ? "✓" : "✖";
  console.log(`${flag} ${r.connector}`);
  console.log(`    manifest:   [${r.declared.join(", ")}]`);
  console.log(`    schema:     [${r.registered.join(", ")}]`);
  console.log(`    emitted:    [${r.emitted.join(", ")}]`);
  if (r.missing_manifest.length > 0) {
    console.log(`    ✖ emitted but undeclared: ${r.missing_manifest.join(", ")}`);
  }
  if (r.missing_schema.length > 0) {
    console.log(`    ✖ emitted without schema: ${r.missing_schema.join(", ")}`);
  }
  if (r.missing_emit.length > 0) {
    console.log(`    ✖ declared but unfilled:  ${r.missing_emit.join(", ")}`);
  }
}

function printUsage(): void {
  console.log(`Usage:
  pnpm exec tsx bin/reconcile-manifests.ts [--all] [connector ...]

Default:
  Check schema-bearing connectors only. This is the CI/pre-commit gate.

Options:
  --all    Audit every manifest, including known schemaless coverage gaps.
  --help   Show this help text.
`);
}

function parseTargets(argv: string[]): string[] | null {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return null;
  }
  const includeAll = argv.includes("--all");
  const targets = argv.filter((arg) => arg !== "--all");
  if (targets.length > 0) {
    return targets;
  }
  return includeAll ? listManifestNames() : listSchemaConnectorNames();
}

function main(): void {
  const targets = parseTargets(process.argv.slice(2));
  if (targets === null) {
    return;
  }
  let totalDrift = 0;
  for (const name of targets) {
    const r = buildReport(name);
    if (r === null) {
      console.log(`# ${name} — manifest exists but no connectors/${name}/ dir; skipping`);
      continue;
    }
    printReport(r);
    if (!r.ok) {
      totalDrift++;
    }
  }
  console.log(`\n${targets.length} connectors checked, ${totalDrift} with drift`);
  if (totalDrift > 0) {
    process.exit(1);
  }
}

main();
