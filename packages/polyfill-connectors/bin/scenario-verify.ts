#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * scenario-verify — the offline-replay half of the developer capture→verify
 * loop for the connector-verification scenario harness (src/scenario/*.ts).
 *
 * Replays every run in a `pdpp.connector-scenario/1` scenario file (as
 * written by bin/scenario-record.ts) strictly offline against the REAL
 * connector code, running as a subprocess exactly like bin/connector-dev.ts
 * and bin/scenario-record.ts do. No live egress is possible: the
 * subprocess's `globalThis.fetch` is patched via a NODE_OPTIONS preload
 * (src/scenario/subprocess-fetch-preloads.ts's `writeReplayBridgePreload`)
 * that forwards every request over a loopback-only HTTP bridge to THIS
 * process's real `createReplayFetch(run, scenario.normalizers)` instance —
 * the same instance `verifyScenario` (src/scenario/verify.ts) constructs and
 * tracks for `assertAllConsumed()`. There is no code path in this file that
 * reaches the real network; the bridge server binds to 127.0.0.1 only and
 * its only handler is the in-memory replay matcher.
 *
 * This is the exact pattern connectors/oura/scenario.spike.test.ts proved
 * against the real (unmodified) oura connector — this CLI generalizes that
 * proof to any connector by resolving the entrypoint from the manifest
 * registry (or `--entrypoint` for dev/test) instead of hardcoding oura.
 *
 * Usage:
 *   pnpm exec tsx bin/scenario-verify.ts <connector> <scenario-path> [--timeout <seconds>]
 *
 * Example:
 *   pnpm exec tsx bin/scenario-verify.ts oura runs/oura/2026-08-13T00-00-00-000Z-scenario.json
 *
 * `--entrypoint <path>` mirrors bin/connector-dev.ts's dev/test-only
 * override, letting bin/scenario-cli.test.ts drive this CLI end-to-end
 * against a test-only fixture connector.
 *
 * `--timeout <seconds>` overrides the inactivity watchdog's default 300s
 * window — see this file's "Inactivity watchdog" section (above
 * `runReplaySubprocess`) for why replay needs the same fix
 * bin/scenario-record.ts's recording side does: a replayed connector is
 * ALSO paced (its own governor sleeps run in real time during replay, since
 * this CLI drives the exact same connector code as a real subprocess), so a
 * fixed total-duration kill was just as wrong here.
 *
 * Exit code: 0 when every run passes; non-zero when any run fails (prints
 * the structured failure list `verifyScenario` returns) or the scenario
 * file/connector can't be resolved at all.
 *
 * ─── Scripted interaction replay ───────────────────────────────────────────
 *
 * `src/scenario/verify.ts`'s `verifyScenario`/`createReplayFetch` (replay.ts)
 * only replay HTTP interactions — they know nothing about the Collection
 * Profile INTERACTION protocol. This CLI layers scripted interaction replay
 * on top, entirely within `runReplaySubprocess`/`runCollector` below: when
 * the replaying subprocess emits an INTERACTION, this CLI answers it from
 * `scenario.runs[runIndex].user_interactions`, IN ORDER (the same seq-ordered
 * "next recorded pair" discipline `replay.ts` uses for HTTP interactions).
 * This is strict, matching the harness's existing philosophy:
 *   - An INTERACTION with no next recorded `user_interactions` entry left to
 *     serve is a replay failure (an unscripted prompt the scenario never
 *     captured an answer for) — thrown as an `Error` inside `runCollector`,
 *     which `verifyScenario`'s `verifyRun` catches and reports as this run's
 *     `replay_mismatch` failure (see src/scenario/verify.ts).
 *   - Any recorded `user_interactions` entries left UNCONSUMED after the run
 *     finishes (the connector never asked for them) also fail the run —
 *     checked after `runCollector` returns and, likewise, thrown so
 *     `verifyRun` reports it under `replay_mismatch`.
 * OTP-style response values (`user_interactions[].response.value`/`.data`)
 * are redacted by DEFAULT, exactly like credentials — see
 * `bin/scenario-record.ts`'s `--persist-otp` flag (P2-1, repair wave 3A).
 * Only when a scenario was captured WITH `--persist-otp` does this file
 * replay a real OTP value verbatim from the scenario file; a redacted
 * `user_interactions` entry (OTP or credentials) is refused outright by this
 * CLI, the same way (see format.ts's `ScenarioUserInteraction` doc comment
 * and this file's `scriptedInteractionResponse`/replay-refusal logic below).
 * Scenarios remain local-only regardless (never committed/shared without a
 * scrub pass).
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@pdpp/collector-runtime";
import type { InteractionResponse } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { config as dotenvConfig } from "dotenv";
import { getConnectorPaths, KNOWN_CONNECTOR_NAMES, readManifest } from "../src/orchestrator.ts";
import {
  BrowserReplayEvidenceError,
  resolveBrowserEvidence,
  writeBrowserHarReplayPreload,
} from "../src/scenario/browser-har-replay.ts";
import { evaluateClaimEligibility } from "../src/scenario/claims.ts";
import type { ConnectorScenario, ScenarioUserInteraction } from "../src/scenario/format.ts";
import {
  isNamespaceIsolationAvailable,
  type NamespaceIsolationCapability,
  spawnWithNetworkIsolation,
} from "../src/scenario/isolation.ts";
import {
  cleanupScenarioEvidenceWorkspace,
  createScenarioEvidenceWorkspace,
  messagesToRecordsAndState,
  PDPP_SCENARIO_BRIDGE_UDS_PATH_ENV,
  PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV,
  type ProtocolMessage,
  type ScenarioEvidenceWorkspace,
  startFetchBridgeServer,
  subprocessEnv,
  writeReplayBridgePreload,
} from "../src/scenario/subprocess-fetch-preloads.ts";
import {
  computeDeclarationDigest,
  computeSourceDigest,
  directoryExists,
  fileExists,
  ScenarioValidationError,
  validateScenario,
} from "../src/scenario/validate.ts";
import type { RawTraceMessage, RunCollectorEmit, VerifyFailure, VerifyResult } from "../src/scenario/verify.ts";
import { observedUnsupportedEvidenceSurface, verifyScenario } from "../src/scenario/verify.ts";
import {
  assertKnownMessageType,
  assertValidInteractionMessage,
  driverEvidenceSatisfied,
} from "../src/scenario/wire-registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

dotenvConfig({ path: join(REPO_ROOT, ".env.local"), quiet: true });

export interface CliArgs {
  connector: string;
  entrypoint?: string;
  /** FIX D — `--require-capture-source`: restores strict equality between
   *  `scenario.connector.captured_with` and the CURRENT subject's digests,
   *  for exact-artifact reproduction. Off by default: a differing source is
   *  REPORTED, not failed, so a scenario can serve as a refactor oracle. */
  requireCaptureSource: boolean;
  scenarioPath: string;
  /** `--timeout <seconds>` — overrides `DEFAULT_INACTIVITY_WINDOW_SECONDS`
   *  for the inactivity watchdog (see this file's "Inactivity watchdog"
   *  section). Must be a positive integer. */
  timeoutSeconds: number;
}

function usageAndExit(code: number): never {
  process.stderr.write(
    "Usage: scenario-verify <connector> <scenario-path> [--require-capture-source] [--timeout <seconds>]\n"
  );
  process.stderr.write(`Known connectors: ${KNOWN_CONNECTOR_NAMES.join(", ")}\n`);
  process.exit(code);
}

const POSITIVE_INTEGER_RE = /^\d+$/;

/** Consumes `--timeout <seconds>` at `argv[i]` — must be a positive integer
 *  (the inactivity watchdog window in seconds; see this file's "Inactivity
 *  watchdog" section). Returns the parsed seconds and the next index to
 *  resume parsing from. Split out of `parseArgs` purely to stay under this
 *  package's cognitive-complexity lint ceiling — behavior is unchanged from
 *  an inline version. */
function consumeTimeoutFlag(argv: readonly string[], i: number): { nextIndex: number; timeoutSeconds: number } {
  const value = argv[i];
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!(value && POSITIVE_INTEGER_RE.test(value) && Number.isInteger(parsed) && parsed > 0)) {
    process.stderr.write("--timeout must be a positive integer (seconds)\n");
    usageAndExit(2);
  }
  return { timeoutSeconds: parsed, nextIndex: i + 1 };
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let connector: string | undefined;
  let scenarioPath: string | undefined;
  let entrypoint: string | undefined;
  let requireCaptureSource = false;
  let timeoutSeconds = DEFAULT_INACTIVITY_WINDOW_SECONDS;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    i += 1;
    if (arg === "--entrypoint") {
      const value = argv[i];
      i += 1;
      if (!value) {
        usageAndExit(2);
      }
      entrypoint = value;
      continue;
    }
    if (arg === "--require-capture-source") {
      requireCaptureSource = true;
      continue;
    }
    if (arg === "--timeout") {
      ({ timeoutSeconds, nextIndex: i } = consumeTimeoutFlag(argv, i));
      continue;
    }
    if (arg && !arg.startsWith("--") && !connector) {
      connector = arg;
      continue;
    }
    if (arg && !arg.startsWith("--") && !scenarioPath) {
      scenarioPath = arg;
      continue;
    }
    usageAndExit(2);
  }
  if (!(connector && scenarioPath)) {
    usageAndExit(2);
  }
  return { connector, scenarioPath, requireCaptureSource, timeoutSeconds, ...(entrypoint ? { entrypoint } : {}) };
}

function resolveConnectorPath(args: CliArgs): string {
  if (args.entrypoint) {
    return args.entrypoint;
  }
  if (!KNOWN_CONNECTOR_NAMES.includes(args.connector)) {
    process.stderr.write(`Unknown connector: ${args.connector}\n`);
    usageAndExit(2);
  }
  return getConnectorPaths(args.connector).connectorPath;
}

/**
 * Loads a scenario file and runs FIX 1's full strict validation
 * (`validateScenario`) before returning it — nothing downstream (identity
 * binding, digest recomputation, subprocess spawning) ever sees a scenario
 * that hasn't passed every structural/trust check. `validateScenario`
 * subsumes the old bare `format` check (it is itself the first check
 * `validateScenario` runs) so there is no separate format check left here.
 */
export function loadScenario(scenarioPath: string): ConnectorScenario {
  const raw = readFileSync(scenarioPath, "utf8");
  const parsed = JSON.parse(raw) as ConnectorScenario;
  validateScenario(parsed);
  return parsed;
}

/**
 * Identity check — fails outright (throws) before any subprocess is spawned
 * when the CLI's `<connector>` argument does not equal
 * `scenario.connector.id` (the scenario was captured for a different
 * connector than the one being verified). This is unconditional, in every
 * mode (including `--entrypoint`), and unaffected by FIX D's digest-model
 * split below.
 */
function assertConnectorIdentity(args: CliArgs, scenario: ConnectorScenario): void {
  if (scenario.connector.id !== args.connector) {
    throw new Error(
      `scenario-verify: CLI connector argument (${JSON.stringify(args.connector)}) does not match scenario.connector.id (${JSON.stringify(scenario.connector.id)}) — refusing to verify a scenario captured for a different connector`
    );
  }
}

/**
 * FIX 5 — modality-neutral envelope. `run.environment.network.driver`
 * (format.ts's `ScenarioRunEnvironment`, additive) names the transport a
 * run's evidence was captured/replayed over; this build implements two
 * drivers — `"recorded-http"` (the HTTP request/response capture-and-replay
 * this harness originally was) and `"recorded-browser"` (HAR-backed browser
 * network replay, browser-har-replay.ts, added for the 29-of-45 connectors
 * that drive traffic through `page.evaluate(fetch)` where `recorded-http`'s
 * Node-process fetch/http/net patch structurally cannot see anything). A run
 * whose environment declares a driver OUTSIDE this set is a claim this build
 * cannot honor — replaying it as if it were a driver this build implements
 * would silently misrepresent what was actually verified. Fails outright,
 * before any subprocess is spawned, same pre-flight tier as identity/digest
 * checks above. A run with NO `environment` (every scenario captured before
 * this field existed, or any future driver that legitimately omits it) is
 * unaffected — absence is "no modality claim made", not a claim to reject.
 */
export class UnsupportedEnvironmentDriverError extends Error {
  constructor(runIndex: number, driver: string) {
    super(`scenario-verify: no driver available for ${JSON.stringify(driver)} in this build (run ${String(runIndex)})`);
    this.name = "UnsupportedEnvironmentDriverError";
  }
}

const SUPPORTED_NETWORK_DRIVERS: ReadonlySet<string> = new Set(["recorded-http", "recorded-browser"]);

function assertSupportedEnvironmentDrivers(scenario: ConnectorScenario): void {
  scenario.runs.forEach((run, runIndex) => {
    const driver = run.environment?.network?.driver;
    if (driver !== undefined && !SUPPORTED_NETWORK_DRIVERS.has(driver)) {
      throw new UnsupportedEnvironmentDriverError(runIndex, driver);
    }
  });
}

/** One side (declaration or source) of the digest comparison FIX D reports —
 *  see `reportCaptureSourceDigests`'s doc comment. */
interface DigestComparison {
  capturedDigest: string | undefined;
  currentDigest: string | undefined;
  label: "declaration" | "source";
}

function compareDigest(
  label: DigestComparison["label"],
  capturedDigest: string | undefined,
  currentDigest: string | undefined
): DigestComparison {
  return { label, capturedDigest, currentDigest };
}

/** True when a digest pair is present on both sides and they differ — the
 *  only case FIX D's report line calls out explicitly as "differs". Absent
 *  on either side (nothing captured, or nothing computable for the current
 *  subject) is reported as present/absent, not as a difference. */
function digestsDiffer(comparison: DigestComparison): boolean {
  return (
    comparison.capturedDigest !== undefined &&
    comparison.currentDigest !== undefined &&
    comparison.capturedDigest !== comparison.currentDigest
  );
}

function formatDigestForReport(digest: string | undefined): string {
  if (digest === undefined) {
    return "(none)";
  }
  return digest.slice(0, 8);
}

/**
 * What `reportCaptureSourceDigests` observed, fed straight into FIX 1's
 * centralized claim-eligibility evaluator (src/scenario/claims.ts) —
 * conditions (b1)/(b2)/(c1)/(c2) of `evaluateClaimEligibility` are read
 * directly off this struct rather than re-derived, so the eligibility
 * decision can never drift from what this report line actually printed.
 *
 * Repair wave 4 (P1-1): split from the old coarse
 * `capturedWithSourceDigestPresent`/`subjectDigestsComputed` pair into four
 * independent observations — declaration and source are now two genuinely
 * separate bindings (see claims.ts's `ClaimLimitation` doc comment), so a
 * scenario missing only its declaration digest reports a DIFFERENT
 * limitation than one missing only its source digest, or one replaying
 * against a connector with no manifest/directory on disk at all.
 */
interface CaptureSourceDigestObservation {
  /** Condition (b1): `scenario.connector.captured_with` (or its deprecated
   *  top-level fallback) carries a `declaration_digest`. */
  capturedDeclarationDigestPresent: boolean;
  /** Condition (b2): `scenario.connector.captured_with` (or its deprecated
   *  top-level fallback) carries a `source_digest`. */
  capturedSourceDigestPresent: boolean;
  /** Condition (c1): the CURRENT subject's declaration digest was actually
   *  computed this run (a bound manifest file existed to hash). Always
   *  false in `--entrypoint` mode. */
  currentDeclarationDigestComputed: boolean;
  /** Condition (c2): the CURRENT subject's source digest was actually
   *  computed this run (a bound connector directory existed to hash).
   *  Always false in `--entrypoint` mode. */
  currentSourceDigestComputed: boolean;
}

/**
 * FIX D — digest model split. `scenario.connector.captured_with` (written
 * once by scenario-record) is compared against the CURRENT subject's
 * freshly-recomputed digests. By default this is purely informational: a
 * differing source is exactly what replaying a scenario as a refactor oracle
 * looks like, so it is REPORTED (printed), never failed. Passing
 * `--require-capture-source` restores strict equality — for exact-artifact
 * reproduction — and throws (before any subprocess is spawned) on any
 * present-on-both-sides mismatch.
 *
 * `--entrypoint` mode has no bound manifest/connector directory to compute a
 * current digest from at all (see `resolveConnectorPath`), so this prints
 * "unbound diagnostic replay (no digests)" and does no comparison —
 * `--require-capture-source` is a no-op in that mode (there is nothing to
 * require equality against).
 *
 * Returns the `CaptureSourceDigestObservation` this run made, for FIX 1's
 * claim-eligibility evaluator to consume.
 */
function reportCaptureSourceDigests(args: CliArgs, scenario: ConnectorScenario): CaptureSourceDigestObservation {
  if (args.entrypoint) {
    process.stdout.write("source binding: unbound diagnostic replay (no digests) — --entrypoint override\n");
    return {
      capturedDeclarationDigestPresent: false,
      capturedSourceDigestPresent: false,
      currentDeclarationDigestComputed: false,
      currentSourceDigestComputed: false,
    };
  }

  const { manifestPath } = getConnectorPaths(args.connector);
  const connectorDir = dirname(getConnectorPaths(args.connector).connectorPath);
  const capturedWith = scenario.connector.captured_with;
  // Legacy scenarios (recorded before this fix) only carry the deprecated
  // top-level declaration_digest/source_digest — fall back to those so this
  // report line still has something to compare for them.
  const capturedDeclaration = capturedWith?.declaration_digest ?? scenario.connector.declaration_digest;
  const capturedSource = capturedWith?.source_digest ?? scenario.connector.source_digest;

  const currentDeclaration = fileExists(manifestPath) ? computeDeclarationDigest(manifestPath) : undefined;
  const currentSource = directoryExists(connectorDir) ? computeSourceDigest(connectorDir) : undefined;

  const declarationComparison = compareDigest("declaration", capturedDeclaration, currentDeclaration);
  const sourceComparison = compareDigest("source", capturedSource, currentSource);

  const declarationDiffers = digestsDiffer(declarationComparison);
  const sourceDiffers = digestsDiffer(sourceComparison);

  const differsSuffix = declarationDiffers || sourceDiffers ? ", differs - replaying against changed code" : "";
  process.stdout.write(
    `captured_with source: ${formatDigestForReport(capturedSource)}, verified subject source: ${formatDigestForReport(currentSource)}${differsSuffix}\n`
  );
  if (capturedDeclaration !== undefined || currentDeclaration !== undefined) {
    const declDiffersSuffix = declarationDiffers ? ", differs - manifest changed since capture" : "";
    process.stdout.write(
      `captured_with declaration: ${formatDigestForReport(capturedDeclaration)}, verified subject declaration: ${formatDigestForReport(currentDeclaration)}${declDiffersSuffix}\n`
    );
  }

  const observation: CaptureSourceDigestObservation = {
    capturedDeclarationDigestPresent: capturedDeclaration !== undefined,
    capturedSourceDigestPresent: capturedSource !== undefined,
    currentDeclarationDigestComputed: currentDeclaration !== undefined,
    currentSourceDigestComputed: currentSource !== undefined,
  };

  if (!args.requireCaptureSource) {
    return observation;
  }
  if (declarationDiffers) {
    throw new Error(
      `scenario-verify: --require-capture-source: manifest declaration drift since capture — expected declaration_digest ${String(capturedDeclaration)}, got ${String(currentDeclaration)} (manifests/${args.connector}.json bytes have changed since this scenario was recorded)`
    );
  }
  if (sourceDiffers) {
    throw new Error(
      `scenario-verify: --require-capture-source: source drift since capture — expected source_digest ${String(capturedSource)}, got ${String(currentSource)} (connectors/${args.connector}/ source has changed since this scenario was recorded)`
    );
  }
  return observation;
}

function isPlainStateRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when `finalState` is a real, non-empty committed state — i.e. a run
 * seeding from it would actually be narrowing off SOMETHING, not a vacuous
 * seed. Used by the `state_seeded_second_run_with_changed_requests` coverage
 * claim below (renamed from `incremental_two_run` — see that claim's own
 * doc comment): `null`/
 * `undefined` obviously carry no cursor; `{}` (or an array with no own
 * enumerable keys, though `final_state` is always an object per
 * `mergeStateMessages` in verify.ts) is likewise empty. Any object with at
 * least one key is treated as non-trivial without inspecting further —
 * evaluating whether that key's VALUE is itself meaningful is out of scope
 * here (that is what the differing-requests check right next to this call
 * is for).
 */
function isNonTrivialFinalState(finalState: unknown): boolean {
  if (finalState === null || finalState === undefined) {
    return false;
  }
  if (typeof finalState === "object" && !Array.isArray(finalState)) {
    return Object.keys(finalState).length > 0;
  }
  return true;
}

/** Raw shape of a Collection Profile INTERACTION message as parsed off the
 *  subprocess's stdout JSONL — richer than `ProtocolMessage` (which doesn't
 *  model `kind`/`request_id`/`message`/`schema`/`timeout_seconds`), read
 *  directly off the parsed JSON. Mirrors bin/scenario-record.ts's
 *  `RawInteractionLine` — P1-2 (seventh review) adds `schema`/
 *  `timeout_seconds`, which the record side already captures into
 *  `ScenarioUserInteraction.prompt` but this replay side previously never
 *  read at all. */
interface RawInteractionLine {
  kind: string;
  message: string;
  request_id: string;
  schema?: Record<string, unknown>;
  timeout_seconds?: number;
  type: "INTERACTION";
}

function isRawInteractionLine(value: unknown): value is RawInteractionLine {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "INTERACTION" &&
    typeof (value as { request_id?: unknown }).request_id === "string" &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * P1-2 (seventh review): compares the ACTUAL live prompt (`raw`, already
 * validated at the wire boundary by `assertValidInteractionMessage` before
 * this is called — see `answerScriptedInteraction`) against the recorded
 * one (`recorded.prompt`), field by field, with EXACT equality on `kind`,
 * `message`, canonical-JSON of `schema` (including presence-vs-absence —
 * an actual prompt with no schema must not silently equal a recorded one
 * that had `schema: {}`, and vice versa), and `timeout_seconds` (same
 * presence-vs-absence rule). `request_id` is deliberately excluded — see
 * `ScenarioUserInteraction`'s doc comment (format.ts): it is minted fresh
 * per run by the connector-runtime and is not stable across record vs.
 * replay, exactly like HTTP interactions exclude volatile per-run
 * identifiers from their match key. Returns the name of the FIRST
 * differing field plus a short human-readable detail, or `undefined` when
 * every compared field matches exactly.
 */
function firstInteractionPromptMismatch(
  raw: RawInteractionLine,
  recorded: ScenarioUserInteraction
): { detail: string; field: string } | undefined {
  const actualSchemaJson = canonicalJson(raw.schema ?? null);
  const recordedSchemaJson = canonicalJson(recorded.prompt.schema ?? null);
  // A single ??-chained expression (rather than an early-return-per-field
  // chain ending in a bare `return;`) so this function's last statement is
  // never a no-value return — this package's biome config (`noUselessUndefined`)
  // strips a trailing `return undefined;`, which would otherwise conflict
  // with tsconfig's `noImplicitReturns` on a function typed to return
  // `T | undefined`. Order matches the doc comment above: kind, then
  // message, then schema, then timeout_seconds — the FIRST truthy entry
  // (i.e. first mismatch) wins.
  return (
    (raw.kind === recorded.prompt.kind
      ? undefined
      : {
          field: "kind",
          detail: `expected kind ${JSON.stringify(recorded.prompt.kind)}, got ${JSON.stringify(raw.kind)}`,
        }) ??
    (raw.message === recorded.prompt.message
      ? undefined
      : {
          field: "message",
          detail: `expected message ${JSON.stringify(recorded.prompt.message)}, got ${JSON.stringify(raw.message)}`,
        }) ??
    (actualSchemaJson === recordedSchemaJson
      ? undefined
      : {
          field: "schema",
          detail: `expected schema ${JSON.stringify(recorded.prompt.schema)}, got ${JSON.stringify(raw.schema)}`,
        }) ??
    (raw.timeout_seconds === recorded.prompt.timeout_seconds
      ? undefined
      : {
          field: "timeout_seconds",
          detail: `expected timeout_seconds ${JSON.stringify(recorded.prompt.timeout_seconds)}, got ${JSON.stringify(raw.timeout_seconds)}`,
        })
  );
}

/** Builds the wire INTERACTION_RESPONSE from a scripted
 *  `ScenarioUserInteraction.response`, re-attaching THIS run's own
 *  `request_id` (the recorded one is not stable across record vs. replay —
 *  see format.ts's `ScenarioUserInteraction` doc comment). */
function scriptedInteractionResponse(requestId: string, recorded: ScenarioUserInteraction): InteractionResponse {
  return {
    type: "INTERACTION_RESPONSE",
    request_id: requestId,
    status: recorded.response.status,
    ...(recorded.response.value === undefined ? {} : { value: recorded.response.value }),
    ...(recorded.response.data === undefined ? {} : { data: recorded.response.data }),
    ...(recorded.response.error === undefined ? {} : { error: recorded.response.error }),
  };
}

/**
 * Runs the connector subprocess once, wired to `bridgeUrl` so every request
 * it issues is forwarded to the parent's real replay `fetch`. Mirrors
 * connectors/oura/scenario.spike.test.ts's `runOuraSubprocess`, generalized
 * to any connector entrypoint/streams.
 *
 * Also answers any Collection Profile INTERACTION the connector emits,
 * scripted strictly from `args.userInteractions` in order — see this file's
 * "Scripted interaction replay" module doc for the pass/fail rules. Throws
 * (rejecting the returned promise) on either an unscripted INTERACTION or
 * leftover unconsumed recorded interactions, so `verifyScenario`'s
 * `verifyRun` reports it as this run's `replay_mismatch` failure.
 */
/**
 * Strict per-line stdout protocol accounting for FIX 2's subprocess
 * strictness rules (b) and (c):
 *   (b) any non-JSON stdout line fails the run — the old behavior silently
 *       discarded a line that failed `JSON.parse`, which meant a connector
 *       (or a bug in this harness) writing garbage to stdout could go
 *       completely unnoticed as long as SOME lines still parsed. Empty
 *       (whitespace-only) lines remain tolerated — JSONL framing legitimately
 *       includes a trailing newline, and connector-exit.ts's own writers may
 *       emit one.
 *   (c) more than one DONE, or ANY protocol message after a DONE has been
 *       observed, fails the run — DONE is the terminal message of the
 *       protocol; a well-behaved connector never writes to stdout again
 *       after it, and a misbehaving one that does is exactly the kind of
 *       protocol violation this harness must catch, not silently accept as
 *       "extra output that happened to still parse".
 */
class SubprocessProtocolViolationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SubprocessProtocolViolationError";
  }
}

function isDoneLine(parsed: unknown): parsed is ProtocolMessage {
  return parsed !== null && typeof parsed === "object" && (parsed as { type?: unknown }).type === "DONE";
}

/** Accumulates stdout protocol messages line by line, enforcing FIX 2 (b)
 *  and (c), plus (repair wave 6, P1-2 duty 1) rejecting any well-formed JSON
 *  object whose `type` is not one of `wire-registry.ts`'s
 *  `KNOWN_MESSAGE_TYPES`. Kept as its own small stateful helper (rather than
 *  inline closures in `runReplaySubprocess`) so the "garbage line" / "unknown
 *  type" / "message after DONE" / "duplicate DONE" rules are each a single,
 *  testable branch. */
class StdoutProtocolAccumulator {
  private doneSeen = false;
  readonly messages: ProtocolMessage[] = [];

  /** Processes one raw stdout line (already split on `\n`, newline
   *  stripped). Returns the parsed message for the caller to route to
   *  interaction-answering, or throws `SubprocessProtocolViolationError`
   *  when the line violates the protocol. Returns `null` for a
   *  tolerated empty/whitespace-only line. */
  ingest(line: string): ProtocolMessage | null {
    if (line.trim().length === 0) {
      return null;
    }
    if (this.doneSeen) {
      throw new SubprocessProtocolViolationError(
        `scenario replay: subprocess wrote a protocol message after DONE was already observed: ${JSON.stringify(line)}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new SubprocessProtocolViolationError(
        `scenario replay: subprocess wrote a non-JSON stdout line: ${JSON.stringify(line)}`,
        { cause: err }
      );
    }
    try {
      assertKnownMessageType(parsed);
    } catch (err) {
      throw new SubprocessProtocolViolationError(
        `scenario replay: subprocess wrote a protocol message with an unrecognized type: ${JSON.stringify(line)}`,
        { cause: err }
      );
    }
    if (isDoneLine(parsed)) {
      this.doneSeen = true;
    }
    const message = parsed as ProtocolMessage;
    this.messages.push(message);
    return message;
  }
}

// ─── Inactivity watchdog ────────────────────────────────────────────────
//
// LIVE INCIDENT (bin/scenario-record.ts's matching section has the full
// account): a real scoped ynab capture's incremental run legitimately ran
// ~4.5 minutes (ynab's audited pacing is ~20s/request across ~13 requests)
// and was SIGKILLed by an arbitrary TOTAL-DURATION ceiling that has no
// relationship to whether the connector was making progress. Replay is
// ALSO paced: a connector's own self-pacing (governor sleeps) runs in real
// time during replay too, since this CLI drives the exact same connector
// code as a real subprocess — so this side needs the identical fix.
//
// The watchdog resets on every child stdout/stderr data chunk, so a paced
// connector (which emits PROGRESS/RECORD lines between requests) never
// trips it — only a genuine hang (no output at all for the whole window)
// does. Default window is 300s (the same number `bin/scenario-record.ts`
// uses, for one consistent, honest default across both CLIs); `--timeout
// <seconds>` overrides it. Replay's scripted interaction answering
// (`answerScriptedInteraction` below) never waits on a human — it answers
// immediately from the recorded scenario — so unlike record's watchdog,
// this one needs no suspend/resume around an INTERACTION.

const DEFAULT_INACTIVITY_WINDOW_SECONDS = 300;

/**
 * FIX 2 — partial evidence for a watchdog verdict: per-stream RECORD counts
 * (from the messages array actually observed this run) plus the last
 * message's type/label and how long ago it arrived. Mirrors
 * `bin/scenario-record.ts`'s `PartialCaptureEvidence`/`buildPartialCaptureEvidence`/
 * `renderPartialCaptureEvidence` exactly (duplicated per-file — see that
 * file's doc comment for why these two CLIs don't share a runtime module).
 */
interface PartialCaptureEvidence {
  lastMessage?: { agoMs: number; label: string; type: string };
  streamRecordCounts: Record<string, number>;
}

function labelForMessage(msg: ProtocolMessage): string {
  const raw = msg as unknown as { message?: unknown; stream?: unknown; type: string };
  const parts: string[] = [raw.type];
  if (typeof raw.stream === "string") {
    parts.push(`stream=${raw.stream}`);
  }
  if (typeof raw.message === "string") {
    parts.push(JSON.stringify(raw.message));
  }
  return parts.join(" ");
}

function buildPartialCaptureEvidence(
  messages: readonly ProtocolMessage[],
  lastMessageSeenAt: { at: number; label: string; type: string } | undefined,
  firedAt: number
): PartialCaptureEvidence {
  const streamRecordCounts: Record<string, number> = {};
  for (const msg of messages) {
    const raw = msg as unknown as { stream?: unknown; type: string };
    if (raw.type === "RECORD" && typeof raw.stream === "string") {
      streamRecordCounts[raw.stream] = (streamRecordCounts[raw.stream] ?? 0) + 1;
    }
  }
  return {
    streamRecordCounts,
    ...(lastMessageSeenAt === undefined
      ? {}
      : {
          lastMessage: {
            type: lastMessageSeenAt.type,
            label: lastMessageSeenAt.label,
            agoMs: firedAt - lastMessageSeenAt.at,
          },
        }),
  };
}

function renderPartialCaptureEvidence(evidence: PartialCaptureEvidence): string {
  const lines: string[] = [];
  const streamNames = Object.keys(evidence.streamRecordCounts).sort((a, b) => a.localeCompare(b));
  if (streamNames.length > 0) {
    lines.push(
      `observed so far: ${streamNames.map((name) => `${name}=${String(evidence.streamRecordCounts[name])} record(s)`).join(", ")}`
    );
  } else {
    lines.push("observed so far: no records emitted on any stream");
  }
  if (evidence.lastMessage) {
    lines.push(
      `last message seen: ${evidence.lastMessage.label} (${String(Math.round(evidence.lastMessage.agoMs / 1000))}s ago)`
    );
  } else {
    lines.push("last message seen: (none — no output observed before the watchdog fired)");
  }
  lines.push("replay is incomplete by rule (killed mid-run)");
  return lines.join("\n");
}

/** Thrown by `createInactivityWatchdog` when its window elapses with no
 *  observed activity. Caught specially in `main().catch()` — see
 *  `ScenarioValidationError`'s handling at this same catch site, which this
 *  mirrors: a plain, evidence-bearing verdict, never a stack trace, since a
 *  killed-for-hanging subprocess is a diagnosed verdict, not a crash in this
 *  CLI's own code. */
export class WatchdogTimeoutError extends Error {
  readonly evidence: PartialCaptureEvidence;
  readonly windowSeconds: number;

  constructor(
    windowSeconds: number,
    observed: { lastMessageSeenAt?: { at: number; label: string; type: string }; messages: readonly ProtocolMessage[] }
  ) {
    const evidence = buildPartialCaptureEvidence(observed.messages, observed.lastMessageSeenAt, Date.now());
    super(
      `[scenario-verify] subprocess inactive for ${String(windowSeconds)}s - killed (window: --timeout ${String(windowSeconds)})\n${renderPartialCaptureEvidence(evidence)}`
    );
    this.name = "WatchdogTimeoutError";
    this.windowSeconds = windowSeconds;
    this.evidence = evidence;
  }
}

/**
 * Pure inactivity-timer core — mirrors `bin/scenario-record.ts`'s
 * `createInactivityWatchdog` exactly (see that file's doc comment for the
 * full suspend/resume rationale). This CLI's replay path never suspends it
 * (scripted interaction answering never waits on a human), but the same
 * `touch`/`dispose` shape is kept so both CLIs' subprocess-driving code
 * reads identically.
 */
export function createInactivityWatchdog(
  windowMs: number,
  onTimeout: () => void,
  timerFns: { cancel: (handle: NodeJS.Timeout) => void; schedule: (fn: () => void, ms: number) => NodeJS.Timeout } = {
    schedule: setTimeout,
    cancel: clearTimeout,
  }
): { dispose: () => void; resume: () => void; suspend: () => void; touch: () => void } {
  let handle: NodeJS.Timeout | undefined;
  let suspended = false;
  // Set once by `dispose()` and never unset — a disposed watchdog is
  // permanently inert. Without this, a `touch()` arriving after `dispose()`
  // (e.g. a stray child "data" event ordered after "close"/"error" in the
  // event loop) would silently re-arm a timer that could fire `onTimeout`
  // (kill + reject) against an already-exited subprocess.
  let disposed = false;

  const arm = (): void => {
    if (handle !== undefined) {
      timerFns.cancel(handle);
    }
    handle = timerFns.schedule(onTimeout, windowMs);
  };

  arm();

  return {
    touch: () => {
      if (!(suspended || disposed)) {
        arm();
      }
    },
    suspend: () => {
      suspended = true;
      if (handle !== undefined) {
        timerFns.cancel(handle);
        handle = undefined;
      }
    },
    resume: () => {
      suspended = false;
      if (!disposed) {
        arm();
      }
    },
    dispose: () => {
      disposed = true;
      if (handle !== undefined) {
        timerFns.cancel(handle);
        handle = undefined;
      }
    },
  };
}

/**
 * FIX A — descendant network isolation. When `isolate` is true (the caller
 * already confirmed `isNamespaceIsolationAvailable()`), the connector
 * subprocess (and every descendant it spawns) runs inside
 * `spawnWithNetworkIsolation`'s fresh network namespace, and the replay
 * bridge is dialed over a Unix domain socket (`udsPath`, inside
 * `workspace.dir`) instead of TCP loopback — see isolation.ts's module
 * docstring for why TCP loopback can't cross that namespace boundary but a
 * UDS can. When `isolate` is false, this is the pre-existing plain-spawn +
 * TCP-loopback-bridge behavior, unchanged.
 */
/**
 * `preloadPath` is now computed by the CALLER (`runCollector`) rather than
 * always minting a fetch-bridge preload internally — the recorded-browser
 * driver needs a completely different preload
 * (`browser-har-replay.ts`'s `writeBrowserHarReplayPreload`, patching
 * patchright's `launchPersistentContext` instead of `node:http`/`fetch`)
 * while every other concern in this function — spawn, the inactivity
 * watchdog, stdout protocol accounting, and scripted-interaction replay —
 * is completely driver-agnostic and must not be duplicated. `bridgeUrl`/
 * `udsPath` remain fetch-bridge-specific (unused, and simply omitted from
 * env, for a browser-driven run — see `runCollector`'s
 * `browserPreloadPath` branch).
 */
function runReplaySubprocess(args: {
  bridgeUrl?: string;
  connectorPath: string;
  /** run.clock.fixed_now when the scenario recorded one — pins the
   *  subprocess's Date.now()/new Date() so wall-clock-dependent request
   *  planning replays deterministically. */
  fixedNow?: string;
  isolate: boolean;
  preloadPath: string;
  startState: Record<string, unknown> | null;
  streamNames: readonly string[];
  /** Inactivity watchdog window, in seconds — `--timeout` or
   *  `DEFAULT_INACTIVITY_WINDOW_SECONDS`. See this file's "Inactivity
   *  watchdog" section. */
  timeoutSeconds: number;
  udsPath?: string;
  userInteractions: readonly ScenarioUserInteraction[];
  workspace: ScenarioEvidenceWorkspace;
}): Promise<{ code: number | null; messages: ProtocolMessage[]; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const { preloadPath } = args;
    const child = spawnWithNetworkIsolation(process.execPath, ["--import", "tsx", args.connectorPath], {
      cwd: PACKAGE_ROOT,
      env: {
        ...subprocessEnv(),
        ...(args.fixedNow === undefined ? {} : { [PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV]: args.fixedNow }),
        ...(args.udsPath === undefined ? {} : { [PDPP_SCENARIO_BRIDGE_UDS_PATH_ENV]: args.udsPath }),
        NODE_OPTIONS: `--import ${preloadPath}`,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PATCHRIGHT_SKIP_BROWSER_DOWNLOAD ?? "",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
      isolate: args.isolate,
    });
    // `spawnWithNetworkIsolation` returns a plain `child_process.ChildProcess`
    // typed against the general `SpawnOptions` overload, so TS sees
    // stdin/stdout/stderr as nullable even though `stdio: ["pipe","pipe",
    // "pipe"]` above guarantees they're populated at runtime (isolation.ts
    // is owned by another lane — its return type isn't narrowed the way
    // node:child_process's literal-tuple `spawn` overload would be).
    const childStdin = child.stdin;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!(childStdin && childStdout && childStderr)) {
      rejectPromise(new Error("scenario-verify: spawned subprocess is missing a piped stdio stream"));
      return;
    }

    const protocol = new StdoutProtocolAccumulator();
    let stdoutBuffer = "";
    let stderr = "";
    let nextInteractionCursor = 0;
    let hardFailure: Error | null = null;
    // FIX 2: the most recent message's type/label and when it arrived, kept
    // for the watchdog's partial-evidence report — mirrors
    // `bin/scenario-record.ts`'s matching `lastMessageSeenAt`.
    let lastMessageSeenAt: { at: number; label: string; type: string } | undefined;
    const watchdog = createInactivityWatchdog(args.timeoutSeconds * 1000, () => {
      child.kill("SIGKILL");
      rejectPromise(
        new WatchdogTimeoutError(args.timeoutSeconds, {
          messages: protocol.messages,
          ...(lastMessageSeenAt === undefined ? {} : { lastMessageSeenAt }),
        })
      );
    });

    const failHard = (err: Error): void => {
      if (!hardFailure) {
        hardFailure = err;
      }
      child.kill("SIGKILL");
    };

    const answerScriptedInteraction = (raw: RawInteractionLine): void => {
      // P1-2 (seventh review): validate the ACTUAL prompt's wire shape
      // BEFORE comparing it against the recorded one or sending any
      // response — a malformed live INTERACTION (recognized kind, nonempty
      // request_id, string message, object schema when present, valid
      // timeout when present) is a protocol violation this CLI must reject
      // outright, the same fail-hard path an unscripted or exhausted
      // INTERACTION already takes, rather than being silently compared
      // field-by-field against a well-formed recorded prompt.
      try {
        assertValidInteractionMessage(raw);
      } catch (err) {
        failHard(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const recorded = args.userInteractions[nextInteractionCursor];
      if (!recorded) {
        failHard(
          new Error(
            `scenario replay: connector emitted an INTERACTION (kind=${raw.kind}, message=${JSON.stringify(raw.message)}) ` +
              `with no next recorded user_interactions entry left to answer it — the scenario's script is exhausted ` +
              `(${String(nextInteractionCursor)} already consumed).`
          )
        );
        return;
      }
      nextInteractionCursor += 1;
      // FIX C / P2-1: a credentials response is never persisted with a real
      // value, and (as of P2-1) neither is an OTP response UNLESS the
      // scenario was captured with `--persist-otp` — scenario-record stores
      // only {status, redacted: true} in either default case. Replaying it
      // scripted would answer with an absent value/data, which is not "the
      // recorded answer" in any meaningful sense — refuse outright with a
      // clear, named reason rather than silently answering with nothing.
      // `credentialsInteractionsAreNeverPersisted` names the credentials-
      // specific case exactly as before (a scenario-cli.test.ts assertion is
      // pinned to that literal string); an OTP-kind redacted entry gets its
      // own equally explicit reason instead of reusing the credentials
      // wording, which would be false for OTP (OTP IS persistable, just not
      // by default).
      if (recorded.response.redacted === true) {
        const reason =
          recorded.prompt.kind === "credentials"
            ? "credentials interactions are never persisted; re-record or supply live"
            : "this interaction was recorded without --persist-otp and is redacted; re-record with --persist-otp or supply live";
        failHard(
          new Error(
            `scenario replay: run has a redacted user_interactions entry (seq ${String(recorded.seq)}, kind=${recorded.prompt.kind}) — ${reason}`
          )
        );
        return;
      }
      // P1-2 (seventh review): compare the ACTUAL prompt against the
      // recorded one BEFORE sending the recorded response — a connector
      // whose live prompt drifted from what was recorded (a changed kind,
      // message, schema, or timeout) must fail loudly naming the first
      // differing field, not silently receive an answer scripted for a
      // DIFFERENT prompt. `request_id` is excluded (volatile, documented on
      // `firstInteractionPromptMismatch`); an unscripted/exhausted or
      // redacted-entry INTERACTION is already handled above this point, so
      // reaching here means `recorded` exists and is answerable.
      const mismatch = firstInteractionPromptMismatch(raw, recorded);
      if (mismatch) {
        failHard(
          new Error(
            `scenario replay: run has an INTERACTION prompt mismatch (seq ${String(recorded.seq)}, field=${mismatch.field}) — ${mismatch.detail}`
          )
        );
        return;
      }
      childStdin.write(`${JSON.stringify(scriptedInteractionResponse(raw.request_id, recorded))}\n`);
    };

    // Handles one already-JSON-parsed stdout line. Split out of the
    // `stdout.on("data")` handler purely to stay under this package's
    // cognitive-complexity lint ceiling — behavior is unchanged from the
    // inline version.
    const handleParsedLine = (parsed: ProtocolMessage): void => {
      lastMessageSeenAt = {
        at: Date.now(),
        type: (parsed as { type: string }).type,
        label: labelForMessage(parsed),
      };
      if (isRawInteractionLine(parsed)) {
        answerScriptedInteraction(parsed);
        return;
      }
      if (isDoneLine(parsed)) {
        // See bin/connector-dev.ts's matching comment: stdin stays open (not
        // `.end()`-ed at START time) so an INTERACTION_RESPONSE can reach the
        // child later; this CLI must end stdin once DONE is observed or
        // connector-exit.ts's flushAndExitAfterRuntimeAck hangs waiting for
        // an EOF nobody sends.
        childStdin.end();
      }
    };

    childStdout.on("data", (chunk: Buffer) => {
      // Activity — resets the inactivity window (replay's scripted
      // interaction answering never waits on a human, so this watchdog is
      // never suspended — see this file's "Inactivity watchdog" section).
      watchdog.touch();
      if (hardFailure) {
        return;
      }
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        try {
          const parsed = protocol.ingest(line);
          if (parsed) {
            handleParsedLine(parsed);
          }
        } catch (err) {
          failHard(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    childStderr.on("data", (chunk: Buffer) => {
      watchdog.touch();
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      watchdog.dispose();
      rejectPromise(err);
    });
    child.on("close", (code, signal) => {
      watchdog.dispose();
      if (hardFailure) {
        rejectPromise(hardFailure);
        return;
      }
      if (nextInteractionCursor < args.userInteractions.length) {
        const unconsumed = args.userInteractions.slice(nextInteractionCursor);
        rejectPromise(
          new Error(
            `scenario replay: ${String(unconsumed.length)} recorded user_interactions entry(ies) were never consumed ` +
              `(the connector emitted fewer INTERACTIONs than the scenario recorded): seq [${unconsumed.map((u) => u.seq).join(", ")}]`
          )
        );
        return;
      }
      // FIX 2 (d): a subprocess that exits nonzero, or is killed by a
      // signal, fails the run even when it managed to write a DONE with
      // status:"succeeded" first — a successful-looking DONE followed by a
      // crash (or being killed) is not a successful run. `signal !== null`
      // covers being killed by something other than this function's own
      // `failHard`/timeout paths (both of which already reject via a more
      // specific error above); a nonzero `code` covers a normal but failing
      // exit.
      // A failing connector reports its actual error through a failed DONE on
      // stdout (stderr is usually empty) — surface it, or the failure reads
      // as a bare exit code with no cause (e.g. the egress-denial error text
      // would otherwise never reach the operator).
      const lastDone = [...protocol.messages].reverse().find((m) => m.type === "DONE");
      const doneError = lastDone && lastDone.status !== "succeeded" ? `; DONE=${JSON.stringify(lastDone)}` : "";
      if (signal !== null) {
        rejectPromise(
          new Error(`scenario replay: subprocess was terminated by signal ${signal}${doneError}; stderr=${stderr}`)
        );
        return;
      }
      if (code !== 0) {
        rejectPromise(
          new Error(
            `scenario replay: subprocess exited with nonzero code ${String(code)}${doneError}; stderr=${stderr}`
          )
        );
        return;
      }
      resolvePromise({ code, messages: protocol.messages, stderr });
    });

    const startMessage = {
      type: "START",
      scope: { streams: args.streamNames.map((name) => ({ name })) },
      ...(args.startState === null ? {} : { state: args.startState }),
    };
    // NOT `.end()`: see the matching comment in bin/connector-dev.ts's
    // `runAndStream` — a scripted INTERACTION answer needs this same stdin.
    childStdin.write(`${JSON.stringify(startMessage)}\n`);
  });
}

function streamNamesFromScenario(scenario: ConnectorScenario, runIndex: number): string[] {
  const run = scenario.runs[runIndex];
  const scope = run?.start.scope;
  if (scope && typeof scope === "object" && "streams" in scope && Array.isArray(scope.streams)) {
    const { streams } = scope as { streams: Array<{ name?: unknown }> };
    return streams.map((s) => (typeof s.name === "string" ? s.name : "")).filter((name) => name.length > 0);
  }
  return [];
}

function printFailures(failures: readonly VerifyFailure[]): void {
  for (const f of failures) {
    const streamTag = f.stream ? ` [${f.stream}]` : "";
    process.stdout.write(`    - run ${String(f.runIndex)}${streamTag} ${f.kind}: ${f.detail}\n`);
  }
}

/** Every stream name declared in a manifest's `streams` array, read
 *  defensively (a manifest is external JSON, not a type-checked value). */
function declaredStreamNamesFromManifest(manifest: Record<string, unknown>): string[] {
  if (!Array.isArray(manifest.streams)) {
    return [];
  }
  return manifest.streams
    .map((s) =>
      s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string"
        ? (s as { name: string }).name
        : ""
    )
    .filter((name) => name.length > 0);
}

/**
 * FIX 4's informational (never failing) exercised-vs-declared line: which of
 * the connector's manifest-declared streams this scenario's runs actually
 * expected at least one record for. Every stream name across every run's
 * `expected.records` counts as "exercised" — a scenario proving coverage for
 * a stream in run 2 but not run 0 still exercised it. Skipped entirely in
 * `--entrypoint` mode (no manifest to compare against).
 */
function printStreamCoverageLine(args: CliArgs, scenario: ConnectorScenario): void {
  if (args.entrypoint) {
    return;
  }
  const declared = declaredStreamNamesFromManifest(readManifest(args.connector));
  const exercised = new Set<string>();
  for (const run of scenario.runs) {
    for (const streamName of Object.keys(run.expected.records)) {
      exercised.add(streamName);
    }
  }
  const missing = declared.filter((name) => !exercised.has(name));
  const missingSuffix = missing.length > 0 ? ` (missing: ${missing.join(", ")})` : "";
  process.stdout.write(
    `streams exercised: ${String(exercised.size)} of ${String(declared.length)} declared${missingSuffix}\n`
  );
}

/** Cleans up the evidence workspace and re-throws `stashed` when set — the
 *  shared tail of `main`'s watchdog-kill and browser-replay-evidence-error
 *  handling (see their declaration-site comments above `main`). A no-op
 *  when `stashed` is `undefined` (neither fired). */
function rethrowStashedPreflightError(
  workspace: ScenarioEvidenceWorkspace,
  stashed: WatchdogTimeoutError | BrowserReplayEvidenceError | undefined
): void {
  if (!stashed) {
    return;
  }
  cleanupScenarioEvidenceWorkspace(workspace);
  throw stashed;
}

/**
 * The one-line "replay time" banner `main()` prints once per scenario —
 * extracted to a pure function so the driver-mix branching (three cases:
 * recorded-http only, recorded-browser only, or both in the same scenario)
 * doesn't push `main()` over this file's cognitive-complexity budget. See
 * the call site's doc comment for why the message must vary by driver:
 * `recorded-http` replay scales pacing/backoff timers 100x
 * (writeReplayBridgePreload); `recorded-browser` replay does not (browser-
 * har-replay.ts's preload — Playwright/patchright's own internal timeouts
 * share the same global setTimeout, so scaling it would break them, per
 * that file's module doc comment).
 */
function replayTimeBannerLine(declaredDrivers: readonly ("recorded-http" | "recorded-browser")[]): string {
  const hasRecordedHttpRun = declaredDrivers.includes("recorded-http");
  const hasRecordedBrowserRun = declaredDrivers.includes("recorded-browser");
  if (hasRecordedHttpRun && hasRecordedBrowserRun) {
    return "replay time: recorded-http runs scaled 100x (pacing/backoff compressed); recorded-browser runs run in real time (Playwright's own timeouts share the same clock)";
  }
  if (hasRecordedHttpRun) {
    return "replay time: scaled 100x (pacing/backoff compressed; recorded responses need no provider protection)";
  }
  if (hasRecordedBrowserRun) {
    return "replay time: real time (recorded-browser: Playwright's own per-call timeouts share the connector's global clock, so pacing/backoff is not compressed)";
  }
  // No driver declared on any run at all (legacy scenario, or a
  // hand-assembled one) — neither claim applies; caller prints nothing.
  return "";
}

/** Writes `replayTimeBannerLine`'s result to stdout, or nothing at all when
 *  no driver is declared — pulled out of `main()` alongside the line-
 *  computation function itself so the call site is a single statement
 *  (this file's cognitive-complexity budget is otherwise exceeded by the
 *  three-way driver-mix branching). */
function printReplayTimeBanner(declaredDrivers: readonly ("recorded-http" | "recorded-browser")[]): void {
  const line = replayTimeBannerLine(declaredDrivers);
  if (line) {
    process.stdout.write(`${line}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectorPath = resolveConnectorPath(args);
  const scenario = loadScenario(args.scenarioPath);

  // FIX 3: identity binding — fails BEFORE any subprocess is spawned.
  // Errors here are treated the same as the loadScenario/parseArgs failures
  // above: a fatal, pre-flight rejection, not a per-run verification
  // failure.
  try {
    assertConnectorIdentity(args, scenario);
    // FIX 5 — modality-neutral envelope: same pre-flight tier as identity
    // above, fails before any subprocess is spawned.
    assertSupportedEnvironmentDrivers(scenario);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[scenario-verify] FATAL: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`VERIFYING ${args.connector} against ${args.scenarioPath}\n`);
  process.stdout.write(`  runs: ${String(scenario.runs.length)}\n`);
  // FIX 5: prints the declared driver(s) — "recorded-http" and/or
  // "recorded-browser" for every run this build's recorders produce, or
  // "(none declared)" for a legacy scenario with no `environment` field at
  // all on any run.
  const declaredDrivers = [
    ...new Set(
      scenario.runs
        .map((run) => run.environment?.network?.driver)
        .filter((d): d is "recorded-http" | "recorded-browser" => d !== undefined)
    ),
  ];
  process.stdout.write(`  driver: ${declaredDrivers.length > 0 ? declaredDrivers.join(", ") : "(none declared)"}\n`);

  // FIX D — digest model split: reported by default (never fails), or
  // strict (throws before any subprocess is spawned) under
  // --require-capture-source. Still entirely pre-flight, same as identity
  // above. The returned observation feeds FIX 1's claim-eligibility
  // evaluator (src/scenario/claims.ts) further down, once verification
  // itself has passed.
  let digestObservation: CaptureSourceDigestObservation;
  try {
    digestObservation = reportCaptureSourceDigests(args, scenario);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[scenario-verify] FATAL: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  // FIX A — descendant network isolation, probed ONCE up front (a single
  // `unshare -r -n true` test-spawn — see isolation.ts's module docstring
  // for why this can't be inferred cheaply from sysctls) and reused for
  // every run in this scenario, rather than re-probing per run. Replay MUST
  // be offline: when isolation is available every run is namespace-isolated
  // over a UDS bridge; when it is not, this CLI still runs (falls back to
  // the pre-existing process-local JS-layer-only denial) but says so
  // honestly, both on stdout as each run starts and in the final claims
  // block, rather than silently claiming a stronger guarantee than what
  // actually happened.
  const isolationCapability: NamespaceIsolationCapability = isNamespaceIsolationAvailable();
  const isolationLine = isolationCapability.available
    ? "network isolation: os-namespace"
    : `network isolation: process-local only (${isolationCapability.reason})`;
  process.stdout.write(`  ${isolationLine}\n`);
  // Every replayed response is served from the recording, not a live
  // provider, so a connector's own pacing/backoff timers (governor pacing,
  // an inline PAGE_DELAY sleep, anything else built on setTimeout/
  // setInterval) have nothing left to protect — for `recorded-http` runs.
  // `recorded-browser` runs do NOT get the same treatment (Playwright/
  // patchright's own internal timeouts share the same global clock) — see
  // `replayTimeBannerLine`'s doc comment for the full reasoning. Printed
  // once per scenario, reflecting what actually applies given the drivers
  // THIS scenario declares, rather than a single claim that would be false
  // whenever any run is recorded-browser.
  printReplayTimeBanner(declaredDrivers);
  const isolationWorkspace = createScenarioEvidenceWorkspace();

  // FIX 2d (repair wave 4): every run's raw messages, accumulated across the
  // whole scenario, so `printCoverageReport` can feed them through
  // `observedUnsupportedEvidenceSurface` (verify.ts) once verification
  // finishes. Threaded here (rather than re-derived from `result`) because
  // `VerifyResult`/`VerifyFailure` deliberately don't carry raw per-message
  // payloads — only the normalized trace comparison outcome — so this is the
  // one place the CLI still has the actual message objects in hand.
  const allRunMessages: RawTraceMessage[] = [];

  // FIX 2: `src/scenario/verify.ts`'s `verifyRun` wraps every `runCollector`
  // call in its own try/catch and folds ANY thrown error into a per-run
  // `replay_mismatch` VerifyFailure (a shared module this CLI doesn't own —
  // see this file's module docstring on why record/verify don't share a
  // runtime module). A watchdog kill is not an ordinary replay mismatch —
  // it means this run's evidence is INCOMPLETE, not merely inconsistent —
  // so it must not be reported through the normal per-run FAIL listing.
  // Stashed here the moment it's thrown, then re-thrown AFTER
  // `verifyScenario` returns (see `main`'s call site below) so it reaches
  // this CLI's top-level `main().catch()` — the same plain-verdict path
  // `ScenarioValidationError` already takes at that catch site — instead of
  // being buried in the ordinary failure report.
  let watchdogTimeout: WatchdogTimeoutError | undefined;
  // Mirrors `watchdogTimeout` above exactly, for the same reason: a missing/
  // unreadable browser-replay evidence file (HAR or storage state) is a
  // diagnosed pre-flight verdict — not an ordinary per-run replay mismatch —
  // and `verifyRun` (verify.ts) would otherwise fold it into `replay_mismatch`
  // just like it folds a watchdog kill. Stashed here, re-thrown after
  // `verifyScenario` returns so it reaches `main().catch()`'s plain-verdict
  // handling instead.
  let browserReplayEvidenceError: BrowserReplayEvidenceError | undefined;

  // Emits this run's replay result (records/state/trace) into the collector
  // and the outer `allRunMessages` accumulator. Split out of `runCollector`
  // purely to stay under this package's cognitive-complexity lint ceiling —
  // behavior is unchanged from the inline version.
  const emitReplayResult = (
    runIndex: number,
    replayResult: { code: number | null; messages: ProtocolMessage[]; stderr: string },
    emit: RunCollectorEmit
  ): void => {
    const done = replayResult.messages.find((m) => m.type === "DONE");
    if (done?.status !== "succeeded") {
      throw new Error(
        `replay run ${String(runIndex)} did not reach a succeeded DONE: ${JSON.stringify(done)}; stderr=${replayResult.stderr}`
      );
    }
    const { records, stateMessages } = messagesToRecordsAndState(replayResult.messages);
    for (const r of records) {
      emit({ type: "RECORD", stream: r.stream, id: r.id, data: r.data, op: r.op });
    }
    for (const s of stateMessages) {
      emit({ type: "STATE", stream: s.stream, cursor: s.cursor });
    }
    // FIX 1 — protocol-trace oracle: every raw message this run's real
    // subprocess emitted is fed through as a TRACE entry — verify.ts's
    // `verifyRun` normalizes them (via `buildProtocolTrace`, the same
    // function bin/scenario-record.ts uses to build the expected trace)
    // and compares against `run.expected.protocol_trace` when present.
    // `replayResult.messages` is untyped parsed JSON cast to the narrower
    // `ProtocolMessage`; the fields `normalizeTraceMessage` reads (reason/
    // message/stream/status/error/...) are present on the underlying JSON
    // even though that type doesn't model them — the same cast
    // `messagesToRecordsAndState` above already relies on for its own
    // fields.
    for (const raw of replayResult.messages as unknown as RawTraceMessage[]) {
      const { type: rawType, ...rest } = raw;
      emit({ type: "TRACE", rawType, ...rest });
    }
    // FIX 2d: accumulate this run's raw messages (every kind, not just the
    // seven tracked ones) so the ASSISTANCE/ASSISTANCE_STATUS withholding
    // check below can see them — `TRACE_POLICY`'s
    // `"unsupported_claim_withheld"` disposition applies to kinds this
    // trace oracle otherwise never normalizes at all.
    allRunMessages.push(...(replayResult.messages as unknown as RawTraceMessage[]));
  };

  /**
   * Runs one run's replay via the recorded-browser driver — no fetch-bridge
   * server at all (this driver's traffic never touches the connector Node
   * process's own fetch/http/net; see browser-har-replay.ts's module doc
   * comment), just `writeBrowserHarReplayPreload`'s patchright-launch patch.
   * Pre-flight evidence resolution (`resolveBrowserEvidence`) runs BEFORE
   * any subprocess spawns, same tier as this file's other pre-flight checks
   * — a `BrowserReplayEvidenceError` here is a diagnosed verdict, not a
   * crash (see `main().catch()`'s handling below).
   */
  const runBrowserCollector = async (
    runIndex: number,
    collectorArgs: { emit: RunCollectorEmit; state: unknown }
  ): Promise<void> => {
    const run = scenario.runs[runIndex];
    if (!run) {
      throw new Error(`scenario replay: run ${String(runIndex)} not found`);
    }
    const scenarioDir = dirname(resolve(args.scenarioPath));
    let evidence: ReturnType<typeof resolveBrowserEvidence>;
    try {
      evidence = resolveBrowserEvidence(scenarioDir, run);
    } catch (err) {
      if (err instanceof BrowserReplayEvidenceError) {
        browserReplayEvidenceError = err;
      }
      throw err;
    }
    // Written into this package's own gitignored tmp/, NOT isolationWorkspace
    // — see browser-har-replay.ts's module doc comment on `packageScratchDir`
    // for why: this preload's generated `import("patchright")` needs
    // package-tree resolution, which isolationWorkspace's os.tmpdir()-rooted
    // mkdtemp directory can never provide. Cleaned up in the `finally` below
    // (mirrors 2b674fdf1's cleanup discipline for the same defect class in
    // bin/scenario-cli.test.ts) since, unlike isolationWorkspace, nothing
    // else owns removing it.
    const preloadPath = writeBrowserHarReplayPreload(evidence);
    let result: { code: number | null; messages: ProtocolMessage[]; stderr: string };
    try {
      result = await runReplaySubprocess({
        connectorPath,
        preloadPath,
        ...(evidence.fixedNowIso === undefined ? {} : { fixedNow: evidence.fixedNowIso }),
        startState: isPlainStateRecord(collectorArgs.state) ? collectorArgs.state : null,
        streamNames: streamNamesFromScenario(scenario, runIndex),
        timeoutSeconds: args.timeoutSeconds,
        userInteractions: run.user_interactions ?? [],
        isolate: isolationCapability.available,
        workspace: isolationWorkspace,
      });
    } catch (err) {
      if (err instanceof WatchdogTimeoutError) {
        watchdogTimeout = err;
      }
      throw err;
    } finally {
      rmSync(preloadPath, { force: true });
    }
    emitReplayResult(runIndex, result, collectorArgs.emit);
  };

  const runCollector = async (
    runIndex: number,
    collectorArgs: { emit: RunCollectorEmit; fetch: typeof fetch; state: unknown }
  ): Promise<void> => {
    if (scenario.runs[runIndex]?.environment?.network?.driver === "recorded-browser") {
      await runBrowserCollector(runIndex, collectorArgs);
      return;
    }
    const udsPath = isolationCapability.available
      ? join(isolationWorkspace.dir, `bridge-${String(runIndex)}.sock`)
      : undefined;
    const bridge = await startFetchBridgeServer(collectorArgs.fetch, udsPath);
    try {
      const fixedNow = scenario.runs[runIndex]?.clock?.fixed_now;
      const preloadPath = writeReplayBridgePreload(bridge.url, {
        workspace: isolationWorkspace,
        ...(udsPath === undefined ? {} : { udsSocketPath: udsPath }),
      });
      let result: { code: number | null; messages: ProtocolMessage[]; stderr: string };
      try {
        result = await runReplaySubprocess({
          connectorPath,
          bridgeUrl: bridge.url,
          preloadPath,
          ...(fixedNow === undefined ? {} : { fixedNow }),
          startState: isPlainStateRecord(collectorArgs.state) ? collectorArgs.state : null,
          streamNames: streamNamesFromScenario(scenario, runIndex),
          timeoutSeconds: args.timeoutSeconds,
          userInteractions: scenario.runs[runIndex]?.user_interactions ?? [],
          isolate: isolationCapability.available,
          workspace: isolationWorkspace,
          ...(udsPath === undefined ? {} : { udsPath }),
        });
      } catch (err) {
        if (err instanceof WatchdogTimeoutError) {
          watchdogTimeout = err;
        }
        throw err;
      }
      emitReplayResult(runIndex, result, collectorArgs.emit);
    } finally {
      await bridge.close();
    }
  };

  let result: VerifyResult;
  try {
    result = await verifyScenario(scenario, runCollector);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[scenario-verify] FATAL: ${message}\n`);
    process.exitCode = 1;
    cleanupScenarioEvidenceWorkspace(isolationWorkspace);
    return;
  }
  // FIX 2 / browser-replay-evidence: `verifyScenario` swallowed a watchdog
  // kill OR a missing/unusable browser-replay evidence file into an ordinary
  // per-run `replay_mismatch` failure (see `runCollector`'s and
  // `browserReplayEvidenceError`'s declaration-site comments above) —
  // re-throw whichever fired now so it reaches `main().catch()`'s dedicated
  // plain-verdict handling instead of the normal FAIL report below. Combined
  // into one helper (rather than two separate `if` blocks inline in `main`)
  // purely to keep `main`'s own cognitive complexity under this package's
  // lint ceiling — behavior is unchanged from two inline checks.
  rethrowStashedPreflightError(isolationWorkspace, watchdogTimeout ?? browserReplayEvidenceError);

  for (let runIndex = 0; runIndex < scenario.runs.length; runIndex += 1) {
    const runFailures = result.failures.filter((f) => f.runIndex === runIndex);
    process.stdout.write(`  run ${String(runIndex)}: ${runFailures.length === 0 ? "PASS" : "FAIL"}\n`);
    if (runFailures.length > 0) {
      printFailures(runFailures);
    }
  }

  const userInteractionCount = scenario.runs.reduce((sum, run) => sum + (run.user_interactions?.length ?? 0), 0);
  process.stdout.write(`\n  interactions replayed: ${String(result.metrics.interactionCount)}\n`);
  process.stdout.write(`  user_interactions replayed: ${String(userInteractionCount)}\n`);
  process.stdout.write(`  normalizers: ${String(result.metrics.normalizerCount)}\n`);
  // FIX 1 — protocol-trace oracle: backward-compat print line. A scenario
  // captured before this field existed has `expected.protocol_trace ===
  // undefined` on every run — verify.ts's `verifyRun` skips the trace
  // comparison entirely for such a run (see that function's doc comment),
  // so this line makes that silent skip visible rather than leaving an
  // operator to wonder why no trace-related output appeared at all.
  const tracedRunCount = scenario.runs.filter((run) => run.expected.protocol_trace !== undefined).length;
  process.stdout.write(
    tracedRunCount > 0
      ? `  protocol trace: captured (${String(tracedRunCount)} of ${String(scenario.runs.length)} run(s))\n`
      : "  protocol trace: not captured (legacy scenario)\n"
  );

  cleanupScenarioEvidenceWorkspace(isolationWorkspace);

  if (!result.pass) {
    process.stdout.write(`\nFAIL — ${result.failures.length} failure(s) across ${scenario.runs.length} run(s)\n`);
    process.exitCode = 1;
    return;
  }

  printCoverageReport(
    args,
    scenario,
    isolationLine,
    digestObservation,
    isolationCapability,
    observedUnsupportedEvidenceSurface(allRunMessages)
  );
  process.exitCode = 0;
}

/**
 * Determines and prints the `recorded_replay`/`coverage`/exercised-streams
 * report for a scenario that has already passed every per-run check (this
 * function is only ever called after `result.pass` is confirmed true).
 * Split out of `main` purely to keep `main`'s own cognitive complexity under
 * this package's lint ceiling — behavior is unchanged from the inline
 * version.
 *
 * FIX 1 (P1-1, repair wave 3A): a passing verification no longer
 * unconditionally prints `recorded_replay: PASS`. `evaluateClaimEligibility`
 * (src/scenario/claims.ts) decides, from the SAME facts this function
 * already has in hand (entrypoint mode, the digest observation, the declared
 * environment drivers, protocol_trace presence, and whether OS-namespace
 * isolation was actually active for this replay), whether the stronger
 * `recorded_replay` claim is honest. When it isn't, this prints the weaker
 * `diagnostic_replay: PASS` / `recorded_replay: WITHHELD` pair with the
 * specific `limitations` that caused the downgrade, plus a machine-readable
 * `claim:` line so a caller can branch on the decision without re-parsing
 * prose. `scenario status: candidate oracle` is printed unconditionally
 * (P2-2's machine-readable state — promotion machinery is future work).
 */
function printCoverageReport(
  args: CliArgs,
  scenario: ConnectorScenario,
  isolationLine: string,
  digestObservation: CaptureSourceDigestObservation,
  isolationCapability: NamespaceIsolationCapability,
  observedUnsupportedEvidenceSurfaceFlag: boolean
): void {
  const capturedAt = scenario.capture.captured_at;
  // state_seeded_second_run_with_changed_requests (formerly named
  // incremental_two_run — renamed per the evidence-claims re-review: the old
  // name overclaimed "incremental" behavior the harness cannot actually
  // prove, only that a later run was seeded from an earlier run's committed
  // state AND its recorded requests differ from run 1's — i.e. cursor
  // advancement was OBSERVABLE, not just "two runs existed"; see
  // docs/reference/connector-evidence-claims.md) is only claimed under that
  // narrower, honestly-named condition.
  //
  // A THIRD condition, added here: the seeding run's own `expected.
  // final_state` must be non-trivial (not null/undefined, and if an object,
  // at least one key). Without this, a scenario could satisfy the first two
  // conditions vacuously — e.g. run 0 commits final_state: null (or {}) and
  // run 1 is "seeded" from it (state_from_run: 0), then makes some
  // differently-shaped request for an unrelated reason. That is NOT proof
  // the connector correctly narrowed its query using a real prior cursor —
  // there was no real prior cursor to narrow from. This claim is about
  // cursor-based narrowing specifically, and that claim requires an actual
  // non-empty cursor to have been narrowed from.
  const firstRunRequests = JSON.stringify(scenario.runs[0]?.interactions.map((i) => i.request) ?? []);
  let requestsDifferedSomewhere = false;
  let vacuousSeedSomewhere = false;
  const incrementalProven = scenario.runs.some((run, index) => {
    if (!(index > 0 && run.start.state_from_run !== undefined)) {
      return false;
    }
    if (JSON.stringify(run.interactions.map((i) => i.request)) === firstRunRequests) {
      return false;
    }
    requestsDifferedSomewhere = true;
    const seedingRun = scenario.runs[run.start.state_from_run];
    const nonTrivialSeed = seedingRun !== undefined && isNonTrivialFinalState(seedingRun.expected.final_state);
    if (!nonTrivialSeed) {
      vacuousSeedSomewhere = true;
    }
    return nonTrivialSeed;
  });
  // empty_state_run (formerly named full_refresh — renamed per the
  // evidence-claims re-review: "full_refresh" implied a from-scratch
  // collection semantic this harness doesn't verify; the honest claim is
  // narrower — run 0 started from a genuinely empty seed state and actually
  // did something with it) is only claimed when run 0 actually PROVES that,
  // not merely "a scenario with runs exists". Three conditions, all
  // required: run 0's seed state is exactly null (a real empty-state start,
  // not a seeded run someone mislabeled), run 0 exercised at least one
  // interaction (it isn't a vacuous no-op — verifyRun's own vacuous_run
  // check already rejects an ALL-zero run, but this claim additionally needs
  // its OWN run 0 to have done something even if a later run in the same
  // scenario is what saved it from vacuous_run), and run 0 actually expects
  // at least one record across its declared streams (a run that made
  // requests but expected zero records proves connectivity, not an
  // empty-state collection).
  const [run0] = scenario.runs;
  const run0ExpectedRecordCount = Object.values(run0?.expected.records ?? {}).reduce(
    (sum, stream) => sum + stream.count,
    0
  );
  const fullRefreshProven =
    run0 !== undefined && run0.start.state === null && run0.interactions.length >= 1 && run0ExpectedRecordCount >= 1;
  const coverage = [
    ...(fullRefreshProven ? ["empty_state_run"] : []),
    ...(incrementalProven ? ["state_seeded_second_run_with_changed_requests"] : []),
  ];

  // Repair wave 6 (P1-1) — driver-evidence prerequisite: EVERY distinct
  // driver declared across this scenario's runs must satisfy its own
  // `DRIVER_EVIDENCE_POLICIES` entry (wire-registry.ts). In practice this
  // scenario only reaches here with a single distinct driver, because
  // condition (d) below already requires every run to declare
  // `recorded-http` for the strongest claim to be reachable at all — but
  // this is computed independently (not short-circuited on condition (d))
  // so the specific "no recorded provider interaction" limitation is always
  // named precisely, rather than folded into the coarser "driver not
  // declared" wording. A scenario with NO driver declared anywhere is
  // treated as unsatisfied too (matches `driverEvidenceSatisfied`'s
  // fail-closed posture for `driver: undefined`).
  const declaredScenarioDrivers = [...new Set(scenario.runs.map((run) => run.environment?.network?.driver))];
  const driverEvidenceOk =
    declaredScenarioDrivers.length > 0 &&
    declaredScenarioDrivers.every((driver) => driverEvidenceSatisfied(driver, scenario));

  // FIX 1 (P1-1) — claim-eligibility gate: decides whether this passing
  // verification may print the stronger `recorded_replay: PASS` claim, or
  // only the weaker `diagnostic_replay: PASS`. See this function's own doc
  // comment and src/scenario/claims.ts's module doc for the full rationale.
  const decision = evaluateClaimEligibility({
    scenario,
    isEntrypointOverride: Boolean(args.entrypoint),
    capturedDeclarationDigestPresent: digestObservation.capturedDeclarationDigestPresent,
    capturedSourceDigestPresent: digestObservation.capturedSourceDigestPresent,
    currentDeclarationDigestComputed: digestObservation.currentDeclarationDigestComputed,
    currentSourceDigestComputed: digestObservation.currentSourceDigestComputed,
    isNamespaceIsolationActive: isolationCapability.available,
    observedUnsupportedEvidenceSurface: observedUnsupportedEvidenceSurfaceFlag,
    driverEvidenceSatisfied: driverEvidenceOk,
  });
  if (decision.claim === "recorded_replay") {
    process.stdout.write(`\nrecorded_replay: PASS (captured ${capturedAt})\n`);
  } else {
    process.stdout.write(`\ndiagnostic_replay: PASS (captured ${capturedAt})\n`);
    process.stdout.write("recorded_replay: WITHHELD\n");
    process.stdout.write("limitations:\n");
    for (const limitation of decision.limitations) {
      process.stdout.write(`  - ${limitation}\n`);
    }
  }
  process.stdout.write(`claim: ${decision.claim}\n`);
  process.stdout.write("scenario status: candidate oracle\n");
  process.stdout.write(`coverage: ${coverage.length > 0 ? coverage.join(", ") : "(none)"}\n`);
  process.stdout.write(`${isolationLine}\n`);
  printStreamCoverageLine(args, scenario);
  if (scenario.runs.length >= 2 && !incrementalProven) {
    // Three distinct, non-overlapping reasons
    // state_seeded_second_run_with_changed_requests can go unclaimed even
    // with multiple runs present: the later run's requests never actually
    // differed (the original check), they differed but the run they claim to
    // be seeded from never committed a real (non-vacuous) prior state (this
    // fix's new check), or neither ran into either specific case for some
    // other combination of runs — printing the wrong one would be actively
    // misleading, not just imprecise.
    let note: string;
    if (vacuousSeedSomewhere) {
      note =
        "note: a later run is marked state_from_run but the seeding run's committed final_state is vacuous (null/empty) - incremental behavior was not demonstrated from a real prior cursor, so state_seeded_second_run_with_changed_requests is not claimed\n";
    } else if (requestsDifferedSomewhere) {
      note =
        "note: multiple runs present and a seeded run's requests differ, but no run satisfies every state_seeded_second_run_with_changed_requests condition - state_seeded_second_run_with_changed_requests is not claimed\n";
    } else {
      note =
        "note: multiple runs present but the later run's requests are identical to run 1's - incremental behavior was not demonstrated, so state_seeded_second_run_with_changed_requests is not claimed\n";
    }
    process.stdout.write(note);
  }
}

// Only run when this module is the process entrypoint (`tsx bin/scenario-
// verify.ts ...`), not when it's `import`ed for its pure/testable exports —
// mirrors `bin/connector-dev.ts`'s identical guard and
// `bin/scenario-record.ts`'s matching guard (see either file's doc comment
// for the full rationale): before this guard,
// `bin/scenario-cli.test.ts`'s direct unit-import of
// `createInactivityWatchdog` ran the ENTIRE CLI as a side effect of module
// load (including `usageAndExit(2)` on the test process's own argv). Every
// existing subprocess-driven test already runs this file as the real
// entrypoint via `spawnSync(..., ["--import", "tsx", VERIFY_CLI_PATH,
// ...])`, so `process.argv[1]` is that exact path in every case that
// matters — this guard changes nothing for them.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    // A validation rejection is a user-facing pre-flight verdict, not a
    // crash: print its message plainly, no stack. Observed live: an
    // operator passed a run-summary file (the other artifact living in
    // runs/) and got a stack trace for what the validator had already
    // precisely diagnosed.
    if (err instanceof ScenarioValidationError) {
      process.stderr.write(`[scenario-verify] ${err.message}\n`);
      if (err.message.includes("pdpp.run-summary/1")) {
        process.stderr.write("hint: that file is a run summary written by connector-dev, not a scenario.\n");
        // Observed live: the summary was the ONLY file in runs/<connector>/
        // because no scenario had ever been recorded - so point at what
        // exists, or at the command that creates what doesn't.
        try {
          const retryArgs = parseArgs(process.argv.slice(2));
          const dir = dirname(resolve(retryArgs.scenarioPath));
          const scenarios = readdirSync(dir).filter((f) => f.endsWith("-scenario.json"));
          if (scenarios.length > 0) {
            process.stderr.write(`hint: scenario files in ${dir}:\n`);
            for (const f of scenarios.sort().slice(-3)) {
              process.stderr.write(`        ${join(dir, f)}\n`);
            }
          } else {
            process.stderr.write(
              "hint: no scenario files exist there yet - record one first:\n" +
                `        pnpm exec tsx bin/scenario-record.ts ${retryArgs.connector}\n`
            );
          }
        } catch {
          // Best-effort guidance only - the validation verdict above stands alone.
        }
      }
      process.exitCode = 1;
      return;
    }
    // FIX 2: a watchdog kill is a diagnosed verdict — the subprocess was
    // observed to be genuinely inactive for the whole window — not a crash
    // in this CLI's own code, so it prints plainly (no stack), the same
    // plain-verdict treatment `ScenarioValidationError` gets just above.
    if (err instanceof WatchdogTimeoutError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    // Same plain-verdict treatment as ScenarioValidationError/
    // WatchdogTimeoutError above — see browser-har-replay.ts's
    // `BrowserReplayEvidenceError` doc comment: a missing/unusable HAR or
    // storage-state file is a diagnosed pre-flight verdict naming exactly
    // what's missing, not a crash in this CLI's own code.
    if (err instanceof BrowserReplayEvidenceError) {
      process.stderr.write(`[scenario-verify] ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[scenario-verify] FATAL: ${message}\n`);
    process.exitCode = 1;
  });
}
