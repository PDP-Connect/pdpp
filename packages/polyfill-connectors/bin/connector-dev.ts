#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * connector-dev — the "run and watch it work" developer command.
 *
 * Runs ONE connector exactly the way production runs it: spawn the
 * connector's own entrypoint (`node --import tsx connectors/<name>/index.ts`)
 * and drive the Collection Profile protocol (START on stdin, JSONL
 * RECORD/STATE/SKIP_RESULT/PROGRESS/INTERACTION/ASSISTANCE/DONE on stdout)
 * over stdio — the exact spawn shape `runConnectorProtocolSubprocess`
 * (src/test-harness.ts) uses to prove connectors in tests, and the same
 * per-connector entrypoint `bin/orchestrate.ts` resolves via
 * `getConnectorPaths`/`readManifest` (src/orchestrator.ts). No parallel
 * runner: this file adds live human-readable streaming and a mechanical
 * run-summary artifact on top of that path, it does not reimplement it.
 *
 * Deliberately does NOT start the embedded personal server or register a
 * manifest the way `orchestrate.ts run` does — this is a local dev loop for
 * watching ONE connector's collect() behavior against its real upstream
 * (auth resolved from process.env, same as production), not an end-to-end
 * ingest proof. Records are not persisted anywhere but the printed stream
 * and the run-summary file; nothing is written to an RS.
 *
 * Usage:
 *   pnpm exec tsx bin/connector-dev.ts <connector> [--summary-out <path>]
 *     [--answer <id-or-index>=<value>]... [--answers <json-file>]
 *     [--streams <name,name,...>] [--seed-last-state]
 *
 * Example:
 *   pnpm exec tsx bin/connector-dev.ts ynab
 *   pnpm exec tsx bin/connector-dev.ts gmail --summary-out /tmp/gmail-run.json
 *   pnpm exec tsx bin/connector-dev.ts reddit --answer 0=123456
 *   pnpm exec tsx bin/connector-dev.ts ynab --streams transactions,accounts
 *   pnpm exec tsx bin/connector-dev.ts ynab --seed-last-state
 *
 * ─── `--streams <a,b,c>` ───────────────────────────────────────────────────
 *
 * Stream scoping is not a new concept: `START.scope.streams` already tells a
 * connector's `collect()` which of its manifest-declared streams to touch
 * (`connector-runtime.ts`'s `requested` map, built from `scope.streams`).
 * This flag only exposes that existing knob at the CLI: it filters the
 * manifest's own stream list down to the named subset before building
 * `START.scope`, rather than always sending every declared stream. An
 * unknown name fails fast, before spawning the connector, printing the
 * manifest's actual stream names.
 *
 * Motivating case: a real `ynab` run took 75 minutes, dominated by one
 * paced stream (see run-summary.ts's `elapsed_ms` doc comment — 140 monthly
 * windows at the connector's audited ~20s/request ceiling). Scoping to
 * `--streams transactions,accounts` while iterating on those streams turns
 * that into a run of minutes, without touching the slow stream at all.
 *
 * ─── `--seed-last-state` ───────────────────────────────────────────────────
 *
 * State seeding is not a new concept either: `START.state` already carries
 * per-stream cursors a connector's `collect()` reads to run incrementally
 * instead of from scratch (see `connector-runtime.ts`'s `startMsg.state`).
 * This flag reuses that existing mechanism across separate `connector-dev`
 * invocations: on every DONE, this CLI writes the run's final per-stream
 * STATE cursors to `runs/<connector>/last-state.json` (local-only —
 * `runs/` is gitignored, same as the run-summary artifacts already written
 * there). `--seed-last-state` reads that file back into `START.state` for
 * the next run, so a developer's second-and-later runs are naturally
 * incremental/short instead of always starting from empty state. Absent a
 * prior file, the flag fails with a clear message rather than silently
 * falling back to a full run.
 *

 * `--entrypoint <path>` is a dev/test-only override that bypasses the
 * `KNOWN_CONNECTOR_NAMES` manifest-registry lookup and runs the given file
 * directly (streams default to a single synthetic `items` stream). It
 * exists so the integration test (bin/connector-dev.test.ts) can drive this
 * CLI end-to-end, as a real subprocess, against a test-only fixture
 * connector without registering that fixture as a production connector —
 * mirrors the `--command`/`--args` override `bin/collector-runner.ts`
 * already offers for the same reason.
 *
 * Exit code: 0 on a succeeded DONE; non-zero (with the failure kind printed)
 * on a failed DONE, a child that exits without DONE, or a spawn error.
 *
 * ─── Interaction answering ────────────────────────────────────────────────
 *
 * When the subprocess emits an INTERACTION (connector-runtime-protocol.ts's
 * `EmittedMessage` variant with `type: "INTERACTION"` — kinds `credentials`,
 * `otp`, `manual_action`), this CLI answers it and writes the response back
 * over the subprocess's stdin as an INTERACTION_RESPONSE, exactly the shape
 * `sendInteraction` in src/connector-runtime.ts parses off stdin (matches on
 * `type === "INTERACTION_RESPONSE"` and `request_id`).
 *
 * Three answer sources, in priority order:
 *   1. `--answer <id-or-index>=<value>` (repeatable) / `--answers <json-file>`
 *      (a `{ [idOrIndex]: value }` map) — pre-supplied answers, matched first
 *      by the INTERACTION's own `request_id`, then by its 0-based arrival
 *      index (so a caller who doesn't know the runtime-minted request_id in
 *      advance can still answer "the first prompt", "the second prompt", …).
 *      A matched answer is sent as `{ status: "success", value, data: { code: value } }`
 *      — `data.code` covers `otp`'s conventional single-field schema without
 *      requiring the caller to know the exact schema key.
 *   2. TTY fallback — `src/interaction-handler.ts`'s `handleInteraction`,
 *      which prompts inline on a readline TTY for `otp`/`credentials` (and
 *      falls back to file-drop + ntfy for any kind, including
 *      `manual_action`).
 *   3. Non-TTY with no matching answer — fails loudly: writes a `cancelled`
 *      INTERACTION_RESPONSE naming the unanswered prompt so the subprocess
 *      terminates cleanly instead of hanging on file-drop indefinitely, and
 *      this CLI itself reports the failure (see `renderMessage`/exit code).
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyForJsonl } from "@pdpp/connector-protocol";
import type {
  EmittedMessage,
  InteractionResponse,
  StreamScope,
} from "@pdpp/connector-protocol/connector-runtime-protocol";
import { config as dotenvConfig } from "dotenv";
import { handleInteraction, type InteractionMessage } from "../src/interaction-handler.ts";
import { getConnectorPaths, KNOWN_CONNECTOR_NAMES, readManifest } from "../src/orchestrator.ts";
import { buildRunSummary, type RunSummary } from "../src/run-summary.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

dotenvConfig({ path: join(REPO_ROOT, ".env.local"), quiet: true });

interface ManifestStream {
  name: string;
  [extra: string]: unknown;
}

export interface CliArgs {
  /** Raw `--answer <id-or-index>=<value>` entries, in the order given. */
  answers: string[];
  /** Path to a `--answers <json-file>` map (`{ [idOrIndex]: value }`). */
  answersFile?: string;
  connector: string;
  /**
   * Dev/test-only override for the connector's entrypoint path, bypassing
   * the `KNOWN_CONNECTOR_NAMES` registry lookup — the same override shape
   * `bin/collector-runner.ts` offers via `--command`/`--args`. Lets the
   * integration test drive the real CLI end-to-end against a test-only
   * fixture connector that is intentionally NOT registered in
   * `src/orchestrator.ts`, without adding a parallel runner.
   */
  entrypoint?: string;
  /** `--no-capture` — opts out of the default on-failure evidence retention
   *  (see `resolveCaptureOnFailureEnv`). Absent means the default applies. */
  noCapture: boolean;
  /** `--seed-last-state` — reads `runs/<connector>/last-state.json` (this
   *  CLI's own previous-run output; see this file's module docstring) into
   *  `START.state` so this run is naturally incremental. */
  seedLastState: boolean;
  /** `--streams a,b,c` — filters the manifest's stream list down to this
   *  named subset before building `START.scope`; see this file's module
   *  docstring. Empty/absent means "every manifest-declared stream", the
   *  pre-existing default behavior. */
  streams?: string[];
  summaryOut?: string;
}

function usageAndExit(code: number): never {
  process.stderr.write(
    "Usage: connector-dev <connector> [--summary-out <path>] [--answer <id-or-index>=<value>] " +
      "[--answers <json-file>] [--streams <name,name,...>] [--seed-last-state] [--no-capture]\n"
  );
  process.stderr.write(`Known connectors: ${KNOWN_CONNECTOR_NAMES.join(", ")}\n`);
  process.exit(code);
}

interface MutableCliArgs {
  answers: string[];
  answersFile: string | undefined;
  connector: string | undefined;
  entrypoint: string | undefined;
  noCapture: boolean;
  seedLastState: boolean;
  streams: string[] | undefined;
  summaryOut: string | undefined;
}

/** Consumes `--summary-out <value>` / `--entrypoint <value>` / `--answers
 *  <value>` at `argv[i]`, mutating `into[field]`. Returns the next index to
 *  resume parsing from. Split out of `parseArgs` purely to stay under this
 *  package's cognitive-complexity lint ceiling. */
function consumeValueFlag(
  argv: readonly string[],
  i: number,
  into: MutableCliArgs,
  field: "answersFile" | "entrypoint" | "summaryOut"
): number {
  const value = argv[i];
  if (!value) {
    usageAndExit(2);
  }
  into[field] = value;
  return i + 1;
}

function consumeAnswerFlag(argv: readonly string[], i: number, into: MutableCliArgs): number {
  const value = argv[i];
  if (!value?.includes("=")) {
    process.stderr.write("--answer requires <id-or-index>=<value>\n");
    usageAndExit(2);
  }
  into.answers.push(value);
  return i + 1;
}

/** Consumes `--streams <name,name,...>` at `argv[i]`: comma-separated,
 *  trimmed, empty entries dropped (so a trailing comma or accidental double
 *  comma doesn't produce a spurious empty stream name). */
function consumeStreamsFlag(argv: readonly string[], i: number, into: MutableCliArgs): number {
  const value = argv[i];
  if (!value) {
    usageAndExit(2);
  }
  into.streams = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return i + 1;
}

/**
 * Dispatches one `argv[i - 1]` flag (the value-only flags: `--summary-out`,
 * `--entrypoint`, `--answers`, `--answer`, `--streams`) to its consumer,
 * mutating `into` and returning the next index to resume parsing from.
 * Returns `undefined` for any arg this dispatcher doesn't own — `parseArgs`
 * then falls through to the boolean-flag/positional/usage-exit handling.
 *
 * A lookup table (rather than an if-chain ending in a bare `return;`/`return
 * undefined;`) sidesteps a known conflict between this package's biome
 * config (`noUselessUndefined`, which strips a trailing `return undefined;`)
 * and tsconfig's `noImplicitReturns` (which then rejects the resulting bare
 * `return;` on a function typed to return `number | undefined`) — see
 * `bin/scenario-verify.ts`'s `firstInteractionPromptMismatch` for the same
 * tension resolved with a `??`-chain instead; a lookup table reads better
 * here since these are side-effecting consumers, not pure computations.
 * Split out of `parseArgs` purely to stay under this package's
 * cognitive-complexity lint ceiling — behavior is unchanged from the fully
 * inline if-chain version. */
const VALUE_FLAG_CONSUMERS: Record<string, (argv: readonly string[], i: number, into: MutableCliArgs) => number> = {
  "--summary-out": (argv, i, into) => consumeValueFlag(argv, i, into, "summaryOut"),
  "--entrypoint": (argv, i, into) => consumeValueFlag(argv, i, into, "entrypoint"),
  "--answers": (argv, i, into) => consumeValueFlag(argv, i, into, "answersFile"),
  "--answer": consumeAnswerFlag,
  "--streams": consumeStreamsFlag,
};

function dispatchValueFlag(arg: string, argv: readonly string[], i: number, into: MutableCliArgs): number | undefined {
  return VALUE_FLAG_CONSUMERS[arg]?.(argv, i, into);
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const parsed: MutableCliArgs = {
    connector: undefined,
    summaryOut: undefined,
    entrypoint: undefined,
    answersFile: undefined,
    answers: [],
    streams: undefined,
    seedLastState: false,
    noCapture: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    i += 1;
    if (arg) {
      const nextIndex = dispatchValueFlag(arg, argv, i, parsed);
      if (nextIndex !== undefined) {
        i = nextIndex;
        continue;
      }
    }
    if (arg === "--seed-last-state") {
      parsed.seedLastState = true;
      continue;
    }
    if (arg === "--no-capture") {
      parsed.noCapture = true;
      continue;
    }
    if (arg && !arg.startsWith("--") && !parsed.connector) {
      parsed.connector = arg;
      continue;
    }
    usageAndExit(2);
  }
  if (!parsed.connector) {
    usageAndExit(2);
  }
  return {
    connector: parsed.connector,
    answers: parsed.answers,
    seedLastState: parsed.seedLastState,
    noCapture: parsed.noCapture,
    ...(parsed.summaryOut ? { summaryOut: parsed.summaryOut } : {}),
    ...(parsed.entrypoint ? { entrypoint: parsed.entrypoint } : {}),
    ...(parsed.answersFile ? { answersFile: parsed.answersFile } : {}),
    ...(parsed.streams ? { streams: parsed.streams } : {}),
  };
}

/**
 * Parses `--answer <id-or-index>=<value>` entries into a map keyed by the
 * literal id-or-index text (matched against both the INTERACTION's
 * `request_id` and its 0-based arrival index — see `resolvePreAnsweredValue`).
 * Only the FIRST `=` splits key from value, so a value containing `=` (e.g. a
 * base64 OTP-adjacent token) is preserved intact.
 */
export function parseAnswerFlags(rawAnswers: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of rawAnswers) {
    const eq = raw.indexOf("=");
    if (eq === -1) {
      continue;
    }
    out[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

/**
 * Loads `--answers <json-file>`: a flat `{ [idOrIndex]: value }` JSON object.
 * Every value must be a string — a caller supplying `otp`-shaped structured
 * data should use `--answer` with a JSON-encoded value string instead.
 */
export function loadAnswersFile(path: string): Record<string, string> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Resolves a pre-supplied answer for one INTERACTION, matching by
 * `request_id` first, then by 0-based arrival index (as a string) — so a
 * caller who doesn't know the runtime-minted request_id ahead of time can
 * still answer "the Nth prompt this run emits".
 */
export function resolvePreAnsweredValue(
  answers: Record<string, string>,
  requestId: string,
  arrivalIndex: number
): string | undefined {
  if (requestId in answers) {
    return answers[requestId];
  }
  const indexKey = String(arrivalIndex);
  return indexKey in answers ? answers[indexKey] : undefined;
}

/** Builds the INTERACTION_RESPONSE for a pre-supplied `--answer`/`--answers` value. */
export function buildPreAnsweredResponse(requestId: string, value: string): InteractionResponse {
  return {
    type: "INTERACTION_RESPONSE",
    request_id: requestId,
    status: "success",
    value,
    data: { code: value },
  };
}

/**
 * Fail-loud response for a non-TTY run with no matching `--answer`: rather
 * than hang on `handleInteraction`'s 30-minute file-drop wait, this responds
 * immediately with a `cancelled` status so the subprocess terminates and this
 * CLI can report the exact unanswered prompt.
 */
export function buildUnansweredResponse(requestId: string, message: string): InteractionResponse {
  return {
    type: "INTERACTION_RESPONSE",
    request_id: requestId,
    status: "cancelled",
    error: { message: `no --answer supplied and stdin is not a TTY: ${message}` },
  };
}

export function defaultSummaryPath(connector: string, isoStamp: string): string {
  const safeStamp = isoStamp.replace(/:/g, "-");
  return join(PACKAGE_ROOT, "runs", connector, `${safeStamp}-summary.json`);
}

export function toolVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildStartScope(streams: readonly ManifestStream[]): { streams: StreamScope[] } {
  return { streams: streams.map((stream): StreamScope => ({ name: stream.name })) };
}

/**
 * Filters `allStreams` (the connector's full manifest-declared stream list)
 * down to `--streams`' named subset. Ergonomics only — no new protocol
 * concept: `START.scope.streams` already accepts any subset of a
 * connector's declared streams (`connector-runtime.ts`'s `requested` map),
 * this just builds that subset from a CLI flag instead of always sending
 * every declared stream. An unknown name throws with the manifest's actual
 * stream names, so a typo fails before any subprocess spawns rather than
 * silently running with zero matching streams.
 */
export function filterStreamsByName(
  allStreams: readonly ManifestStream[],
  names: readonly string[]
): readonly ManifestStream[] {
  const known = new Set(allStreams.map((s) => s.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `--streams named unknown stream(s): ${unknown.join(", ")}. ` +
        `Available streams: ${allStreams.map((s) => s.name).join(", ") || "(none declared)"}`
    );
  }
  const wanted = new Set(names);
  return allStreams.filter((s) => wanted.has(s.name));
}

// ─── --seed-last-state persistence ────────────────────────────────────────
//
// `runs/<connector>/last-state.json` is this CLI's own local-only record of
// the final committed per-stream cursors from its most recent run — the
// same `runs/` directory (gitignored) the run-summary artifacts already
// live under. Not a new protocol concept: it is exactly the per-stream
// `cursor` payload every STATE message already carries
// (connector-runtime-protocol.ts), persisted across separate `connector-dev`
// invocations so `--seed-last-state` can hand it back as `START.state`.

export interface LastState {
  connector: string;
  /** ISO timestamp this state was captured at — the seeding run's own
   *  `started_at`, so `--seed-last-state`'s printed note can say which run
   *  the state came from. */
  started_at: string;
  /** Per-stream final cursor, keyed by stream name — the same shape
   *  `START.state` expects. */
  state: Record<string, unknown>;
}

export function lastStatePath(connector: string): string {
  return join(PACKAGE_ROOT, "runs", connector, "last-state.json");
}

/**
 * Reduces this run's observed STATE messages into `{ [stream]: cursor }` —
 * the last STATE seen per stream wins, matching how a connector's own
 * `state` map already accumulates. Empty when the run emitted no STATE at
 * all (nothing to seed a future run with).
 */
export function finalStateFromMessages(messages: readonly EmittedMessage[]): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const message of messages) {
    if (message.type === "STATE") {
      state[message.stream] = message.cursor;
    }
  }
  return state;
}

/** Writes `runs/<connector>/last-state.json` on every DONE that produced at
 *  least one STATE message — a run with zero STATE messages leaves any
 *  prior last-state file untouched, since there is nothing new to seed with
 *  and overwriting it with an empty object would erase a usable prior
 *  checkpoint. */
export function writeLastState(connector: string, startedAt: string, state: Record<string, unknown>): void {
  if (Object.keys(state).length === 0) {
    return;
  }
  const path = lastStatePath(connector);
  mkdirSync(dirname(path), { recursive: true });
  const payload: LastState = { connector, started_at: startedAt, state };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Reads `runs/<connector>/last-state.json` for `--seed-last-state`. Throws a
 * clear, actionable message (never a raw ENOENT/parse error) when no prior
 * run has written one — `--seed-last-state` has nothing to seed with in
 * that case, and silently falling back to an empty-state full run would
 * contradict the flag the caller explicitly asked for.
 */
export function readLastState(connector: string): LastState {
  const path = lastStatePath(connector);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `--seed-last-state: no prior run state at ${path}; run once without the flag first, then re-run with --seed-last-state.`,
      { cause: err }
    );
  }
  try {
    return JSON.parse(raw) as LastState;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `--seed-last-state: ${path} is not valid JSON (${reason}); run once without the flag to rewrite it.`,
      { cause: err }
    );
  }
}

// ─── Failure-evidence retention (default-on) ──────────────────────────────
//
// Every leading failure-diagnostic tool surveyed (Playwright's
// `retain-on-failure`/`on-first-retry`, Cypress's automatic failure
// screenshot, yt-dlp/gallery-dl's mandatory-verbose-log issue templates)
// retains rich evidence around a failure BY DEFAULT in its primary run mode
// — none of them make the developer opt in after the first failure has
// already happened. `fixture-capture.ts`'s `PDPP_CAPTURE_ON_FAILURE=1` mode
// already implements exactly this policy (capture during the run, delete on
// success, retain on failure) but ships opt-in: nothing in this repo sets it
// automatically, so a developer's first-ever failure in `connector-dev` is
// evidence-free by construction, and the run cost (however long the
// connector took to fail) is paid a second time on the necessarily-repeated
// run just to get a capture. `connector-dev` is exactly the "primary run
// mode" analogue here, so it sets the default the way those tools do:
// `PDPP_CAPTURE_ON_FAILURE=1` for the subprocess unless the developer
// explicitly opts out via `--no-capture` or an explicit `0` already in their
// own environment (an explicit `0` is respected, never overridden — this is
// a default, not a forced-on policy).

/**
 * Resolves the `PDPP_CAPTURE_ON_FAILURE` value to pass to the connector
 * subprocess. Pure function of the CLI flag and the caller's own
 * environment so it is unit-testable without spawning anything.
 *
 * `PDPP_CAPTURE_FIXTURES=1` (fixture-capture.ts's always-retain mode) is
 * left untouched either way — this only ever sets `_ON_FAILURE`, and
 * `createCaptureSession` already gives `_FIXTURES` priority over
 * `_ON_FAILURE` when both are set, so an always-retain developer session is
 * never downgraded by this default.
 */
export function resolveCaptureOnFailureEnv(
  noCaptureFlag: boolean,
  env: Record<string, string | undefined>
): string | undefined {
  if (noCaptureFlag) {
    return; // --no-capture: do not set it at all; let fixture-capture.ts see it unset.
  }
  const existing = env.PDPP_CAPTURE_ON_FAILURE?.trim();
  if (existing === "0") {
    return "0"; // explicit opt-out already in the environment — respected, not overridden.
  }
  return "1"; // the default: every other case (unset, or already "1") retains on failure.
}

/** Printed once at start so the retention policy in effect for this run is
 *  never silent — matches every surveyed tool's practice of stating its
 *  evidence policy up front rather than leaving it discoverable only after
 *  a failure. */
function printCapturePolicyNote(resolvedValue: string | undefined): void {
  if (resolvedValue === "1") {
    printLine("capture: on-failure (default; --no-capture to disable)");
    return;
  }
  if (resolvedValue === "0") {
    printLine("capture: disabled (PDPP_CAPTURE_ON_FAILURE=0 already set in environment)");
    return;
  }
  printLine("capture: disabled (--no-capture)");
}

/** `resolveCaptureOnFailureEnv` + `printCapturePolicyNote`, composed as one
 *  `main()` call site — kept as a single named step (not inlined) so
 *  `main()`'s own branch count stays legible as this file accumulates
 *  concurrent additions. */
function resolveAndAnnounceCapturePolicy(
  noCaptureFlag: boolean,
  env: Record<string, string | undefined>
): string | undefined {
  const resolved = resolveCaptureOnFailureEnv(noCaptureFlag, env);
  printCapturePolicyNote(resolved);
  return resolved;
}

// ─── Live stdout rendering ───────────────────────────────────────────────

const streamRecordCounts = new Map<string, number>();
const RECORD_PRINT_EVERY = 25;

function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function renderMessage(message: EmittedMessage): void {
  switch (message.type) {
    case "RECORD": {
      const count = (streamRecordCounts.get(message.stream) ?? 0) + 1;
      streamRecordCounts.set(message.stream, count);
      if (count === 1 || count % RECORD_PRINT_EVERY === 0) {
        printLine(`  RECORD   [${message.stream}] ${count} record(s) so far`);
      }
      return;
    }
    case "PROGRESS": {
      const streamTag = message.stream ? `[${message.stream}] ` : "";
      const countTag =
        message.count === undefined ? "" : ` (${message.count}${message.total ? `/${message.total}` : ""})`;
      printLine(`  PROGRESS ${streamTag}${message.message}${countTag}`);
      return;
    }
    case "STATE": {
      printLine(`  STATE    [${message.stream}] checkpoint committed`);
      return;
    }
    case "SKIP_RESULT": {
      printLine(`  WARN     [${message.stream}] skip: ${message.reason} — ${message.message}`);
      return;
    }
    case "DETAIL_GAP": {
      printLine(`  WARN     [${message.stream}] detail gap: ${message.reason} (record ${String(message.record_key)})`);
      return;
    }
    case "DETAIL_COVERAGE": {
      printLine(
        `  COVERAGE [${message.stream}] considered=${message.considered ?? message.required_keys.length} covered=${
          message.covered ?? message.hydrated_keys.length
        }`
      );
      return;
    }
    case "INTERACTION": {
      printLine(`  PROMPT   needs ${message.kind}: ${message.message}`);
      return;
    }
    case "ASSISTANCE": {
      printLine(`  PROMPT   assistance needed (${message.owner_action}): ${message.message}`);
      return;
    }
    case "ASSISTANCE_STATUS": {
      printLine(`  PROMPT   assistance ${message.status}${message.message ? `: ${message.message}` : ""}`);
      return;
    }
    case "DONE": {
      return; // rendered by the caller once the summary is assembled
    }
    default:
      return;
  }
}

/**
 * A DONE(succeeded) on stdout is NOT, by itself, proof the run actually
 * finished honestly — see this file's module docstring's "Exit code"
 * paragraph and the expert review that added this check. Three additional
 * conditions each make a run a FAILURE regardless of what any DONE message
 * claimed:
 *   - `nonzero_exit_after_done`: the child process exited non-zero or was
 *     killed by a signal, even though it had emitted a succeeded DONE first.
 *     A crash/signal after DONE means the process did NOT get to shut down
 *     cleanly — anything it was still doing (flushing, cleanup) is unproven.
 *   - `multiple_done`: more than one DONE message was observed. DONE is
 *     defined as the terminal message of the protocol; a second one means
 *     the connector kept running (or the protocol was replayed/duplicated)
 *     after declaring itself finished, so the FIRST DONE's "done" claim was
 *     false.
 *   - `message_after_done`: any protocol message (of any type) arrived after
 *     the first DONE. Same reasoning as `multiple_done` — DONE is supposed to
 *     be last.
 */
export type ProtocolViolationReason = "nonzero_exit_after_done" | "multiple_done" | "message_after_done";

export interface RunResult {
  code: number | null;
  messages: EmittedMessage[];
  /** Set when the run's DONE-finality was violated (see
   *  `ProtocolViolationReason`) — populated even when the subprocess's own
   *  DONE said `status: "succeeded"`, because a DONE claim is not
   *  self-certifying here. `main()` treats this as an unconditional failure. */
  protocolViolation?: ProtocolViolationReason;
  signal: NodeJS.Signals | null;
  /** INTERACTION request_ids answered via `buildUnansweredResponse` (non-TTY,
   *  no matching --answer) — surfaced so `main()` can name every unanswered
   *  prompt in its failure output even if the subprocess's own DONE/error
   *  message doesn't mention them. */
  unansweredInteractions: Array<{ kind: string; message: string; requestId: string }>;
}

export interface RunAndStreamOptions {
  /** Pre-supplied answers from `--answer`/`--answers`, keyed by request_id or
   *  0-based arrival index (see `resolvePreAnsweredValue`). */
  answers?: Record<string, string>;
  /** Resolved `PDPP_CAPTURE_ON_FAILURE` value for the subprocess (see
   *  `resolveCaptureOnFailureEnv`); `undefined` means do not set it at all. */
  captureOnFailure?: string;
  /** Injectable for tests; defaults to `process.stdin.isTTY`. */
  isTty?: boolean;
}

/**
 * Spawn the connector's own entrypoint and drive START → JSONL stdout
 * exactly like `runConnectorProtocolSubprocess` (src/test-harness.ts), but
 * render each message live as it arrives instead of buffering to a
 * settled Promise.
 */
export function runAndStream(entrypoint: string, start: object, options: RunAndStreamOptions = {}): Promise<RunResult> {
  const answers = options.answers ?? {};
  const isTty = options.isTty ?? Boolean(process.stdin.isTTY);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PATCHRIGHT_SKIP_BROWSER_DOWNLOAD ?? "",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? "",
        // See "Failure-evidence retention (default-on)" above `runAndStream`'s
        // section header: default-on unless the caller opted out. Omitting the
        // key entirely (rather than writing "undefined") when unset lets
        // fixture-capture.ts's own env read see it as genuinely absent.
        ...(options.captureOnFailure === undefined ? {} : { PDPP_CAPTURE_ON_FAILURE: options.captureOnFailure }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: EmittedMessage[] = [];
    const unansweredInteractions: RunResult["unansweredInteractions"] = [];
    let stdoutBuffer = "";
    let settled = false;
    let interactionArrivalIndex = 0;
    let doneCount = 0;
    let messageAfterDone = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    const answerInteraction = (parsed: Extract<EmittedMessage, { type: "INTERACTION" }>): void => {
      const arrivalIndex = interactionArrivalIndex;
      interactionArrivalIndex += 1;
      const preAnswered = resolvePreAnsweredValue(answers, parsed.request_id, arrivalIndex);
      if (preAnswered !== undefined) {
        child.stdin?.write(stringifyForJsonl(buildPreAnsweredResponse(parsed.request_id, preAnswered)));
        return;
      }
      if (!isTty) {
        printLine(`  PROMPT   FAILED (no --answer, no TTY): ${parsed.kind} — ${parsed.message}`);
        unansweredInteractions.push({ requestId: parsed.request_id, kind: parsed.kind, message: parsed.message });
        child.stdin?.write(stringifyForJsonl(buildUnansweredResponse(parsed.request_id, parsed.message)));
        return;
      }
      const schema: InteractionMessage["schema"] = parsed.schema as InteractionMessage["schema"] | undefined;
      const interactionMessage: InteractionMessage = {
        kind: parsed.kind,
        message: parsed.message,
        request_id: parsed.request_id,
        ...(schema === undefined ? {} : { schema }),
        ...(parsed.timeout_seconds === undefined ? {} : { timeout_seconds: parsed.timeout_seconds }),
      };
      handleInteraction(interactionMessage, { connectorName: entrypoint })
        .then((response) => {
          child.stdin?.write(stringifyForJsonl(response));
        })
        .catch(() => undefined);
    };

    const parseLine = (line: string): void => {
      if (!line.trim()) {
        return;
      }
      let parsed: EmittedMessage;
      try {
        parsed = JSON.parse(line) as EmittedMessage;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        finish(() => rejectPromise(new Error(`connector emitted invalid JSONL: ${reason}; line=${line}`)));
        return;
      }
      if (doneCount > 0) {
        // A message after DONE (including a second DONE) violates DONE
        // finality — see `ProtocolViolationReason.message_after_done`/
        // `.multiple_done`. Still record it (for diagnostics) but do not let
        // it re-trigger the stdin-close side effect below.
        messageAfterDone = true;
      }
      messages.push(parsed);
      renderMessage(parsed);
      if (parsed.type === "INTERACTION") {
        answerInteraction(parsed);
        return;
      }
      if (parsed.type === "DONE") {
        doneCount += 1;
        // connector-exit.ts's `flushAndExitAfterRuntimeAck` blocks the
        // child's own process.exit() until ITS stdin sees `close`/`end` —
        // the protocol's documented "runtime closes connector stdin after
        // consuming DONE" handshake. Since stdin is left open for the whole
        // run now (INTERACTION_RESPONSE writes need it — see the comment at
        // the bottom of this function), we are that runtime: end stdin here,
        // once DONE is observed, or the child hangs forever waiting on an
        // EOF nobody sends.
        child.stdin?.end();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        parseLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.on("error", (err) => {
      finish(() => rejectPromise(err));
    });

    child.on("close", (code, signal) => {
      if (stdoutBuffer.trim()) {
        parseLine(stdoutBuffer);
      }
      const succeededDone = messages.find((m) => m.type === "DONE" && m.status === "succeeded");
      // A FAILED DONE legitimately exits non-zero (connector-exit.ts's
      // `flushAndExitAfterRuntimeAck` is called with the caller-supplied
      // code) — that is consistent, not a violation. Only a claimed SUCCESS
      // that the exit/signal then contradicts is dishonest.
      const nonzeroExitAfterSucceededDone = Boolean(succeededDone) && (code !== 0 || Boolean(signal));
      let protocolViolation: ProtocolViolationReason | undefined;
      if (doneCount > 1) {
        protocolViolation = "multiple_done";
      } else if (messageAfterDone) {
        protocolViolation = "message_after_done";
      } else if (nonzeroExitAfterSucceededDone) {
        protocolViolation = "nonzero_exit_after_done";
      }
      finish(() =>
        resolvePromise({
          code,
          messages,
          signal,
          unansweredInteractions,
          ...(protocolViolation ? { protocolViolation } : {}),
        })
      );
    });

    // NOT `.end()`: an INTERACTION mid-run needs to write an
    // INTERACTION_RESPONSE back over this same stdin later (see
    // `answerInteraction` above) — `.end()` closes the stream after this
    // write, silently dropping any later `.write()` call. `connector-
    // runtime.ts`'s `readStart`/`sendInteraction` both read from the same
    // `readline` interface over the run's whole lifetime, so leaving stdin
    // open here matches what the protocol actually expects; the pipe closes
    // naturally when the child process exits.
    child.stdin?.write(stringifyForJsonl(start));
  });
}

/**
 * `--entrypoint` mode's synthetic stream list, standing in for a manifest's
 * `streams` array — there is no bound production manifest to read one from
 * (see this function's doc comment). Listing more than one name here (not
 * just `items`, the original single-stream default) is what lets the
 * integration test exercise `--streams` filtering end-to-end through this
 * CLI without a registered production connector — the same reason the test
 * fixture wiring exists at all.
 */
const ENTRYPOINT_MODE_STREAMS: readonly ManifestStream[] = [{ name: "items" }, { name: "extras" }];

/**
 * Resolve the connector entrypoint and the streams to put on START.scope.
 * Normal usage resolves both from the manifest registry
 * (`getConnectorPaths`/`readManifest`, src/orchestrator.ts) — the same
 * lookup `bin/orchestrate.ts` uses. `--entrypoint` (dev/test-only) bypasses
 * the registry so the integration test can point this CLI at a test-only
 * fixture connector without registering it in production manifests.
 *
 * `args.streams` (from `--streams`), when present, filters whichever stream
 * list was resolved down to the named subset via `filterStreamsByName` —
 * applied uniformly regardless of whether the list came from a real
 * manifest or `ENTRYPOINT_MODE_STREAMS`.
 */
function resolveConnector(args: CliArgs): { connectorPath: string; streams: readonly ManifestStream[] } {
  const resolved = ((): { connectorPath: string; streams: readonly ManifestStream[] } => {
    if (args.entrypoint) {
      return { connectorPath: args.entrypoint, streams: ENTRYPOINT_MODE_STREAMS };
    }
    if (!KNOWN_CONNECTOR_NAMES.includes(args.connector)) {
      process.stderr.write(`Unknown connector: ${args.connector}\n`);
      usageAndExit(2);
    }
    const manifest = readManifest(args.connector);
    const { connectorPath } = getConnectorPaths(args.connector);
    return { connectorPath, streams: (manifest.streams ?? []) as ManifestStream[] };
  })();
  if (!args.streams) {
    return resolved;
  }
  return { ...resolved, streams: filterStreamsByName(resolved.streams, args.streams) };
}

// ─── Browser renderer selection ──────────────────────────────────────────
//
// browser-launch.ts's `resolveDeploymentBrowserHeadless` resolves headed-vs-
// headless from an explicit `headless` argument (connector manifests never
// pass one) falling back to `PDPP_BROWSER_HEADLESS=1` meaning headless —
// otherwise headed. This CLI does not import browser-launch.ts (that would
// pull the browser-only dependency boundary into a file every connector's
// entrypoint transitively runs through); it only prints operator guidance
// and sets the SAME env var browser-launch.ts already reads, honoring
// whatever the developer already exported.
//
// There is no CDP/devtools endpoint this CLI can observe or print: the
// endpoint is published into `process.env.PDPP_BROWSER_CDP_HOST`/`_PORT`
// INSIDE the connector subprocess at launch time (browser-launch.ts's
// `publishCdpEndpointFromLaunch`), and only when the connector opted into
// `streamingEnabled`. A parent process spawning that subprocess has no
// visibility into its post-launch env mutations or its `DevToolsActivePort`
// file (it's under a profile dir this CLI doesn't know either). Printing a
// fabricated URL would be dishonest, so headless runs get an honest note
// instead — see the module docstring's GOAL 2 for why this is a documented
// gap rather than a guess.
function printBrowserRendererNote(env: NodeJS.ProcessEnv): void {
  const hasDisplay = Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
  const headlessOverride = env.PDPP_BROWSER_HEADLESS?.trim();
  if (hasDisplay) {
    if (headlessOverride === "1") {
      printLine(
        "BROWSER  DISPLAY/WAYLAND_DISPLAY is set but PDPP_BROWSER_HEADLESS=1 forces headless; " +
          "unset it or set PDPP_BROWSER_HEADLESS=0 to see the browser window."
      );
    } else {
      printLine("BROWSER  DISPLAY detected — browser-class connectors will launch headed (visible) by default.");
    }
    return;
  }
  printLine(
    "BROWSER  no DISPLAY/WAYLAND_DISPLAY detected — browser-class connectors run headless. " +
      "Headless browser dev currently has no attach surface from this CLI (no CDP/devtools URL is " +
      "observable outside the connector subprocess); see src/browser-launch.ts's module docstring " +
      "and docs/reference/ for the streaming-companion path used in production."
  );
}

/** Result of `resolvePreflightRunConfig`: either everything `main()` needs
 *  to build START (`ok: true`), or a pre-flight failure message to print
 *  and exit on (`ok: false`) — `--streams` naming an unknown stream, or
 *  `--seed-last-state` with no prior run. Both fail BEFORE any subprocess
 *  spawns, so this is resolved as one step ahead of `main()`'s try/spawn
 *  block. Split out of `main` purely to stay under this package's
 *  cognitive-complexity lint ceiling — behavior is unchanged from the fully
 *  inline version. */
type PreflightRunConfig =
  | {
      connectorPath: string;
      ok: true;
      seedState: Record<string, unknown> | undefined;
      streams: readonly ManifestStream[];
    }
  | { message: string; ok: false };

function resolvePreflightRunConfig(args: CliArgs): PreflightRunConfig {
  let connectorPath: string;
  let streams: readonly ManifestStream[];
  try {
    ({ connectorPath, streams } = resolveConnector(args));
  } catch (err) {
    // filterStreamsByName's unknown-stream-name error — fail before spawning
    // anything, same as every other pre-flight arg-validation failure.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }

  // --seed-last-state: read this connector's previous run's committed
  // per-stream cursors (written by an earlier `connector-dev` invocation —
  // see `writeLastState`) into START.state. Resolved before spawning
  // anything, same as the --streams validation above: a missing prior file
  // is a pre-flight failure, not a mid-run one.
  if (!args.seedLastState) {
    return { ok: true, connectorPath, streams, seedState: undefined };
  }
  let lastState: LastState;
  try {
    lastState = readLastState(args.connector);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
  printLine(`SEEDED   state from ${lastStatePath(args.connector)} (run of ${lastState.started_at})`);
  return { ok: true, connectorPath, streams, seedState: lastState.state };
}

/** Prints the per-stream/coverage/skip/provenance block of the terminal
 *  run summary — everything between the `DONE` line and the
 *  succeeded/failed status dispatch. Split out of `main` purely to stay
 *  under this package's cognitive-complexity lint ceiling — behavior is
 *  unchanged from the fully inline version. */
function printRunSummaryBody(summary: RunSummary, outPath: string): void {
  // Sort slowest-first so the stream that dominated a long run is the first
  // thing an author reads (a 75-minute ynab run was 140 paced windows in one
  // stream; the old alphabetical list of counts could not show that).
  const streamEntries = Object.entries(summary.streams).sort(
    ([, a], [, b]) => (b.elapsed_ms ?? -1) - (a.elapsed_ms ?? -1)
  );
  for (const [name, streamSummary] of streamEntries) {
    const took = streamSummary.elapsed_ms === undefined ? "" : `  took=${formatElapsed(streamSummary.elapsed_ms)}`;
    printLine(
      `  ${name.padEnd(28)} ${streamSummary.records} record(s)  state_emitted=${String(streamSummary.state_emitted)}${took}`
    );
  }
  if (summary.done.coverage) {
    printLine(`  coverage: considered=${summary.done.coverage.considered} covered=${summary.done.coverage.covered}`);
  }
  if (summary.done.latest_record_emitted_at) {
    printLine(`  latest_record_emitted_at: ${summary.done.latest_record_emitted_at}`);
  }
  printLine(`  skips: ${summary.skips}`);
  // FIX 3 (non-loopback honesty, connector-dev half): this tool never wraps
  // the subprocess's fetch, so it has zero transport-observation evidence —
  // a succeeded run here proves the protocol was driven correctly, not that
  // real provider contact happened. See RunSummary.provider_contact_observed's
  // doc comment for the full rationale.
  printLine(
    "  provider_contact_observed: false (connector-dev has no transport observation — a derived-from-real claim requires scenario-record's own observation)"
  );
  printLine(`  summary written to: ${outPath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { connector, summaryOut } = args;

  const answers = { ...parseAnswerFlags(args.answers), ...(args.answersFile ? loadAnswersFile(args.answersFile) : {}) };

  const preflight = resolvePreflightRunConfig(args);
  if (!preflight.ok) {
    printLine(`FAILED   ${preflight.message}`);
    process.exitCode = 1;
    return;
  }
  const { connectorPath, streams, seedState } = preflight;

  const start = {
    type: "START" as const,
    scope: buildStartScope(streams),
    ...(seedState ? { state: seedState } : {}),
  };

  printLine(`START ${connector} — streams: ${streams.map((s) => s.name).join(", ") || "(none declared)"}`);
  printBrowserRendererNote(process.env);
  const captureOnFailure = resolveAndAnnounceCapturePolicy(args.noCapture, process.env);

  const startedAt = new Date().toISOString();
  let result: RunResult;
  try {
    result = await runAndStream(connectorPath, start, {
      answers,
      ...(captureOnFailure === undefined ? {} : { captureOnFailure }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printLine(`FAILED   spawn_error: ${message}`);
    process.exitCode = 1;
    return;
  }
  const finishedAt = new Date().toISOString();

  const summary = buildRunSummary(result.messages, {
    connector,
    started_at: startedAt,
    finished_at: finishedAt,
    tool_version: toolVersion(),
  });

  const outPath = summaryOut ? resolve(summaryOut) : defaultSummaryPath(connector, startedAt);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  // Persist this run's final per-stream cursors for a FUTURE
  // --seed-last-state run — on every DONE that produced at least one STATE
  // message, success or failure, since a mid-run failure after some streams
  // already committed STATE still leaves genuine incremental progress worth
  // seeding from (see `writeLastState`'s doc comment).
  writeLastState(connector, startedAt, finalStateFromMessages(result.messages));

  printLine("DONE");
  printRunSummaryBody(summary, outPath);

  // A succeeded DONE is not self-certifying: a nonzero exit or exit-by-signal
  // after DONE, more than one DONE, or any protocol message after DONE, is a
  // failure regardless of what the DONE itself claimed — see
  // `ProtocolViolationReason`'s doc comment.
  if (result.protocolViolation) {
    printLine(
      `FAILED   protocol_violation: ${result.protocolViolation} (DONE status=${summary.done.status}, exit code=${String(result.code)}, signal=${String(result.signal)})`
    );
    process.exitCode = 1;
    return;
  }

  if (summary.done.status === "succeeded") {
    printLine(`STATUS succeeded (${result.code ?? "null"})`);
    process.exitCode = 0;
    return;
  }

  if (result.unansweredInteractions.length > 0) {
    for (const unanswered of result.unansweredInteractions) {
      printLine(`  unanswered prompt: ${unanswered.kind} — ${unanswered.message} (request_id=${unanswered.requestId})`);
    }
  }

  if (summary.done.status === "no_done") {
    printLine(`FAILED   no_terminal_done: exit code=${String(result.code)} signal=${String(result.signal)}`);
    process.exitCode = 1;
    return;
  }

  // status === "failed"
  const errorMessage = summary.done.error?.message ?? "unknown failure";
  const retryable = summary.done.error?.retryable ?? false;
  printLine(`FAILED   ${retryable ? "retryable" : "terminal"}: ${errorMessage}`);
  printFailureDiagnostics(connector, captureOnFailure, process.env);
  process.exitCode = 1;
}

/** `findLatestCaptureDir` + `diagnosticNextSteps`, composed as one `main()`
 *  call site — see `resolveAndAnnounceCapturePolicy`'s doc comment for why
 *  this file keeps `main()`'s own steps as single named calls. */
function printFailureDiagnostics(
  connector: string,
  captureOnFailure: string | undefined,
  env: Record<string, string | undefined>
): void {
  const captureDir = captureOnFailure === undefined ? undefined : findLatestCaptureDir(connector, env);
  for (const line of diagnosticNextSteps(captureDir)) {
    printLine(`  ${line}`);
  }
}

/** Human-scaled elapsed rendering: "820ms", "12s", "4m10s". */
function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${String(ms)}ms`;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${String(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m${String(seconds).padStart(2, "0")}s`;
}

// ─── Evidence + closed-taxonomy failure diagnostics ───────────────────────
//
// Per the grounding research (see this package's
// ai/research/developer-experience "leading failure-diagnostic tools"
// entry): leading tools retain evidence at the failure instant and surface
// it in the SAME output as the error, but do not state a free-text guessed
// root cause. `diagnosticNextSteps` previously branched on regexes over the
// error message text and printed a speculative hint ("this usually means
// the page had no usable session yet, or the provider blocked the
// request") — an open-ended guess this tool has no evidence for. Replaced
// with: (a) always point at where evidence went; (b) if capture wrote
// per-checkpoint page metadata, print the failing checkpoint's own
// evidence (label/url/DOM size) in this same block; (c) a CLOSED set of
// deterministic classifications, each keyed on a structural fact this tool
// can actually observe in the capture it just wrote — never on message-text
// pattern-matching against the provider's own wording.

/** One `pages/<label>.json` capture record — see fixture-capture.ts's
 *  `capturePageMetadata`. `captured_at` is included for ordering; capture
 *  writes it as an ISO timestamp string. */
interface CapturedPageMeta {
  captured_at?: string;
  label?: string;
  title?: string;
  url?: string;
}

export interface CheckpointEvidence {
  domBytes: number | undefined;
  label: string;
  url: string | undefined;
}

/**
 * Locates the capture directory this run's subprocess would have written
 * to, if any. Mirrors fixture-capture.ts's own path resolution
 * (`PDPP_CAPTURE_ROOT_DIR` or the package-local `fixtures/` default) plus
 * its `<connector>/raw/<runId>/` layout — but connector-dev does not know
 * the runId the subprocess minted (it's an ISO timestamp generated inside
 * `createCaptureSession`), so this picks the LEXICALLY-LATEST `raw/*` entry
 * for the connector, which is also the chronologically latest since runIds
 * are ISO-timestamp-derived and sort accordingly. Returns undefined when no
 * capture directory exists (capture disabled, or the subprocess never got
 * far enough to create one).
 */
export function findLatestCaptureDir(connector: string, env: Record<string, string | undefined>): string | undefined {
  const configuredRoot = env.PDPP_CAPTURE_ROOT_DIR?.trim();
  const captureRoot = configuredRoot && configuredRoot.length > 0 ? configuredRoot : join(PACKAGE_ROOT, "fixtures");
  const rawDir = join(captureRoot, connector, "raw");
  let entries: string[];
  try {
    entries = readdirSync(rawDir).filter((name) => {
      try {
        return statSync(join(rawDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }
  if (entries.length === 0) {
    return;
  }
  entries.sort();
  const latest = entries.at(-1);
  return latest ? join(rawDir, latest) : undefined;
}

/**
 * Reads every `pages/<label>.json` under a capture run directory, sorted by
 * `captured_at` ascending (arrival order) — the same evidence
 * `venmo.ts`'s `checkpoint()` calls write via `captureDom`'s
 * `capturePageMetadata`. Best-effort: an unreadable/malformed file is
 * skipped rather than failing the whole read, since this is diagnostic
 * evidence gathering, not the run itself.
 */
const JSON_EXTENSION_RE = /\.json$/;

export function readCheckpointEvidence(captureDir: string): CheckpointEvidence[] {
  const pagesDir = join(captureDir, "pages");
  let files: string[];
  try {
    files = readdirSync(pagesDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const records: Array<CapturedPageMeta & { domBytes: number | undefined }> = [];
  for (const file of files) {
    let meta: CapturedPageMeta;
    try {
      meta = JSON.parse(readFileSync(join(pagesDir, file), "utf8")) as CapturedPageMeta;
    } catch {
      continue;
    }
    const domFile = join(captureDir, "dom", file.replace(JSON_EXTENSION_RE, ".html"));
    let domBytes: number | undefined;
    try {
      domBytes = statSync(domFile).size;
    } catch {
      domBytes = undefined;
    }
    records.push({ ...meta, domBytes });
  }
  records.sort((a, b) => (a.captured_at ?? "").localeCompare(b.captured_at ?? ""));
  return records.map((r) => ({ label: r.label ?? "(unlabeled)", url: r.url, domBytes: r.domBytes }));
}

export type FailureEnvironmentClassification = { kind: "navigation_incomplete" } | { kind: "viewport_zero" };

/**
 * Closed, deterministic classification over the checkpoint evidence this
 * tool actually captured for the failing run — no free-text guessing. Only
 * two rules, each keyed on a structural fact:
 *
 *   - `viewport_zero`: any checkpoint's DOM capture is degenerate-small
 *     (near-empty document) while landing at a real (non-about:blank)
 *     origin — the observable fingerprint of the motivating incident (a
 *     0x0-viewport headed Chromium under tmux with unusable XAUTHORITY: the
 *     page never laid out, so even a "landed" page's DOM read back
 *     near-empty). Bound conservatively: only fires below
 *     `DEGENERATE_DOM_BYTES_CEILING`, which a real rendered page's HTML
 *     essentially never falls under.
 *   - `navigation_incomplete`: the LAST checkpoint before the failure sat at
 *     `about:blank` while an EARLIER OR LATER checkpoint reached a real
 *     origin — i.e. the run's own evidence shows navigation had not
 *     committed yet at the moment the failing step ran.
 *
 * No rule match returns undefined — callers must print evidence pointers
 * only in that case, never an invented diagnosis line.
 */
const DEGENERATE_DOM_BYTES_CEILING = 200;

export function classifyFailureEnvironment(
  checkpoints: readonly CheckpointEvidence[]
): FailureEnvironmentClassification | undefined {
  if (checkpoints.length === 0) {
    return;
  }
  const hasRealOrigin = checkpoints.some((c) => c.url !== undefined && c.url !== "about:blank" && c.url !== "");
  const degenerateAtRealOrigin = checkpoints.some(
    (c) =>
      c.url !== undefined &&
      c.url !== "about:blank" &&
      c.url !== "" &&
      c.domBytes !== undefined &&
      c.domBytes < DEGENERATE_DOM_BYTES_CEILING
  );
  if (degenerateAtRealOrigin) {
    return { kind: "viewport_zero" };
  }
  const last = checkpoints.at(-1);
  const navigationIncomplete = last?.url === "about:blank" && hasRealOrigin;
  return navigationIncomplete ? { kind: "navigation_incomplete" } : undefined;
}

function environmentClassificationLine(classification: FailureEnvironmentClassification): string {
  if (classification.kind === "viewport_zero") {
    return (
      "environment: browser viewport 0x0 - no usable display (DISPLAY set but unusable, common under tmux/SSH). " +
      "Re-run with PDPP_BROWSER_HEADLESS=1 or fix XAUTHORITY."
    );
  }
  return "navigation_incomplete: the failing step ran before the page navigated";
}

/**
 * Turns a terminal failure into what evidence this tool actually has —
 * never a guessed cause. See this section's header comment for the
 * evidence-vs-interpretation policy this replaces.
 */
function diagnosticNextSteps(captureDir: string | undefined): string[] {
  const lines: string[] = [];
  if (captureDir === undefined) {
    lines.push(
      "evidence: none retained for this run (capture disabled — see the 'capture:' line above).",
      "      re-run without --no-capture to retain DOM/ARIA/screenshots for the next failure."
    );
    return lines;
  }
  lines.push(`evidence: ${captureDir}`);
  const checkpoints = readCheckpointEvidence(captureDir);
  const failingCheckpoint = checkpoints.at(-1);
  if (failingCheckpoint) {
    const domPart = failingCheckpoint.domBytes === undefined ? "unknown-byte" : `${failingCheckpoint.domBytes}-byte`;
    lines.push(
      `evidence: checkpoint '${failingCheckpoint.label}' at ${failingCheckpoint.url ?? "(unknown url)"} (${domPart} DOM)`
    );
  }
  const classification = classifyFailureEnvironment(checkpoints);
  if (classification) {
    lines.push(environmentClassificationLine(classification));
  }
  return lines;
}

// Only run when this module is the process entrypoint (`tsx bin/connector-
// dev.ts ...`), not when it's `import`ed for its pure/testable exports (see
// bin/connector-dev.test.ts's direct unit-import of `resolveCaptureOnFailureEnv`/
// `classifyFailureEnvironment` — before this guard, importing them for a
// fast in-process unit test ran the ENTIRE CLI as a side effect of module
// load, exiting the test process itself). Every existing subprocess-driven
// test already runs this file as the real entrypoint via `spawnSync(...,
// ["--import", "tsx", CLI_PATH, ...])`, so `process.argv[1]` is that exact
// path in every case that matters — this guard changes nothing for them.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[connector-dev] FATAL: ${message}\n`);
    process.exitCode = 1;
  });
}
