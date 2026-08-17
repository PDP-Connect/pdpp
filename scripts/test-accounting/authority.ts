// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  assertCleanSourceTree,
  type Counts,
  contentDigest,
  gitHead,
  gitPath,
  gitRoot,
  type Profile,
  type ProfileEntry,
  type Receipt,
  RUN_AUTHORITY_SCHEMA,
  RUN_COMPLETION_SCHEMA,
  readManifest,
  receiptBinding,
  type Suite,
  selectedRuns,
  sourceTreeDigest,
  trackedFiles,
  treeDigest,
  unaccountedExecutableTests,
  validateIncludeGlobsClassifyExecutable,
  verifyReceipts,
} from "./inventory.ts";
import { readStructuredChildResult, structuredNodeSummary, structuredPythonSummary } from "./receipt.ts";

const AUTHORITY_TTL_MS = 2 * 60 * 60 * 1000;
const OPTIONAL_PREDICATE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
function fail(message: string): never {
  throw new Error(`test accounting authority: ${message}`);
}
function instant(value: number): string {
  return new Date(value).toISOString();
}

interface AuthorityArgs {
  base?: string;
  profile?: string;
  run?: boolean;
  suites: string[];
}

function parseArgs(argv: string[]): AuthorityArgs {
  const value: AuthorityArgs = { suites: [] };
  const take = (index: number, flag: string): string => {
    const item = argv[index + 1];
    if (!item || item.startsWith("--")) {
      fail(`${flag} requires exactly one value`);
    }
    return item;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run") {
      if (value.run) {
        fail("--run may appear only once");
      }
      value.run = true;
    } else if (arg === "--suite") {
      value.suites.push(take(index, arg));
      index += 1;
    } else if (arg === "--profile") {
      value.profile = take(index, arg);
      index += 1;
    } else if (arg === "--base") {
      value.base = take(index, arg);
      index += 1;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!value.run) {
    fail("use --run");
  }
  if (
    new Set(value.suites).size !== value.suites.length ||
    (value.suites.includes("all") && value.suites.length !== 1)
  ) {
    fail("suite selection must be unique and cannot combine all with other suites");
  }
  return value;
}

async function writeNew(path: string, value: unknown): Promise<void> {
  const fd = await open(path, "wx");
  try {
    await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

interface CaptureResult {
  exit_code: number;
  signal: string | null;
  stderr: string;
  stdout: string;
}
interface TranscriptHandle {
  write: (chunk: string) => Promise<unknown>;
}

// How long a leaf may produce NO output at all before it is declared wedged.
//
// This is a STALL budget, not a duration budget: it bounds silence, never total
// runtime. A leaf that keeps emitting output is never killed no matter how long
// it takes, so a legitimately slow suite cannot be starved by a wall-clock cap
// that a future, larger suite would outgrow.
//
// The value is derived from the slowest measured gap between consecutive output
// chunks on the real `--suite all` run, not chosen for roundness. ri-default is
// the worst case: its RI runner buffers each test file's whole output and
// flushes it only when that file completes (reference-implementation/scripts/
// run-tests.ts worker()), so the observable output gap equals the slowest single
// file. The slowest measured file is test/collection-profile.test.ts at ~23s,
// and that runner independently SIGKILLs any file exceeding its own
// PER_FILE_TIMEOUT_MS (120s default), which is the true ceiling on ri-default
// silence. 300s therefore clears the enforced per-file ceiling by 2.5x, leaving
// room for a loaded machine to stretch a 120s-bounded file without ever making
// this budget the thing that fires first on a healthy run.
const LEAF_STALL_BUDGET_MS = Number.parseInt(process.env.PDPP_ACCOUNTING_STALL_BUDGET_MS || "", 10) || 300_000;
// How often the watchdog re-checks for silence, and the cadence of the heartbeat
// line printed while a leaf is quiet. Short enough that an operator sees the run
// is alive within seconds of starting it, long enough to add no measurable cost.
const PROGRESS_TICK_MS = 5000;

/**
 * Emit an operator-facing progress line.
 *
 * Deliberately writes to the authority's OWN stderr and nowhere else. The
 * transcript is a digest-verified accounting artifact (verifyTranscript hashes
 * the file and requires `start` first / `end` last), and the child's stdout is
 * parsed for the structured accounting result and event lines, so progress must
 * never enter either. stderr of the authority process is not captured, not
 * hashed, and not parsed by anything — it is the one channel where progress is
 * free of accounting consequences.
 */
function reportProgress(text: string): void {
  process.stderr.write(`[test-accounting] ${text}\n`);
}

function capture(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  transcript: TranscriptHandle,
  start: { run_id: string; suite: string; profile: string; files: string[] }
): Promise<CaptureResult> {
  return new Promise((resolveResult, reject) => {
    const [file, ...rest] = command;
    if (!file) {
      reject(new Error("capture requires a non-empty command"));
      return;
    }
    const label = `${start.suite}/${start.profile}`;
    const startedAt = Date.now();
    reportProgress(`${label}: started (${start.files.length} files)`);
    const child = spawn(file, rest, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let lastOutputAt = Date.now();
    let stalled = false;
    const writes: Promise<unknown>[] = [];
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      if (stream === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      // Progress is measured as output ARRIVING, which is what distinguishes a
      // slow-but-live leaf from a wedged one. Only the clock and a byte counter
      // move here; the captured text and the transcript record are untouched.
      bytes += chunk.length;
      lastOutputAt = Date.now();
      writes.push(transcript.write(`${JSON.stringify({ event: stream, run_id: start.run_id, chunk: text })}\n`));
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));

    // Watchdog + heartbeat share one timer: every tick reports liveness, and a
    // tick that finds the silence older than the declared budget kills the leaf
    // and says so. A leaf that keeps producing output resets `lastOutputAt` and
    // is never killed, however long it runs.
    const ticker = setInterval(() => {
      const quietMs = Date.now() - lastOutputAt;
      if (quietMs >= LEAF_STALL_BUDGET_MS) {
        stalled = true;
        clearInterval(ticker);
        reportProgress(
          `${label}: STALLED — no output for ${Math.round(quietMs / 1000)}s (budget ${Math.round(LEAF_STALL_BUDGET_MS / 1000)}s); killing`
        );
        child.kill("SIGKILL");
        return;
      }
      reportProgress(
        `${label}: running ${Math.round((Date.now() - startedAt) / 1000)}s, ${bytes} bytes, quiet ${Math.round(quietMs / 1000)}s`
      );
    }, PROGRESS_TICK_MS);
    ticker.unref?.();

    child.on("error", (error) => {
      clearInterval(ticker);
      reject(error);
    });
    child.on("exit", async (code, signal) => {
      clearInterval(ticker);
      await Promise.all(writes);
      if (stalled) {
        reject(
          new Error(
            `${label} produced no output for ${Math.round(LEAF_STALL_BUDGET_MS / 1000)}s (stall budget PDPP_ACCOUNTING_STALL_BUDGET_MS) and was killed`
          )
        );
        return;
      }
      reportProgress(
        `${label}: exit ${code ?? "null"}${signal ? ` (signal ${signal})` : ""} after ${Math.round((Date.now() - startedAt) / 1000)}s`
      );
      resolveResult({ exit_code: code ?? 1, signal: signal ?? null, stdout, stderr });
    });
  });
}
/**
 * Test seam over the real `capture` above — same spawn, same append, same
 * watchdog, with the transcript replaced by a sink so a behavioral test can
 * exercise stall-vs-progress discrimination without issuing a receipt. Kept
 * deliberately thin: it adds no logic of its own, so a test through this seam
 * fails exactly when `capture` regresses.
 */
export function runCaptureForTest(command: string[], cwd: string): Promise<CaptureResult> {
  return capture(
    command,
    cwd,
    process.env,
    { write: () => Promise.resolve() },
    { run_id: "test", suite: "fixture", profile: "fixture", files: [] }
  );
}

/**
 * Materialize a suite's declared generated prerequisites before its children run.
 *
 * Some suites import build artifacts that are gitignored on purpose (e.g. the
 * site's `src/generated/spec-front-matter.ts`, assembled from the normative root
 * spec by apps/site/scripts/sync-spec-docs.mjs). `predev`/`prebuild` build those
 * for the dev and build paths, but the accounting runner spawns the test child
 * directly and so never triggered them — the artifact was simply absent and the
 * import failed closed.
 *
 * Runs with the suite's own cwd and environment so a prepare command sees exactly
 * what its children will see. Failure is fatal and attributed to the suite: a
 * prerequisite that cannot be built must never look like a passing test run.
 * The caller re-asserts a clean source tree afterwards, so a prepare command that
 * writes a TRACKED file is still caught by the existing clean-tree gate.
 */
function prepareSuite(suite: Suite, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const command = suite.prepare;
  if (!command) {
    return Promise.resolve();
  }
  const [file, ...rest] = command;
  if (!file) {
    return Promise.reject(new Error(`${suite.id} prepare command is empty`));
  }
  reportProgress(`${suite.id}: preparing (${command.join(" ")})`);
  return new Promise((resolvePrepare, reject) => {
    const child = spawn(file, rest, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 && !signal) {
        resolvePrepare();
        return;
      }
      reject(
        new Error(
          `${suite.id} prepare failed (exit ${code ?? "null"}${signal ? `, signal ${signal}` : ""}): ${output.trim()}`
        )
      );
    });
  });
}

/**
 * Test seam over the real `prepareSuite` above — same spawn, same env
 * composition, same failure attribution. Kept deliberately thin so a test
 * through this seam fails exactly when `prepareSuite` regresses.
 */
export function runPrepareForTest(suite: Suite, root: string): Promise<void> {
  return prepareSuite(suite, resolve(root, suite.cwd), {
    ...process.env,
    ...(suite.environment ?? {}),
  });
}

function requiredByDefault(entry: ProfileEntry): boolean {
  return typeof entry === "string" || entry.required !== false;
}
function authorityDirectory(root: string): string {
  return resolve(gitPath("test-accounting", root), "runs");
}
function assertChildResult(
  result: unknown,
  issued: { run_id: string; nonce: string; suite: string; profile: string; files: string[] }
): Counts {
  const value = result as {
    run_id?: string;
    nonce?: string;
    suite?: string;
    profile?: string;
    files?: string[];
    counts?: Counts;
  } | null;
  if (
    !value ||
    value.run_id !== issued.run_id ||
    value.nonce !== issued.nonce ||
    value.suite !== issued.suite ||
    value.profile !== issued.profile
  ) {
    fail(`${issued.suite}/${issued.profile} child did not return its issued authority`);
  }
  if (JSON.stringify(value.files) !== JSON.stringify(issued.files)) {
    fail(`${issued.suite}/${issued.profile} child changed its issued selection`);
  }
  if (!value.counts || typeof value.counts !== "object") {
    fail(`${issued.suite}/${issued.profile} child omitted structured counts`);
  }
  return value.counts;
}
// Node resolves a bare relative --test-reporter value (no leading ./) as a
// package specifier, not a file path, and fails closed. execute.mjs used to
// paper over this by always resolving the reporter to an absolute path
// before spawning; direct leaves must do the same since they run from an
// arbitrary suite cwd, not necessarily the repo root.
function resolveReporterArgument(command: string[], root: string): string[] {
  const resolved = [...command];
  const index = resolved.indexOf("--test-reporter");
  const argument = resolved[index + 1];
  if (index !== -1 && argument) {
    resolved[index + 1] = resolve(root, argument);
  }
  return resolved;
}
export function applyLocalNodeTestConcurrency(command: string[], isCi = Boolean(process.env.CI)): string[] {
  if (
    isCi ||
    command[0] !== "node" ||
    !command.includes("--test") ||
    command.some((argument) => argument === "--test-concurrency" || argument.startsWith("--test-concurrency="))
  ) {
    return command;
  }
  const testIndex = command.indexOf("--test");
  const bounded = [...command];
  bounded.splice(testIndex + 1, 0, "--test-concurrency=2");
  return bounded;
}
interface Run {
  files: string[];
  profile: Profile;
  suite: Suite;
}
export function suiteEnvironment(inherited: NodeJS.ProcessEnv, profile: string, suite: Suite): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...inherited, PDPP_TEST_PROFILE: profile, ...(suite.environment ?? {}) };
  for (const name of suite.environment_unset ?? []) {
    delete environment[name];
  }
  return environment;
}
function leafCommand(run: Run, authorityPath: string, issuedArgv: string[]): string[] | null {
  if (run.suite.zero_tests) {
    return null;
  }
  const command = [...issuedArgv];
  if (run.suite.authority_argument) {
    command.push(run.suite.authority_argument, authorityPath);
  }
  if (run.suite.execution === "direct") {
    command.push(...run.files);
  }
  return command;
}
export function assertIssuedArgvMatchesCommand(issuedArgv: string[], command: string[] | null): void {
  if (command && JSON.stringify(command.slice(0, issuedArgv.length)) !== JSON.stringify(issuedArgv)) {
    fail("executed command differs from the argv bound into its authority and receipt");
  }
}
function observedCounts(
  run: Run,
  observed: CaptureResult,
  issued: { run_id: string; nonce: string; suite: string; profile: string; files: string[] }
): Counts {
  if (run.suite.zero_tests) {
    return {
      assertions: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      skip_reasons: {},
      planned_files: 0,
      completed_files: 0,
      zero_test_declaration: true,
    };
  }
  if (run.suite.execution === "authority-runner") {
    return assertChildResult(readStructuredChildResult(observed.stdout), issued);
  }
  let counts: Counts;
  if (run.suite.loader === "node-test") {
    counts = structuredNodeSummary(observed.stdout);
  } else if (run.suite.loader === "python-unittest") {
    counts = structuredPythonSummary(observed.stdout + observed.stderr, observed.exit_code);
  } else {
    counts = {
      assertions: issued.files.length,
      passed: observed.exit_code === 0 ? issued.files.length : 0,
      failed: observed.exit_code === 0 ? 0 : 1,
      skipped: 0,
      skip_reasons: {},
    };
  }
  return {
    ...counts,
    planned_files: issued.files.length,
    completed_files: observed.exit_code === 0 ? issued.files.length : 0,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the authority run loop's real invariant chain (issue -> spawn -> transcript -> verify-clean-tree -> receipt), pre-existing structure carried over from the .mjs source, not introduced by this migration.
export async function runAuthority({
  root = gitRoot(),
  suites = [],
  profile,
  base,
  env = process.env,
}: {
  root?: string;
  suites?: string[];
  profile?: string | undefined;
  base?: string | undefined;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const manifest = await readManifest(resolve(root, "test-accounting.manifest.json"), { root, intendedBase: base });
  const files = trackedFiles(root);
  // Fail closed BEFORE selection — this is the fix for the gap the R1
  // remeasure found: the closure oracle existed but nothing on the real
  // `--run` path ever called it, so a silent discovery shrink shipped
  // straight into a live test run with zero error anywhere in CI.
  //
  // Two checks, deliberately different scopes:
  //
  // 1. `validateIncludeGlobsClassifyExecutable`, scoped to the suites this
  //    run actually selects (mirrors `verifyReceipts`'s scoping, see
  //    `965708787`): a suite's include glob that still matches at least
  //    one tracked file (so `planFor`'s own "selects no executable tests"
  //    guard stays silent) can still match a file that no longer
  //    classifies as executable, or a suite's entire include list can go
  //    empty. Scoping this to `suites` means an unrelated suite's stale,
  //    deliberately-empty include glob elsewhere in the manifest cannot
  //    fail a run that never touches it.
  //
  // 2. `unaccountedExecutableTests`, necessarily whole-manifest (ownership
  //    is a global property — a file renamed off the one glob that used to
  //    match it, e.g. mcp-server's `.test.ts` -> `.test.js`, simply stops
  //    being matched by anything; no suite-scoped check can see a file
  //    that fell out of its own suite's purview entirely). This is the
  //    check that closes the N -> N-1 multi-glob partial-rename hole:
  //    `validateIncludeGlobsClassifyExecutable` alone does not catch it
  //    (the file is still executable-classified, just unmatched), and
  //    `planFor`'s per-suite empty-plan guard does not catch it either
  //    (the suite's other globs keep its plan non-empty). It never throws
  //    on an unrelated suite's empty plan, only on a genuinely orphaned
  //    executable file, so it is safe to run unconditionally regardless of
  //    which suites were selected.
  validateIncludeGlobsClassifyExecutable(manifest, files, suites);
  const unaccounted = unaccountedExecutableTests(manifest, files);
  if (unaccounted.length) {
    fail(`unaccounted executable tests: ${unaccounted.join(", ")}`);
  }
  const selection = selectedRuns(manifest, files, { suites, profile });
  if (profile) {
    for (const run of selection.runs) {
      const entry = typeof run.profile === "string" ? { id: run.profile } : run.profile;
      const match = OPTIONAL_PREDICATE_PATTERN.exec(entry.optional_predicate ?? "");
      if (entry.required === false && (!match || env[match[1] ?? ""] !== match[2])) {
        fail(`${run.suite.id}/${entry.id} requires its optional environment predicate`);
      }
    }
  }
  // Reject a disabled optional profile before inspecting mutable source state.
  // No child command has been spawned at this point.
  assertCleanSourceTree(root);
  const head = gitHead(root);
  const runs: Run[] = selection.runs
    .filter((run) => profile || requiredByDefault(run.profile))
    .map((run) => ({
      suite: run.suite,
      profile: typeof run.profile === "string" ? { id: run.profile } : run.profile,
      files: run.files,
    }));
  if (runs.length === 0) {
    fail("no required suite/profile runs were selected");
  }
  const directory = authorityDirectory(root);
  await mkdir(directory, { recursive: true });
  const sourceTree = sourceTreeDigest(root, head);
  const manifestHash = contentDigest(await readFile(resolve(root, "test-accounting.manifest.json")));
  const receipts: Receipt[] = [];
  reportProgress(`${runs.length} suite/profile runs selected`);
  let runIndex = 0;
  for (const run of runs) {
    runIndex += 1;
    reportProgress(`[${runIndex}/${runs.length}] ${run.suite.id}/${run.profile.id ?? ""}`);
    const runId = randomUUID();
    const nonce = randomUUID();
    const issuedAt = instant(Date.now());
    const expiresAt = instant(Date.now() + AUTHORITY_TTL_MS);
    const profileId = run.profile.id ?? "";
    const effectiveCommand = applyLocalNodeTestConcurrency(
      resolveReporterArgument(run.suite.command ?? [], root),
      Boolean(process.env.CI)
    );
    const issued = {
      schema: RUN_AUTHORITY_SCHEMA,
      run_id: runId,
      nonce,
      issued_at: issuedAt,
      expires_at: expiresAt,
      suite: run.suite.id,
      profile: profileId,
      files: run.files,
      cwd: run.suite.cwd,
      argv: effectiveCommand,
      base_sha: manifest.inventory_base_sha,
      head_sha: head,
      source_tree_sha256: sourceTree,
      selection_tree_sha256: treeDigest(root, head, run.files),
      manifest_sha256: manifestHash,
    };
    const authorityPath = resolve(directory, `${runId}.authority.json`);
    // biome-ignore lint/performance/noAwaitInLoops: runs must execute sequentially — each captures its own transcript and asserts a clean source tree before the next run starts.
    await writeNew(authorityPath, issued);
    const transcriptPath = resolve(directory, `${runId}.transcript`);
    const transcript = await open(transcriptPath, "wx");
    const startedAt = instant(Date.now());
    await transcript.write(
      `${JSON.stringify({ event: "start", run_id: runId, nonce, started_at: startedAt, suite: issued.suite, profile: issued.profile, files: issued.files, cwd: issued.cwd, argv: issued.argv })}\n`
    );
    const command = leafCommand(run, authorityPath, issued.argv);
    assertIssuedArgvMatchesCommand(issued.argv, command);
    // Keep the effective environment and cwd explicit so the issued command,
    // transcript, and child process all describe the same execution context.
    // One environment and cwd for both the prepare step and the children, so a
    // prerequisite is always built under the same resolver config that will load it.
    const suiteCwd = resolve(root, run.suite.cwd);
    const suiteEnv = suiteEnvironment(env, profileId, run.suite);
    let observed: CaptureResult;
    try {
      await prepareSuite(run.suite, suiteCwd, suiteEnv);
      observed = command
        ? await capture(command, suiteCwd, suiteEnv, transcript, issued)
        : { exit_code: 0, signal: null, stdout: "", stderr: "" };
      if (!command) {
        reportProgress(`${issued.suite}/${issued.profile}: zero-test declaration, nothing spawned`);
      }
    } catch (error) {
      await transcript.close();
      throw error;
    }
    const endedAt = instant(Date.now());
    await transcript.write(
      `${JSON.stringify({ event: "end", run_id: runId, nonce, ended_at: endedAt, exit_code: observed.exit_code, signal: observed.signal })}\n`
    );
    await transcript.sync();
    await transcript.close();
    assertCleanSourceTree(root);
    if (sourceTreeDigest(root, head) !== sourceTree) {
      fail(`${issued.suite}/${issued.profile} changed the full source tree during execution`);
    }
    let counts: Counts;
    try {
      counts = observedCounts(run, observed, issued);
    } catch (error) {
      const err = error as Error;
      counts = {
        assertions: 0,
        passed: 0,
        failed: 1,
        skipped: 0,
        skip_reasons: {},
        planned_files: issued.files.length,
        completed_files: 0,
        protocol_error: err.message,
      };
      observed.exit_code ||= 1;
    }
    const transcriptRelative = relative(directory, transcriptPath);
    const completion = {
      schema: RUN_COMPLETION_SCHEMA,
      run_id: runId,
      nonce,
      observed: {
        exit_code: observed.exit_code,
        signal: observed.signal,
        transcript: transcriptRelative,
        transcript_sha256: contentDigest(await readFile(transcriptPath)),
        counts,
        files: issued.files,
      },
    };
    const completionPath = resolve(directory, `${runId}.completion.json`);
    await writeNew(completionPath, completion);
    const receipt: Receipt = {
      schema: "pdpp.test-receipt/v3",
      run_id: runId,
      nonce,
      suite: issued.suite,
      profile: issued.profile,
      issued_at: issued.issued_at,
      started_at: startedAt,
      ended_at: endedAt,
      expires_at: issued.expires_at,
      base_sha: issued.base_sha,
      head_sha: issued.head_sha,
      source_tree_sha256: issued.source_tree_sha256,
      selection_tree_sha256: issued.selection_tree_sha256,
      manifest_sha256: issued.manifest_sha256,
      cwd: issued.cwd,
      argv: issued.argv,
      files: issued.files,
      transcript: transcriptRelative,
      transcript_sha256: completion.observed.transcript_sha256,
      exit_code: observed.exit_code,
      signal: observed.signal,
      counts,
      authority_sha256: contentDigest(await readFile(authorityPath)),
      completion_sha256: contentDigest(await readFile(completionPath)),
      binding_sha256: "",
    };
    receipt.binding_sha256 = receiptBinding(receipt);
    await writeNew(resolve(directory, `${runId}.receipt.json`), receipt);
    receipts.push(receipt);
  }
  return {
    directory,
    result: await verifyReceipts(manifest, files, receipts, {
      root,
      head,
      authorityDirectory: directory,
      sourceTree,
      requiredKeys: runs.map((run) => `${run.suite.id}/${run.profile.id}`),
    }),
  };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const result = await runAuthority({ suites: input.suites, profile: input.profile, base: input.base });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
