// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";
import { RUN_AUTHORITY_SCHEMA } from "../../scripts/test-accounting/inventory.ts";
import type { StructuredSummary } from "../../scripts/test-accounting/receipt.ts";
import {
  accountingResultLine,
  assertNamedSkipMappingsFullyConsumed,
  repositoryPaths,
  riConfiguredNamedSkipMappingIdentities,
  structuredNodeSummary,
} from "../../scripts/test-accounting/receipt.ts";
import {
  dedicatedPostgresTestUrl,
  isDedicatedPostgresTestDatabaseName,
} from "../test/helpers/dedicated-postgres-test-url.ts";
import type { ProcessEnvLike } from "./test-env.ts";
import { buildScrubbedTestEnv } from "./test-env.ts";
import { storageProfileEnvironment } from "./test-profile-env.ts";

/** The `run-authority` JSON file shape accepted via `--accounting-authority`. */
interface AccountingAuthority {
  expires_at: string;
  files: string[];
  nonce: string;
  profile: string;
  run_id: string;
  schema: string;
  suite: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const testDir = join(repoRoot, "test");
const rawForwardedArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
const accountingIndex = rawForwardedArgs.indexOf("--accounting-authority");
const accountingPath = accountingIndex === -1 ? undefined : rawForwardedArgs[accountingIndex + 1];
if (accountingIndex !== -1 && !accountingPath) {
  throw new Error("--accounting-authority requires PATH");
}
const forwardedArgs =
  accountingIndex === -1
    ? rawForwardedArgs
    : rawForwardedArgs.filter((_, index) => index !== accountingIndex && index !== accountingIndex + 1);
// --test-force-exit is deliberately NOT forwarded to child test processes.
// Node's own test-runner harness stops delivering reporter events partway
// through a run once it decides to force-exit — confirmed directly: a
// reporter's `for await (const event of source)` loop completes normally
// but short by up to ~20% of expected events, non-deterministically, even
// though every test itself ran and passed. That silently truncates whatever
// structured accounting a reporter is building (skip/pass/fail counts) on a
// fully green file. Bounded termination for a genuinely hung file (a leaked
// handle after every test has already finished) is instead enforced by this
// runner's own watchdog in runNodeTest(), which lets a normal run exit on
// its own (draining reporter output completely) and only signals a child
// that fails to exit within PER_FILE_TIMEOUT_MS.
const effectiveArgs = forwardedArgs;
const PER_FILE_TIMEOUT_MS = Number.parseInt(process.env.PDPP_TEST_FILE_TIMEOUT_MS || "", 10) || 120_000;
if (!effectiveArgs.some((arg) => arg === "--test-reporter" || arg.startsWith("--test-reporter="))) {
  effectiveArgs.push(
    `--test-reporter=${fileURLToPath(new URL("../../scripts/test-accounting/node-reporter.ts", import.meta.url))}`
  );
}
if (!effectiveArgs.some((arg) => arg === "--import" || arg.startsWith("--import="))) {
  effectiveArgs.unshift("--import", "tsx");
}
// Hermetic network guard: activate for every test child so each test-owned
// server auto-grants its own bound origin and any unbound/ambient origin
// (e.g. the live production server on :7662) is fail-closed blocked. See
// scripts/hermetic/{guard,preload}.ts. On by default; set PDPP_HERMETIC_GUARD=0
// to run the suite without it (guard-absent parity). The preload is inert
// unless PDPP_HERMETIC_GUARD=1, which this runner sets in the child env below.
// tsx is registered first (above) so the `.ts` preload can be type-stripped.
const hermeticGuardEnabled = process.env.PDPP_HERMETIC_GUARD !== "0";
if (hermeticGuardEnabled) {
  effectiveArgs.push("--import", fileURLToPath(new URL("../../scripts/hermetic/preload.ts", import.meta.url)));
}
const accountingAuthority: AccountingAuthority | undefined = accountingPath
  ? JSON.parse(await readFile(accountingPath, "utf8"))
  : undefined;
if (
  accountingAuthority &&
  (accountingAuthority.schema !== RUN_AUTHORITY_SCHEMA || new Date(accountingAuthority.expires_at) < new Date())
) {
  throw new Error("accounting authority is invalid or expired");
}
if (
  accountingAuthority &&
  (accountingAuthority.suite !== "ri-default" || accountingAuthority.profile !== process.env.PDPP_TEST_PROFILE)
) {
  throw new Error("accounting authority does not bind the selected RI profile");
}
if (accountingAuthority?.profile === "postgres" && !process.env.PDPP_TEST_POSTGRES_URL) {
  throw new Error("postgres profile requires PDPP_TEST_POSTGRES_URL");
}
// biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- Biome's narrowing conflates the equality guard above (only reachable when accountingAuthority is set) with the accountingAuthority-undefined branch, where PDPP_TEST_PROFILE is genuinely string|undefined; an isolated tsc repro confirms both `??` fallbacks are real, live branches.
const selectedProfile = accountingAuthority?.profile ?? process.env.PDPP_TEST_PROFILE ?? "memory-default";
const requestedConcurrency = Number.parseInt(process.env.PDPP_TEST_CONCURRENCY || "", 10);
const scrubbedBaseEnv = storageProfileEnvironment(selectedProfile, buildScrubbedTestEnv(process.env));
const configuredPostgresTestUrl = scrubbedBaseEnv.PDPP_TEST_POSTGRES_URL;
const dedicatedBasePostgresTestUrl: string | null = configuredPostgresTestUrl
  ? dedicatedPostgresTestUrl(configuredPostgresTestUrl)
  : null;

// Validate before the runner derives its admin URL or opens a connection.
// `pg` lets query parameters override connection-string authority and path,
// so only the narrow helper contract may enter the real-Postgres lane.
if (configuredPostgresTestUrl && !dedicatedBasePostgresTestUrl) {
  throw new Error("PDPP_TEST_POSTGRES_URL must be a query- and fragment-free dedicated loopback PostgreSQL test URL");
}

// --- Per-file Postgres database isolation ---
//
// When PDPP_TEST_POSTGRES_URL is set, each test file receives its own
// ephemeral database created before spawn and dropped after exit, whether
// or not the file passes. This eliminates cross-file state pollution without
// requiring any changes to individual test files.

let fileCounter = 0;
const runnerId = randomBytes(4).toString("hex");

const WINDOWS_PATH_SEPARATOR_PATTERN = /\\/g;
const FILE_EXTENSION_SUFFIX_PATTERN = /\.[^.]+$/;
const NON_DB_IDENTIFIER_CHAR_PATTERN = /[^a-z0-9_]/gi;

/**
 * Derive the admin connection URL from a per-test URL by replacing the
 * database path segment with 'postgres' (always present on any standard PG
 * server). This gives us a stable admin connection independent of the base
 * DB name the operator chose.
 */
function adminUrlFromBase(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.pathname = "/postgres";
  return u.toString();
}

/**
 * Derive a short, safe DB name from the test file path, a per-run random ID,
 * and a monotonic counter so concurrent runners and workers never collide.
 */
function deriveDbName(filePath: string): string {
  // Strip directory and extension; keep only alphanumeric/underscore chars.
  const base = (filePath.replace(WINDOWS_PATH_SEPARATOR_PATTERN, "/").split("/").pop() ?? filePath)
    .replace(FILE_EXTENSION_SUFFIX_PATTERN, "")
    .replace(NON_DB_IDENTIFIER_CHAR_PATTERN, "_")
    .toLowerCase()
    .slice(0, 38);
  fileCounter += 1;
  const dbName = `pdpp_test_${base}_${runnerId}_${fileCounter.toString(36)}`;
  if (!isDedicatedPostgresTestDatabaseName(dbName)) {
    throw new Error(`runner derived a database name outside the dedicated test contract: ${dbName}`);
  }
  return dbName;
}

interface TestDbAllocation {
  release: () => Promise<void>;
  url: string;
}

// Per-file databases currently allocated. Tracked so that if the runner
// process itself is killed (SIGTERM/SIGINT, CI timeout) while child tests are
// in flight, their databases are dropped on the way out rather than orphaned.
const activeAllocations = new Set<TestDbAllocation>();
let signalCleanupArmed = false;

function armSignalCleanup(): void {
  if (signalCleanupArmed) {
    return;
  }
  signalCleanupArmed = true;
  const dropAll = () => {
    // Best-effort synchronous-ish drop of every live allocation; release() is
    // idempotent (DROP DATABASE IF EXISTS) so double-dropping is harmless.
    const pending = [...activeAllocations].map((a) =>
      a.release().catch(() => {
        // Best-effort teardown; the process is already exiting on a signal.
      })
    );
    return Promise.allSettled(pending);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      dropAll().finally(() => {
        process.exit(sig === "SIGINT" ? 130 : 143);
      });
    });
  }
}

/**
 * Create a fresh database and return its connection URL plus a cleanup
 * function that drops it. Never throws -- on error it logs a warning and
 * returns undefined so the caller falls back to the base URL.
 */
async function allocateTestDb(filePath: string, baseUrl: string): Promise<TestDbAllocation | undefined> {
  const dbName = deriveDbName(filePath);
  const adminUrl = adminUrlFromBase(baseUrl);
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
    // Identifier is safe: deriveDbName produces only [a-z0-9_] chars.
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${dbName}"`);
    await client.end();
  } catch (err) {
    try {
      await client.end();
    } catch {
      // Best-effort teardown after a failed connect/query.
    }
    process.stderr.write(
      `[run-tests] WARN: could not create test DB ${dbName}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return;
  }

  // Reuse the base URL structure but point at the new DB.
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${dbName}`;

  let releasePromise: Promise<void> | undefined;
  const allocation: TestDbAllocation = {
    release: () => {
      if (releasePromise) return releasePromise;
      releasePromise = (async () => {
      const drop = new pg.Client({ connectionString: adminUrl });
      try {
        await drop.connect();
        await drop.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await drop.end();
        activeAllocations.delete(allocation);
      } catch (err) {
        try {
          await drop.end();
        } catch {
          // Best-effort teardown after a failed connect/query.
        }
        throw new Error(`[run-tests] could not drop test DB ${dbName}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      })().catch((error) => {
        releasePromise = undefined;
        throw error;
      });
      return releasePromise;
    },
    url: testUrl.toString(),
  };

  // Track the live allocation and arm the runner-level signal cleanup so a
  // killed runner drops its in-flight databases instead of orphaning them.
  armSignalCleanup();
  activeAllocations.add(allocation);

  return allocation;
}

interface NodeTestResult {
  durationMs: number;
  exitCode: number;
  filePath: string;
  output: string;
}

async function runNodeTest(filePath: string, extraArgs: string[]): Promise<NodeTestResult> {
  const startedAt = Date.now();
  const baseEnv: ProcessEnvLike = scrubbedBaseEnv;
  const baseUrl = dedicatedBasePostgresTestUrl;

  // Allocate a per-file DB when a base Postgres URL is configured.
  let allocation: TestDbAllocation | undefined;
  if (baseUrl) {
    allocation = await allocateTestDb(filePath, baseUrl);
  }

  const childEnvBase: ProcessEnvLike = allocation ? { ...baseEnv, PDPP_TEST_POSTGRES_URL: allocation.url } : baseEnv;
  // Turn the preload (appended to effectiveArgs above) live in the child. Left
  // unset when the guard is disabled so the child is byte-identical to a
  // pre-guard run (guard-absent parity).
  const childEnv: ProcessEnvLike = hermeticGuardEnabled ? { ...childEnvBase, PDPP_HERMETIC_GUARD: "1" } : childEnvBase;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...extraArgs, filePath], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;

    // Watchdog: a normal run drains its reporter stream and exits on its
    // own well within this window, so the timer never fires and never
    // touches the child. It only acts on a file that is genuinely stuck
    // (e.g. a leaked handle keeping the event loop alive after every test
    // already finished) — the case --test-force-exit used to (mis)handle by
    // truncating the reporter's event stream for every run, not just hung
    // ones. SIGKILL (not SIGTERM) because a hang implies the process isn't
    // responding to its own event loop, so a graceful signal isn't reliable.
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PER_FILE_TIMEOUT_MS);
    watchdog.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(watchdog);
      if (allocation) {
        allocation.release().finally(() => reject(err));
      } else {
        reject(err);
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(watchdog);
      const finish = () => {
        if (timedOut) {
          reject(new Error(`Test process for ${filePath} timed out after ${PER_FILE_TIMEOUT_MS}ms and was killed`));
          return;
        }
        if (signal) {
          reject(new Error(`Test process for ${filePath} exited via signal ${signal}`));
          return;
        }
        resolve({
          durationMs: Date.now() - startedAt,
          exitCode: code ?? 1,
          filePath,
          output: `\n==> ${filePath}\n${output}`,
        });
      };
      if (allocation) {
        allocation.release().finally(finish);
      } else {
        finish();
      }
    });
  });
}

const entries = await readdir(testDir, { withFileTypes: true });
const NODE_TEST_EXTENSIONS = [".test.js", ".test.mjs", ".test.ts"];
const isNodeTest = (name: string) => NODE_TEST_EXTENSIONS.some((extension) => name.endsWith(extension));
const topLevelTests = entries
  .filter((entry) => entry.isFile() && isNodeTest(entry.name))
  .map((entry) => join("test", entry.name));

// Co-located unit tests for focused server modules and operator scripts. The
// discovery is intentionally narrow by directory, but extension-complete for the
// Node loader used by the supported RI CI lines, including erasable TypeScript.
const COLOCATED_TEST_DIRS = [
  { dir: join("server", "streaming"), extensions: NODE_TEST_EXTENSIONS },
  { dir: "scripts", extensions: NODE_TEST_EXTENSIONS },
];
const colocatedTests: string[] = [];
for (const { dir: relDir, extensions } of COLOCATED_TEST_DIRS) {
  const absDir = join(repoRoot, relDir);
  let dirEntries: Dirent[];
  try {
    // biome-ignore lint/performance/noAwaitInLoops: COLOCATED_TEST_DIRS is a fixed 2-entry static list read once at startup; sequential try/catch-per-dir scopes a missing directory's error to that entry alone.
    dirEntries = await readdir(absDir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of dirEntries) {
    if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      colocatedTests.push(join(relDir, entry.name));
    }
  }
}

const testFiles = [...topLevelTests, ...colocatedTests].sort();
const defaultConcurrency = Math.max(1, Math.min(2, availableParallelism?.() ?? 1, testFiles.length || 1));
const fileConcurrency =
  Number.isInteger(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : defaultConcurrency;

const queue = [...testFiles];
const results: NodeTestResult[] = [];

async function worker(): Promise<void> {
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: this IS the bounded-concurrency primitive -- fileConcurrency workers each pull one file from the shared queue, so parallelizing here would defeat the deliberate cap (Promise.all of worker() calls below).
    const result = await runNodeTest(file, effectiveArgs);
    results.push(result);
    process.stdout.write(result.output);
  }
}

await Promise.all(Array.from({ length: fileConcurrency }, () => worker()));

const selectedFiles = repositoryPaths("reference-implementation", testFiles);
if (accountingAuthority && JSON.stringify(selectedFiles) !== JSON.stringify(accountingAuthority.files)) {
  throw new Error("RI discovery differs from authority-issued child selection");
}
const summaries: StructuredSummary[] = results.map((result) => structuredNodeSummary(result.output));
const skipReasons: Record<string, number> = {};
for (const summary of summaries) {
  for (const [reason, count] of Object.entries(summary.skip_reasons)) {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + count;
  }
}
const failed = results.find((result) => result.exitCode !== 0);
const counts = {
  assertions: summaries.reduce((sum, summary) => sum + summary.assertions, 0),
  completed_files: failed ? 0 : results.length,
  failed: summaries.reduce((sum, summary) => sum + summary.failed, 0),
  passed: summaries.reduce((sum, summary) => sum + summary.passed, 0),
  planned_files: testFiles.length,
  skip_reasons: skipReasons,
  skipped: summaries.reduce((sum, summary) => sum + summary.skipped, 0),
};
// Complete-suite finalization for property 3 (exact named-mapping join): once
// every planned file has run, require the named-mapping rows CONFIGURED for
// this suite to exactly equal the identities the run CONSUMED. This is the one
// new fail-closed path; it does not touch execution order, concurrency,
// timeouts, output counts/schema, or the ordinary exit path. It is skipped
// when the suite did not run to completion (a failing file already dominates
// the exit), so it can never mask an unrelated failure or fire on a partial run.
if (!failed && results.length === testFiles.length) {
  const consumedMappingIdentities = summaries.flatMap((summary) => summary.consumed_mapping_identities);
  assertNamedSkipMappingsFullyConsumed(
    consumedMappingIdentities,
    riConfiguredNamedSkipMappingIdentities(selectedProfile)
  );
}
if (accountingAuthority) {
  process.stdout.write(
    `${accountingResultLine({ counts, files: selectedFiles, nonce: accountingAuthority.nonce, profile: accountingAuthority.profile, run_id: accountingAuthority.run_id, suite: "ri-default" })}\n`
  );
}

if (failed) {
  process.exit(failed.exitCode);
}
