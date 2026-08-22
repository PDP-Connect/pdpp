// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Strict scenario validation, run BEFORE anything is spawned.
 *
 * `validateScenario` is the trust gate format.ts's module doc promises:
 * format/capture/runs shape, `state_from_run` reference safety, interaction
 * sequencing, request/response shape, and expectation-length consistency.
 * A scenario failing any of these checks must never reach a subprocess —
 * every check here is pure (no filesystem, no network, no subprocess) so it
 * can run in milliseconds against a scenario already parsed into memory.
 *
 * `computeDeclarationDigest`/`computeSourceDigest` are exported from here
 * (rather than from bin/scenario-verify.ts, which calls them) so the
 * scenario-record side (a different lane) can import the SAME digest
 * functions scenario-verify recomputes against — a scenario's
 * `declaration_digest`/`source_digest` is only meaningful if both sides
 * compute it identically.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ConnectorScenario, ScenarioInteraction, ScenarioRun, ScenarioUserInteraction } from "./format.ts";
import { SCENARIO_FORMAT } from "./format.ts";

const FIXTURE_DIR_NAME_RE = /^(__)?fixtures(__)?$/i;

export class ScenarioValidationError extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`scenario validation failed: ${reason} — ${detail}`);
    this.name = "ScenarioValidationError";
    this.reason = reason;
  }
}

function fail(reason: string, detail: string): never {
  throw new ScenarioValidationError(reason, detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFormat(scenario: ConnectorScenario): void {
  if (scenario.format !== SCENARIO_FORMAT) {
    fail(
      "unsupported_format",
      `expected format ${JSON.stringify(SCENARIO_FORMAT)}, got ${JSON.stringify(scenario.format)}`
    );
  }
}

function validateCapture(scenario: ConnectorScenario): void {
  if (scenario.capture?.complete !== true) {
    fail(
      "capture_incomplete",
      "scenario.capture.complete is not true — a scenario the recorder could not fully persist must never back a replay claim"
    );
  }
}

function validateConnectorRef(scenario: ConnectorScenario): void {
  if (typeof scenario.connector?.id !== "string" || scenario.connector.id.trim().length === 0) {
    fail("missing_connector_id", "scenario.connector.id is missing or empty");
  }
}

function validateRunsNonEmpty(scenario: ConnectorScenario): void {
  if (!Array.isArray(scenario.runs) || scenario.runs.length === 0) {
    fail("no_runs", "scenario.runs is empty — a scenario with zero runs proves nothing");
  }
}

/** `state_from_run` must reference a strictly earlier run index within
 *  bounds — never itself, never forward, never out of range. */
function validateStateFromRun(scenario: ConnectorScenario): void {
  scenario.runs.forEach((run, runIndex) => {
    const ref = run.start?.state_from_run;
    if (ref === undefined) {
      return;
    }
    if (!Number.isInteger(ref)) {
      fail(
        "state_from_run_invalid",
        `run ${String(runIndex)}: state_from_run must be an integer, got ${JSON.stringify(ref)}`
      );
    }
    if (ref === runIndex) {
      fail("state_from_run_self_reference", `run ${String(runIndex)}: state_from_run references itself`);
    }
    if (ref > runIndex) {
      fail(
        "state_from_run_forward_reference",
        `run ${String(runIndex)}: state_from_run (${String(ref)}) references a later run — only earlier runs are allowed`
      );
    }
    if (ref < 0 || ref >= scenario.runs.length) {
      fail(
        "state_from_run_out_of_range",
        `run ${String(runIndex)}: state_from_run (${String(ref)}) is out of range [0, ${String(scenario.runs.length)})`
      );
    }
  });
}

/** Duplicate or nonpositive `seq` within a single run's interaction list
 *  (HTTP or user_interactions — same rule, applied separately per list). */
function validateSeqSequence(
  runIndex: number,
  kind: "interactions" | "user_interactions",
  items: readonly { seq: number }[]
): void {
  const seen = new Set<number>();
  for (const item of items) {
    if (!Number.isInteger(item.seq) || item.seq <= 0) {
      fail(
        "nonpositive_seq",
        `run ${String(runIndex)}: ${kind} contains a nonpositive/non-integer seq (${JSON.stringify(item.seq)})`
      );
    }
    if (seen.has(item.seq)) {
      fail("duplicate_seq", `run ${String(runIndex)}: ${kind} contains duplicate seq ${String(item.seq)}`);
    }
    seen.add(item.seq);
  }
}

function isSortedQueryPairs(value: unknown): value is [string, string][] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string"
  );
}

function validateRequestShape(runIndex: number, interaction: ScenarioInteraction): void {
  const { request } = interaction;
  if (!request || typeof request.method !== "string" || request.method.trim().length === 0) {
    fail(
      "malformed_request",
      `run ${String(runIndex)}: interaction seq ${String(interaction.seq)} has a missing/empty request.method`
    );
  }
  if (typeof request.origin !== "string" || request.origin.trim().length === 0) {
    fail(
      "malformed_request",
      `run ${String(runIndex)}: interaction seq ${String(interaction.seq)} has a missing/empty request.origin`
    );
  }
  if (typeof request.path !== "string" || request.path.trim().length === 0) {
    fail(
      "malformed_request",
      `run ${String(runIndex)}: interaction seq ${String(interaction.seq)} has a missing/empty request.path`
    );
  }
  if (!isSortedQueryPairs(request.query)) {
    fail(
      "malformed_request",
      `run ${String(runIndex)}: interaction seq ${String(interaction.seq)} has a request.query that is not an array of [string, string] pairs`
    );
  }
}

function validateResponseShape(runIndex: number, interaction: ScenarioInteraction): void {
  const { response } = interaction;
  if (!response || typeof response.status !== "number" || !Number.isInteger(response.status)) {
    fail(
      "malformed_response",
      `run ${String(runIndex)}: interaction seq ${String(interaction.seq)} has a missing/non-integer response.status`
    );
  }
}

function validateInteractionShapes(runIndex: number, run: ScenarioRun): void {
  for (const interaction of run.interactions) {
    validateRequestShape(runIndex, interaction);
    validateResponseShape(runIndex, interaction);
  }
}

/** `expected.records[stream].ids.length` must equal both `count` and
 *  `record_sha256s.length` — a mismatch means the scenario's own
 *  expectation is internally inconsistent and can never be satisfied. */
function validateExpectationLengths(runIndex: number, run: ScenarioRun): void {
  for (const [stream, expectation] of Object.entries(run.expected?.records ?? {})) {
    const idsLength = expectation.ids?.length ?? 0;
    const hashesLength = expectation.record_sha256s?.length ?? 0;
    if (idsLength !== expectation.count) {
      fail(
        "expectation_length_mismatch",
        `run ${String(runIndex)} stream ${stream}: ids.length (${String(idsLength)}) !== count (${String(expectation.count)})`
      );
    }
    if (idsLength !== hashesLength) {
      fail(
        "expectation_length_mismatch",
        `run ${String(runIndex)} stream ${stream}: ids.length (${String(idsLength)}) !== record_sha256s.length (${String(hashesLength)})`
      );
    }
  }
}

const VALID_RECORD_OPS: ReadonlySet<string> = new Set(["upsert", "delete"]);

/**
 * P1 (eighth review) — `ops` is now MANDATORY on every stream expectation
 * (format.ts's `ScenarioStreamExpectation.ops` doc comment: the format is
 * unmerged and scenarios are local-only, so there is no legacy corpus a
 * migration tier would protect; one fewer state beats tolerating an
 * ops-less scenario). Rejects, with a distinct named reason each:
 *   - `missing_ops` — `ops` absent, `undefined`, or not an array at all;
 *   - `ops_length_mismatch` — `ops.length` disagrees with `ids.length`
 *     (equivalently `count`/`record_sha256s.length`, already pinned equal
 *     to `ids.length` by `validateExpectationLengths` above);
 *   - `invalid_op_literal` — any element of `ops` is neither `"upsert"` nor
 *     `"delete"`.
 * Run AFTER `validateExpectationLengths` in `validateRun` below, so an
 * `ids`/`count`/`record_sha256s` misalignment is always reported before an
 * `ops` misalignment when a scenario has both — `validateExpectationLengths`
 * already established `ids.length` as the trustworthy reference length by
 * the time this function reads it.
 */
function validateExpectationOps(runIndex: number, run: ScenarioRun): void {
  for (const [stream, expectation] of Object.entries(run.expected?.records ?? {})) {
    const { ops } = expectation;
    if (!Array.isArray(ops)) {
      fail(
        "missing_ops",
        `run ${String(runIndex)} stream ${stream}: expected.records.${stream}.ops is required (one of "upsert"|"delete" per record, index-aligned with ids) but is ${JSON.stringify(ops)}`
      );
    }
    const idsLength = expectation.ids?.length ?? 0;
    if (ops.length !== idsLength) {
      fail(
        "ops_length_mismatch",
        `run ${String(runIndex)} stream ${stream}: ops.length (${String(ops.length)}) !== ids.length (${String(idsLength)})`
      );
    }
    ops.forEach((op, index) => {
      if (!VALID_RECORD_OPS.has(op as string)) {
        fail(
          "invalid_op_literal",
          `run ${String(runIndex)} stream ${stream}: ops[${String(index)}] must be "upsert" or "delete", got ${JSON.stringify(op)}`
        );
      }
    });
  }
}

/**
 * Structural shape check for a `"recorded-browser"` run's driver-specific
 * fields (format.ts's `ScenarioBrowserNetworkDriver`) — `har_path` and
 * `storage_state_path` non-empty strings, `har_entry_count` a non-negative
 * integer. This is a SHAPE check only (mirrors this file's module doc
 * comment: "validates SHAPE only ... does not compare them against the
 * current tree") — it does not touch the filesystem or check that the
 * referenced files actually exist/parse; that is
 * `browser-har-replay.ts`'s `resolveBrowserEvidence`'s job at actual replay
 * time (this validator has no I/O, matching every other check in this
 * module). `har_entry_count` is allowed to be 0 here (a structurally valid
 * but vacuous scenario) — vacuousness is `wire-registry.ts`'s
 * `DRIVER_EVIDENCE_POLICIES` job to catch (downgrading the claim, not
 * rejecting the scenario outright), the same division of labor
 * `validateExpectationOps` above has with the record-content oracle.
 */
function validateBrowserNetworkDriver(runIndex: number, run: ScenarioRun): void {
  const network = run.environment?.network;
  if (network?.driver !== "recorded-browser") {
    return;
  }
  const { har_path: harPath, storage_state_path: storageStatePath, har_entry_count: harEntryCount } = network;
  if (typeof harPath !== "string" || harPath.trim().length === 0) {
    fail(
      "malformed_browser_environment",
      `run ${String(runIndex)}: environment.network.har_path is required and must be a non-empty string for driver "recorded-browser"`
    );
  }
  if (typeof storageStatePath !== "string" || storageStatePath.trim().length === 0) {
    fail(
      "malformed_browser_environment",
      `run ${String(runIndex)}: environment.network.storage_state_path is required and must be a non-empty string for driver "recorded-browser"`
    );
  }
  if (typeof harEntryCount !== "number" || !Number.isInteger(harEntryCount) || harEntryCount < 0) {
    fail(
      "malformed_browser_environment",
      `run ${String(runIndex)}: environment.network.har_entry_count is required and must be a non-negative integer for driver "recorded-browser", got ${JSON.stringify(harEntryCount)}`
    );
  }
}

function validateRun(runIndex: number, run: ScenarioRun): void {
  validateSeqSequence(runIndex, "interactions", run.interactions ?? []);
  validateSeqSequence(runIndex, "user_interactions", (run.user_interactions ?? []) as ScenarioUserInteraction[]);
  validateInteractionShapes(runIndex, run);
  validateExpectationLengths(runIndex, run);
  validateExpectationOps(runIndex, run);
  validateBrowserNetworkDriver(runIndex, run);
}

/**
 * Full pure structural/trust validation of a parsed scenario. Throws
 * `ScenarioValidationError` naming the first violation found (checks run in
 * a fixed order — format, then capture, then connector id, then run
 * structure — so a scenario failing multiple checks always reports the same
 * first failure rather than a nondeterministic one).
 */
export function validateScenario(scenario: ConnectorScenario): void {
  validateFormat(scenario);
  validateCapture(scenario);
  validateConnectorRef(scenario);
  validateRunsNonEmpty(scenario);
  validateStateFromRun(scenario);
  scenario.runs.forEach((run, runIndex) => {
    validateRun(runIndex, run);
  });
}

// ─── Identity/digest binding (FIX 3) ───────────────────────────────────────

/**
 * sha256 (hex) of a manifest JSON file's raw bytes, as committed on disk —
 * NOT a canonicalized/re-serialized form. `declaration_digest` binds a
 * scenario to the EXACT bytes the recorder read, so recomputing must hash
 * the exact bytes too; re-serializing through JSON.parse/stringify would
 * silently normalize away whitespace/key-order differences that a byte
 * digest is supposed to catch.
 */
export function computeDeclarationDigest(manifestPath: string): string {
  const bytes = readFileSync(manifestPath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Every file under `connectorDir`, recursively, EXCLUDING:
 *   - any file whose name ends in `.test.ts` (tests are not part of the
 *     connector's runtime behavior; a test edit must not look like source
 *     drift), and
 *   - any file under a path component that looks like a fixtures directory
 *     (`fixtures`, `__fixtures__`, case-insensitive) — fixture data changes
 *     with test needs, not with the connector's actual collection logic.
 * Returned as POSIX-style relative paths (forward slashes, regardless of
 * host OS), sorted lexicographically, so the digest is stable across
 * platforms and directory-listing order.
 */
function comparePath(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function listSourceFiles(connectorDir: string): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (FIXTURE_DIR_NAME_RE.test(entry.name)) {
          continue;
        }
        walk(join(dir, entry.name));
        continue;
      }
      if (entry.isFile()) {
        if (entry.name.endsWith(".test.ts")) {
          continue;
        }
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(connectorDir);

  return out.map((absPath) => relative(connectorDir, absPath).split(sep).join("/")).sort(comparePath);
}

/**
 * sha256 (hex) over the connector SOURCE TREE at `connectorDir`: sorted
 * relative paths + per-file sha256, excluding `*.test.ts` and fixture
 * directories (see `listSourceFiles`). Binds the replay claim to the
 * source that produced the recording — NOT a built/distributable package
 * (see format.ts's `ScenarioConnectorRef.source_digest` doc).
 *
 * Digest construction: newline-joined `"<relative-path> <sha256-of-file>"`
 * lines, in sorted-path order, then sha256 of that joined text. Simple and
 * auditable — a reviewer can reconstruct it by hand from `sha256sum` output.
 */
export function computeSourceDigest(connectorDir: string): string {
  const files = listSourceFiles(connectorDir);
  const lines = files.map((relPath) => {
    const bytes = readFileSync(join(connectorDir, relPath));
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    return `${relPath} ${fileHash}`;
  });
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** True when `path` exists and is a regular file. */
export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `path` exists and is a directory. */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export { isPlainObject };
