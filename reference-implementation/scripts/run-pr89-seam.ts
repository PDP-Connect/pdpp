// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_ROOT,
  EVIDENCE_ROOT,
  fileSetDigest,
  generateReceipt,
  parseCaseOutput,
  RECEIPT_PATH,
  REPOSITORY_ROOT,
  verifyReceipt,
} from "./check-pr89-seam-receipt.ts";
import {
  CASE_DEFINITIONS,
  CASE_EVIDENCE_SCHEMA,
  CASE_EXECUTION_ORDER,
  CASE_OUTPUT_SCHEMA,
  type CaseEvidence,
  type CaseId,
  type CaseOutput,
  canonicalJson,
  digest,
  exactSortedValues,
  type Json,
} from "./pr89-seam-evidence-contract.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CASE_OUTPUT_ROOT = resolve(ARTIFACT_ROOT, "case-outputs");
const REPORTER_PATH = resolve(REPOSITORY_ROOT, "scripts/test-accounting/node-reporter.ts");
const EVENT_PREFIX = "PDPP_TEST_ACCOUNTING_EVENT ";
const MAX_FAILURE_OUTPUT_LENGTH = 8000;

interface ReporterEvent {
  details?: {
    name?: string;
    skip?: boolean | string;
    type?: string;
  };
  type?: string;
}

interface ChildResult {
  exitCode: number;
  output: string;
  signal: NodeJS.Signals | null;
}

function fail(message: string): never {
  throw new Error(`PR89 seam: ${message}`);
}

function parseBackend(argv: string[]): "postgresql" {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length !== 2 || args[0] !== "--backend" || args[1] !== "postgresql") {
    fail("use exactly --backend postgresql");
  }
  return "postgresql";
}

function requirePostgresUrl(value: string | undefined): string {
  if (!value) {
    fail("PDPP_TEST_POSTGRES_URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("PDPP_TEST_POSTGRES_URL must be a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    fail("PDPP_TEST_POSTGRES_URL must use PostgreSQL");
  }
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname === "/"
  ) {
    fail("PDPP_TEST_POSTGRES_URL must name a query-free loopback test database");
  }
  return value;
}

function stableCommand(caseId: CaseId): string[] {
  return [
    "node",
    "--test",
    "--import",
    "tsx",
    "--test-reporter",
    "scripts/test-accounting/node-reporter.ts",
    CASE_DEFINITIONS[caseId].testFile,
  ];
}

function runtimeCommand(caseId: CaseId): string[] {
  return [
    "--test",
    "--import",
    "tsx",
    "--test-reporter",
    REPORTER_PATH,
    resolve(REPOSITORY_ROOT, CASE_DEFINITIONS[caseId].testFile),
  ];
}

function runChild(caseId: CaseId, postgresUrl: string, caseOutputPath: string): Promise<ChildResult> {
  const definition = CASE_DEFINITIONS[caseId];
  // Boot-time schedule auto-enrollment stays OFF for seam cases, for the same
  // reason it is off under the main test runner: a case that seeds a connection
  // and calls `startServer` gets a live schedule it never asked for, and the
  // scheduler's interval timer holds the event loop open after the case has
  // finished every assertion. `pr89-case-2` closes both servers in a `finally`
  // but never stops the scheduler, so the child process hangs and the job is
  // cancelled at its timeout with the cases already green.
  //
  // This seam runs through `run-command.ts`, NOT `scripts/run-tests.ts`, so it
  // does not inherit that runner's default and has to set the same opt-out here.
  const env: NodeJS.ProcessEnv = {
    PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT: "1",
    ...process.env,
    PDPP_TEST_POSTGRES_URL: postgresUrl,
  };
  if (definition.outputRequired) {
    env.PDPP_PR89_CASE_OUTPUT_PATH = caseOutputPath;
  } else {
    env.PDPP_PR89_CASE_OUTPUT_PATH = undefined;
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, runtimeCommand(caseId), {
      cwd: REPOSITORY_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolveResult({ exitCode: code ?? 1, output, signal });
    });
  });
}

function terminalEvents(caseId: CaseId, result: ChildResult): Array<{ name: string; status: "pass" }> {
  const events: ReporterEvent[] = result.output
    .split("\n")
    .filter((line) => line.startsWith(EVENT_PREFIX))
    .map((line) => {
      try {
        return JSON.parse(line.slice(EVENT_PREFIX.length)) as ReporterEvent;
      } catch {
        return fail(`${caseId} reporter emitted malformed structured JSON`);
      }
    });
  if (result.exitCode !== 0 || result.signal) {
    const tail = result.output.slice(-MAX_FAILURE_OUTPUT_LENGTH);
    fail(`${caseId} execution failed with exit ${result.exitCode}, signal ${result.signal ?? "none"}\n${tail}`);
  }
  const tests = events.filter((event) => event.details?.type === "test");
  if (tests.length === 0) {
    fail(`${caseId} emitted no structured test events`);
  }
  for (const event of tests) {
    if (event.type !== "test:pass" || event.details?.skip !== undefined) {
      fail(`${caseId} has a failed or skipped test: ${event.details?.name ?? "unnamed"}`);
    }
  }
  const names = tests.map((event) => event.details?.name).filter((name): name is string => Boolean(name));
  if (names.length !== tests.length || new Set(names).size !== names.length) {
    fail(`${caseId} test names must be present and unique`);
  }
  for (const requiredName of CASE_DEFINITIONS[caseId].requiredTestNames) {
    if (!names.includes(requiredName)) {
      fail(`${caseId} did not execute required test: ${requiredName}`);
    }
  }
  return exactSortedValues(names).map((name) => ({ name, status: "pass" }));
}

async function readCaseOutput(caseId: CaseId, path: string): Promise<CaseOutput> {
  const definition = CASE_DEFINITIONS[caseId];
  if (!definition.outputRequired) {
    return {
      case_id: caseId,
      observations: exactSortedValues(definition.observations),
      oracle_code: definition.oracleCode,
      response_envelopes: [],
      schema: CASE_OUTPUT_SCHEMA,
    };
  }
  if (!existsSync(path)) {
    fail(`${caseId} did not write PDPP_PR89_CASE_OUTPUT_PATH`);
  }
  const raw = (await readFile(path, "utf8")).trim();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail(`${caseId} output is not valid JSON`);
  }
  const parsed = parseCaseOutput(value, caseId, definition);
  if (raw !== canonicalJson(parsed as unknown as Json)) {
    fail(`${caseId} output must use canonical lexicographic JSON key ordering`);
  }
  return parsed;
}

async function executeCase(caseId: CaseId, postgresUrl: string): Promise<void> {
  const definition = CASE_DEFINITIONS[caseId];
  const caseOutputPath = resolve(CASE_OUTPUT_ROOT, `${caseId}.json`);
  await rm(caseOutputPath, { force: true });
  const result = await runChild(caseId, postgresUrl, caseOutputPath);
  const events = terminalEvents(caseId, result);
  const output = await readCaseOutput(caseId, caseOutputPath);
  const evidence: CaseEvidence = {
    backend: "postgresql",
    case_id: caseId,
    case_output: output,
    case_output_digest: digest(canonicalJson(output as unknown as Json)),
    command: stableCommand(caseId),
    fixtures_digest: await fileSetDigest(REPOSITORY_ROOT, definition.fixturePaths),
    implementation_inputs_digest: await fileSetDigest(REPOSITORY_ROOT, definition.implementationInputPaths),
    oracle_code: definition.oracleCode,
    schema: CASE_EVIDENCE_SCHEMA,
    status: "pass",
    terminal_events: events,
    terminal_events_digest: digest(canonicalJson(events)),
    test_file_digest: await fileSetDigest(REPOSITORY_ROOT, [definition.testFile]),
  };
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  await writeFile(resolve(EVIDENCE_ROOT, `${caseId}.json`), `${canonicalJson(evidence as unknown as Json)}\n`, "utf8");
  process.stdout.write(`${caseId}: ${events.length} structured tests passed\n`);
}

function missingInputs(caseId: CaseId): string[] {
  const definition = CASE_DEFINITIONS[caseId];
  return [definition.testFile, ...definition.fixturePaths, ...definition.implementationInputPaths].filter(
    (path) => !existsSync(resolve(REPOSITORY_ROOT, path))
  );
}

export async function runSeam(argv = process.argv.slice(2)): Promise<void> {
  parseBackend(argv);
  const postgresUrl = requirePostgresUrl(process.env.PDPP_TEST_POSTGRES_URL);
  await rm(EVIDENCE_ROOT, { force: true, recursive: true });
  await rm(CASE_OUTPUT_ROOT, { force: true, recursive: true });
  await rm(RECEIPT_PATH, { force: true });
  await mkdir(CASE_OUTPUT_ROOT, { recursive: true });
  const missing = new Map<CaseId, string[]>();
  for (const caseId of CASE_EXECUTION_ORDER) {
    const absent = missingInputs(caseId);
    if (absent.length > 0) {
      missing.set(caseId, absent);
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Cases share one PostgreSQL database and must not overlap.
    await executeCase(caseId, postgresUrl);
  }
  if (missing.size > 0) {
    const details = [...missing.entries()].map(([caseId, paths]) => `${caseId}: ${paths.join(", ")}`).join("\n");
    fail(`receipt generation requires all seven executed cases; missing inputs:\n${details}`);
  }
  await generateReceipt();
  await verifyReceipt();
  process.stdout.write(`PR89 seam receipt written to ${RECEIPT_PATH}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await runSeam();
}
