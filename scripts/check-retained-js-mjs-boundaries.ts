// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const LEDGER_PATH = "docs/retained-js-mjs-boundaries.json";
const REQUIRED_FIELDS = ["owner", "runtimeReason", "probe", "review"] as const;
const JS_MJS_CJS_PATH_PATTERN = /\.(?:cjs|js|mjs)$/;
const HOST_MJS_BOUNDARIES = new Set([
  "apps/console/next.config.mjs",
  "apps/console/postcss.config.mjs",
  "apps/site/.source/source.config.mjs",
  "apps/site/next.config.mjs",
  "apps/site/postcss.config.mjs",
  "apps/site/scripts/sync-spec-docs.mjs",
]);
const PROVIDER_CAPTURE_BOUNDARIES = new Set([
  "packages/polyfill-connectors/connectors/twitter_archive/__fixtures__/archive-files/data/direct-messages.js",
  "packages/polyfill-connectors/connectors/twitter_archive/__fixtures__/archive-files/data/tweets.js",
  "packages/polyfill-connectors/connectors/twitter_archive/__fixtures__/archive-files/empty/data/tweets.js",
  "packages/polyfill-connectors/connectors/twitter_archive/__fixtures__/archive-files/legacy/data/tweet.js",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface BoundaryEntry {
  owner: string;
  path: string;
  probe: string;
  review: string;
  runtimeReason: string;
  sha256?: string;
}

interface BoundaryLedger {
  entries: BoundaryEntry[];
}

interface GeneratedWrapper {
  header: string;
  source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isBoundaryEntry(value: unknown): value is BoundaryEntry {
  return (
    isRecord(value) &&
    typeof value.owner === "string" &&
    typeof value.path === "string" &&
    typeof value.probe === "string" &&
    typeof value.review === "string" &&
    typeof value.runtimeReason === "string" &&
    (value.sha256 === undefined || typeof value.sha256 === "string")
  );
}

function isBoundaryLedger(value: unknown): value is BoundaryLedger {
  return isRecord(value) && Array.isArray(value.entries) && value.entries.every(isBoundaryEntry);
}

const GENERATED_WRAPPERS: Record<string, GeneratedWrapper> = {
  "reference-implementation/scripts/quality-ratchet/check-mass-ratchet.test.mjs": {
    header: "// Generated test-discovery artifact.",
    source: "check-mass-ratchet.source.ts",
  },
  "reference-implementation/scripts/quality-ratchet/measure-mass.test.mjs": {
    header: "// Generated test-discovery artifact.",
    source: "measure-mass.source.ts",
  },
  "reference-implementation/scripts/quality-ratchet/regenerate-mass-baseline.test.mjs": {
    header: "// Generated test-discovery artifact.",
    source: "regenerate-mass-baseline.source.ts",
  },
  "reference-implementation/scripts/requeue-quarantined-detail-gaps.test.mjs": {
    header: "// Generated test-discovery artifact.",
    source: "requeue-quarantined-detail-gaps.source.ts",
  },
  "reference-implementation/test/fixtures/connector-instance-two-process-race-fixture.mjs": {
    header: "#!/usr/bin/env node\n// Generated subprocess artifact.",
    source: "connector-instance-two-process-race-fixture.ts",
  },
  "reference-implementation/test/fixtures/device-ingest-failstop-server.mjs": {
    header: "#!/usr/bin/env node\n// Generated subprocess artifact.",
    source: "device-ingest-failstop-server.ts",
  },
  "reference-implementation/test/fixtures/summary-evidence-two-process-repair-fixture.mjs": {
    header: "#!/usr/bin/env node\n// Generated subprocess artifact.",
    source: "summary-evidence-two-process-repair-fixture.ts",
  },
  "scripts/ri-suite/fixtures/fake-run-tests.mjs": {
    header: "#!/usr/bin/env node\n// Generated runtime artifact.",
    source: "fake-run-tests.ts",
  },
};

function trackedJavaScriptPaths(): string[] {
  return execFileSync("git", ["ls-files", "*.js", "*.mjs", "*.cjs"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function readLedger(): BoundaryLedger {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, LEDGER_PATH), "utf8"));
  if (!isBoundaryLedger(parsed)) {
    throw new Error(`${LEDGER_PATH} must contain an entries array`);
  }
  return parsed;
}

function assertEntry(entry: BoundaryEntry): void {
  if (!entry || typeof entry !== "object") {
    throw new Error("retained JS/MJS ledger entry must be an object");
  }
  if (typeof entry.path !== "string" || !JS_MJS_CJS_PATH_PATTERN.test(entry.path)) {
    throw new Error(`retained JS/MJS ledger entry has an invalid path: ${JSON.stringify(entry.path)}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof entry[field] !== "string" || !entry[field].trim()) {
      throw new Error(`retained JS/MJS ledger entry ${entry.path} needs a non-empty ${field}`);
    }
  }
}

function assertExactInventory(entries: BoundaryEntry[], trackedPaths: string[]): void {
  const paths = entries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
  if (new Set(paths).size !== paths.length) {
    throw new Error("retained JS/MJS ledger contains duplicate paths");
  }
  if (paths.join("\n") !== trackedPaths.join("\n")) {
    const missing = trackedPaths.filter((path) => !paths.includes(path));
    const stale = paths.filter((path) => !trackedPaths.includes(path));
    throw new Error(
      `retained JS/MJS ledger mismatch; missing=${missing.join(",") || "none"}; stale=${stale.join(",") || "none"}`
    );
  }
}

function assertProviderCaptureIntegrity(entries: BoundaryEntry[]): void {
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const path of PROVIDER_CAPTURE_BOUNDARIES) {
    const entry = entriesByPath.get(path);
    if (!entry || typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`provider-captured boundary needs a SHA-256 digest: ${path}`);
    }
    const actual = createHash("sha256")
      .update(readFileSync(join(ROOT, path)))
      .digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(`provider-captured boundary digest drift: ${path}`);
    }
  }
  const unexpected = entries.filter(
    (entry) => entry.sha256 !== undefined && !PROVIDER_CAPTURE_BOUNDARIES.has(entry.path)
  );
  if (unexpected.length > 0) {
    throw new Error(
      `SHA-256 is only supported for provider captures: ${unexpected.map((entry) => entry.path).join(",")}`
    );
  }
}

function assertGeneratedWrapperParity(): void {
  for (const [path, wrapper] of Object.entries(GENERATED_WRAPPERS)) {
    const directory = path.slice(0, path.lastIndexOf("/"));
    const expected = `${wrapper.header} Source: ${wrapper.source}\nawait import("./${wrapper.source}");\n`;
    const actual = readFileSync(join(ROOT, path), "utf8");
    if (actual !== expected) {
      throw new Error(`generated MJS wrapper drift: ${path}`);
    }
    if (!existsSync(join(ROOT, directory, wrapper.source))) {
      throw new Error(`generated MJS wrapper source is missing: ${path} -> ${wrapper.source}`);
    }
    execFileSync(process.execPath, ["--check", join(ROOT, path)], { stdio: "inherit" });
  }
}

function assertGeneratedWrapperExecution(): void {
  execFileSync(
    process.execPath,
    [
      "--test",
      "--import",
      "tsx",
      ...Object.keys(GENERATED_WRAPPERS).filter(
        (path) => path.includes("/quality-ratchet/") || path.includes("/requeue-quarantined-detail-gaps.")
      ),
      "reference-implementation/test/connector-instance-delete-upsert-two-process-race.test.ts",
      "reference-implementation/test/connector-summary-evidence-engine-two-process-interleaving.test.ts",
      "scripts/ri-suite/completion-oracle.test.ts",
    ],
    { cwd: ROOT, stdio: "inherit" }
  );
}

function assertMjsBoundaryKinds(trackedPaths: string[]): void {
  const trackedMjs = trackedPaths.filter((path) => path.endsWith(".mjs"));
  const knownMjs = new Set([...HOST_MJS_BOUNDARIES, ...Object.keys(GENERATED_WRAPPERS)]);
  const unclassified = trackedMjs.filter((path) => !knownMjs.has(path));
  const absent = [...knownMjs].filter((path) => !trackedMjs.includes(path));
  if (unclassified.length || absent.length) {
    throw new Error(
      `MJS boundary classification mismatch; unclassified=${unclassified.join(",") || "none"}; absent=${absent.join(",") || "none"}`
    );
  }
}

function assertGeneratorAndFixtureProbes(): void {
  execFileSync("pnpm", ["generated-artifacts:check"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("pnpm", ["--dir", "apps/site", "exec", "fumadocs-mdx"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("git", ["diff", "--exit-code", "--", "apps/site/.source/source.config.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  execFileSync(
    "pnpm",
    [
      "--dir",
      "packages/polyfill-connectors",
      "exec",
      "node",
      "--test",
      "--import",
      "tsx",
      "connectors/twitter_archive/parsers.test.ts",
    ],
    { cwd: ROOT, stdio: "inherit" }
  );
}

function main(): void {
  const ledger = readLedger();
  for (const entry of ledger.entries) {
    assertEntry(entry);
  }
  const trackedPaths = trackedJavaScriptPaths();
  assertExactInventory(ledger.entries, trackedPaths);
  assertMjsBoundaryKinds(trackedPaths);
  assertProviderCaptureIntegrity(ledger.entries);
  assertGeneratedWrapperParity();
  if (!process.argv.includes("--static")) {
    assertGeneratedWrapperExecution();
    assertGeneratorAndFixtureProbes();
  }
  console.log(
    `retained-js-mjs: ${trackedPaths.length} tracked boundaries, ${Object.keys(GENERATED_WRAPPERS).length} generated MJS wrappers verified`
  );
}

main();
