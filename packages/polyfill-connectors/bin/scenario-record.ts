#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * scenario-record — the live-capture half of the developer capture→verify
 * loop for the connector-verification scenario harness (src/scenario/*.ts).
 *
 * Runs a connector's own entrypoint as a real subprocess, exactly the way
 * `bin/connector-dev.ts` does (`node --import tsx connectors/<name>/index.ts`,
 * START on stdin, JSONL RECORD/STATE/DONE on stdout), but with the
 * subprocess's `globalThis.fetch` patched via a `NODE_OPTIONS --import
 * <preload>` module (src/scenario/subprocess-fetch-preloads.ts's
 * `writeRecordPreload`) so every HTTP interaction it makes is captured. The
 * preload's `fetch` passes THROUGH to whatever `fetch` the subprocess would
 * otherwise use — real network by default — so this command talks to the
 * connector's real upstream with the developer's own credentials, resolved
 * from process.env exactly like `connector-dev.ts` and production.
 *
 * Captures two runs by default (`--runs 2`): run 1 from empty state (full
 * refresh), then run 2 immediately re-run seeded with run 1's ACTUAL
 * committed state (incremental narrowing) — the same two-run shape
 * connectors/oura/scenario.spike.test.ts proved against the real oura
 * connector. `--runs 1` captures only the full-refresh run.
 *
 * Writes a `pdpp.connector-scenario/1` (src/scenario/format.ts) JSON file to
 * `--out` or the default `runs/<connector>/<iso>-scenario.json` (runs/ is
 * gitignored — this is a local capture artifact, not a committed fixture).
 *
 * capture.evidence_class is computed MECHANICALLY from what this run actually
 * observed — never a hardcoded constant (see src/scenario/format.ts's
 * `ScenarioEvidenceClass` and this file's `computeEvidenceClass`).
 * `evidence_class: "synthetic-spike"` when (a) `--entrypoint` bypassed the
 * production connector registry, (b) every observed request stayed on
 * loopback (`provider_contact.loopback_only`), or (c) zero requests were
 * observed at all. `evidence_class: "non_loopback_contact_observed"` ONLY
 * when none of those hold — i.e. this run genuinely contacted the
 * connector's own registered entrypoint's real (non-loopback) upstream at
 * least once. (P1-2, repair wave 3A: this is deliberately NOT named
 * "derived-from-real" — that label claims a verified provider identity this
 * harness does not check; see format.ts's `ScenarioEvidenceClass` doc
 * comment.) `capture.provider_contact` carries the observed evidence this
 * classification is grounded in.
 * capture.privacy_class is "local-only": the scenario file may contain real
 * response bodies from the developer's own account and must not be
 * committed or shared without a scrub pass.
 *
 * capture.complete reflects recorder finalization honestly per the task's
 * verification-capture semantics: if ANY interaction fails to record, or
 * either subprocess run fails to reach a "succeeded" DONE, the scenario
 * (if written at all) is marked complete:false and this command exits
 * non-zero. A scenario with complete:false must not be treated as a
 * trustworthy replay fixture (see format.ts's ScenarioCapture doc comment).
 *
 * Usage:
 *   pnpm exec tsx bin/scenario-record.ts <connector> [--runs 1|2] [--out <path>]
 *     [--answer <id-or-index>=<value>]... [--answers <json-file>] [--persist-otp]
 *     [--streams <name,name,...>] [--timeout <seconds>]
 *
 * Example (the real developer flow — live capture against your own account):
 *   pnpm exec tsx bin/scenario-record.ts oura
 *   pnpm exec tsx bin/scenario-record.ts oura --runs 1 --out /tmp/oura-run1.json
 *   pnpm exec tsx bin/scenario-record.ts ynab --streams transactions,accounts
 *
 * ─── `--timeout <seconds>` (inactivity watchdog) ──────────────────────────
 *
 * LIVE INCIDENT: a real scoped ynab capture ran 9m20s and died with
 * "subprocess timed out" as a stack trace. Run 1 (full refresh) fit under
 * the old fixed 300s TOTAL-DURATION kill; run 2 (incremental) was executing
 * CORRECTLY — ynab's audited pacing is ~20s/request, so a ~13-request run
 * lawfully needs ~4.5 minutes — and was SIGKILLed by the harness's own
 * arbitrary ceiling, unrelated to whether the connector was making progress.
 *
 * This CLI now watches for INACTIVITY, not total duration: the window
 * resets on every byte of child stdout/stderr, so a paced connector (which
 * emits PROGRESS/RECORD lines between requests) never trips it — only a
 * genuine hang does. Default window is 300s (same number, honest inactivity
 * semantics); `--timeout <seconds>` overrides it (must be a positive
 * integer). An INTERACTION prompt pending a human's answer at a TTY
 * suspends the watchdog entirely for as long as the human takes — see
 * `createInactivityWatchdog`'s doc comment. On fire: no stack trace, just
 * the plain verdict plus whatever this run had observed so far (per-stream
 * record counts, last message seen and how long ago) — the capture is
 * incomplete by rule.
 *
 * ─── `--streams <a,b,c>` ───────────────────────────────────────────────────
 *
 * Mirrors `bin/connector-dev.ts`'s `--streams` flag exactly — same ergonomics
 * argument (stream scoping is not a new concept; `START.scope.streams`
 * already exists), same filtering of the manifest's stream list, same
 * fail-fast on an unknown name naming the manifest's actual streams. Applied
 * BEFORE every run in this capture (run 1 and, when `--runs 2`, run 2), so
 * the whole captured scenario is scoped consistently — `expected.records`
 * naturally only has entries for the scoped streams, because the recorder
 * only ever asks the connector to touch those streams. That composes
 * correctly with `scenario-verify`'s stream-set equality check
 * (src/scenario/verify.ts's FIX 2a): replay re-sends the SAME scope this
 * recorder wrote to `run.start.scope` (verified: `scenario-verify.ts`'s
 * `streamNamesFromScenario` reads `run.start.scope` verbatim, never
 * rebuilding it from the manifest), so the expected and actual stream sets
 * being compared are both already scoped to the same subset — apples to
 * apples, not a scoped capture against a full-manifest replay expectation.
 *
 * Motivating case: a real `ynab` run took 75 minutes, dominated by one paced
 * stream (see connector-dev.ts's matching doc comment for the concrete
 * numbers) — recording a full scenario for iteration on `transactions`/
 * `accounts` alone doesn't need to pay that cost every capture.
 *

 * `--entrypoint <path>` is a dev/test-only override, mirroring
 * `bin/connector-dev.ts`'s `--entrypoint` flag: bypasses the
 * `KNOWN_CONNECTOR_NAMES` manifest-registry lookup and runs the given file
 * directly (single synthetic `items` stream), so bin/scenario-cli.test.ts
 * can drive this CLI end-to-end against a test-only fixture connector
 * without registering it as a production connector or touching the network.
 *
 * Exit code: 0 on a complete, successful two-run (or one-run) capture;
 * non-zero on any recording failure (subprocess spawn error, a run that
 * doesn't reach a succeeded DONE, or a storage failure in the preload).
 *
 * ─── Interaction answering (captured into the scenario) ──────────────────
 *
 * If the connector emits a Collection Profile INTERACTION mid-run, this CLI
 * answers it exactly the way `bin/connector-dev.ts` does — same
 * `--answer`/`--answers` flag surface, same TTY-prompt fallback via
 * `src/interaction-handler.ts`'s `handleInteraction`, same fail-loud
 * behavior on a non-TTY run with no matching answer — and records the
 * prompt/response pair into that run's `ScenarioRun.user_interactions`
 * (src/scenario/format.ts, additive). `scenario-verify` replays these
 * scripted, in order, so a captured run with an unanswered/failed
 * interaction is not something `scenario-verify` could later replay
 * successfully anyway; recording still writes the scenario (with
 * `capture.complete: false`, per the existing "run didn't reach succeeded
 * DONE" path) so the failure is visible in the artifact rather than losing
 * the whole run's evidence.
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import type { InteractionResponse } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { handleInteraction, type InteractionMessage } from "../src/interaction-handler.ts";
import { hashCanonicalJson } from "@pdpp/collector-runtime";
import {
  CONNECTORS_DIR,
  getConnectorPaths,
  KNOWN_CONNECTOR_NAMES,
  MANIFEST_DIR,
  readManifest,
} from "../src/orchestrator.ts";
import type {
  ConnectorScenario,
  NormalizedTraceEntry,
  ScenarioEvidenceClass,
  ScenarioInteraction,
  ScenarioProviderContact,
  ScenarioRun,
  ScenarioUserInteraction,
} from "../src/scenario/format.ts";
import { SCENARIO_FORMAT } from "../src/scenario/format.ts";
import {
  cleanupScenarioEvidenceWorkspace,
  createScenarioEvidenceWorkspace,
  messagesToRecordsAndState,
  type ProtocolMessage,
  type ScenarioEvidenceWorkspace,
  subprocessEnv,
  writeRecordPreload,
} from "../src/scenario/subprocess-fetch-preloads.ts";
import { computeDeclarationDigest, computeSourceDigest } from "../src/scenario/validate.ts";
import { buildProtocolTrace, type RawTraceMessage } from "../src/scenario/verify.ts";
import { assertKnownMessageType } from "../src/scenario/wire-registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

dotenvConfig({ path: join(REPO_ROOT, ".env.local"), quiet: true });

/** `bin/scenario-record.ts`'s own recorder-tool version string, stamped onto
 *  `ConnectorScenario.connector.tool_version` (src/scenario/format.ts). Bump
 *  this when the recorder's OWN capture behavior changes in a way that could
 *  affect what a scenario file means (not on every unrelated code change). */
const RECORDER_TOOL_VERSION = "scenario-record/1";

// ─── sha256 digest helpers ──────────────────────────────────────────────
//
// Digest computation is delegated to src/scenario/validate.ts's shared
// implementations (the same code scenario-verify re-hashes with), so record
// and verify can never drift on digest semantics. The wrappers here only
// add the tolerant undefined-on-missing behavior recording wants.

/**
 * sha256 (hex) of a connector manifest's JSON bytes on disk, exactly as
 * written — NOT a re-serialization, so this binds to the literal file
 * `scenario-verify` will later re-hash for drift detection.
 */
function declarationDigestFor(manifestPath: string): string | undefined {
  let digest: string | undefined;
  try {
    digest = computeDeclarationDigest(manifestPath);
  } catch {
    // Missing/unreadable manifest: a digest is evidence, not a requirement.
  }
  return digest;
}

/**
 * sha256 (hex) over the connector's source directory: sorted relative paths
 * + per-file sha256, joined into one canonical text blob and hashed. Binds
 * the replay claim to the SOURCE TREE that produced the recording (see
 * `ScenarioConnectorRef.source_digest`'s doc comment in format.ts).
 */
function sourceDigestFor(connectorDir: string): string | undefined {
  let digest: string | undefined;
  try {
    if (statSync(connectorDir).isDirectory()) {
      digest = computeSourceDigest(connectorDir);
    }
  } catch {
    // Missing directory: a digest is evidence, not a requirement.
  }
  return digest;
}

// ─── Observed provider contact (grounds evidence_class) ──────────────────

const OCTET_RE = /^\d{1,3}$/;

/** Loopback per format.ts's `ScenarioProviderContact.loopback_only` doc:
 *  hostname `localhost`, `127.0.0.0/8`, or `::1`. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => OCTET_RE.test(part));
}

/**
 * Computes `ScenarioProviderContact` mechanically from every interaction
 * actually recorded across ALL runs in this capture — the evidence
 * `evidence_class` is grounded in (see this function's caller and
 * `computeEvidenceClass`). `authorities` is every distinct request origin
 * observed; `loopback_only` is true only when EVERY observed origin resolved
 * to loopback (an empty authority set is vacuously NOT loopback_only — see
 * `computeEvidenceClass`'s separate `observed_requests === 0` branch for
 * that case instead, so the two conditions stay independently legible).
 */
function computeProviderContact(interactions: readonly ScenarioInteraction[]): ScenarioProviderContact {
  const authorities = new Set<string>();
  for (const interaction of interactions) {
    authorities.add(interaction.request.origin);
  }
  const authorityList = [...authorities].sort((a, b) => a.localeCompare(b));
  const loopbackOnly =
    authorityList.length > 0 &&
    authorityList.every((authority) => {
      try {
        return isLoopbackHostname(new URL(authority).hostname);
      } catch {
        return false;
      }
    });
  const observed = interactions.length > 0;
  return {
    authorities: authorityList,
    completed_requests: interactions.length,
    loopback_only: loopbackOnly,
    observed,
    // FIX 3 (non-loopback honesty): names exactly what this mechanical
    // observation proves — a completed request to a non-loopback authority
    // — and nothing more (see `ScenarioProviderContact.basis`'s doc
    // comment). Only set when there IS non-loopback contact to name; a
    // vacuous or loopback-only capture has no such basis to claim.
    ...(observed && !loopbackOnly ? { basis: "non_loopback_contact_observed" as const } : {}),
  };
}

/**
 * Mechanically assigns `evidence_class` — NEVER a constant (per this
 * repair's task brief). `synthetic-spike` when ANY of:
 *   (a) an entrypoint override flag was used (`--entrypoint` bypasses the
 *       production manifest registry — see this file's module docstring —
 *       so there is no bound production connector this capture could be
 *       "real" evidence for);
 *   (b) `provider_contact.loopback_only` (every observed request stayed on
 *       loopback — a real upstream was never actually contacted); or
 *   (c) zero observed requests (`completed_requests === 0` — nothing was
 *       observed at all, so there's no real-contact evidence to derive from).
 * `non_loopback_contact_observed` ONLY otherwise: at least one completed
 * request, to at least one non-loopback authority, against the connector's
 * own registered entrypoint.
 *
 * P1-2 (repair wave 3A): this used to return the stronger `derived-from-real`
 * label here. That label is a provenance-and-authenticity claim this harness
 * does not verify — no authority allowlist, no provider identity check,
 * nothing beyond the mechanical observation this function actually makes.
 * `non_loopback_contact_observed` is the honest name for that observation;
 * see format.ts's `ScenarioEvidenceClass` doc comment for the full
 * rationale ("a disclaimer beside an overstrong enum does not make the label
 * safe" — third independent review, P1-2). `derived-from-real` remains
 * parse-tolerated on scenarios captured by an older recorder, but this
 * function must never mint it again.
 */
function computeEvidenceClass(
  usedEntrypointOverride: boolean,
  providerContact: ScenarioProviderContact
): ScenarioEvidenceClass {
  if (usedEntrypointOverride || providerContact.loopback_only || providerContact.completed_requests === 0) {
    return "synthetic-spike";
  }
  return "non_loopback_contact_observed";
}

function evidenceClassReason(usedEntrypointOverride: boolean, providerContact: ScenarioProviderContact): string {
  if (usedEntrypointOverride) {
    return "an --entrypoint override was used (bypasses the production connector registry)";
  }
  if (providerContact.completed_requests === 0) {
    return "zero requests were observed across the capture";
  }
  if (providerContact.loopback_only) {
    return `every observed request stayed on loopback (${providerContact.authorities.join(", ") || "no authorities"})`;
  }
  return `observed ${String(providerContact.completed_requests)} request(s) against non-loopback authorit${
    providerContact.authorities.length === 1 ? "y" : "ies"
  } (${providerContact.authorities.join(", ")})`;
}

// ─── Inactivity watchdog ────────────────────────────────────────────────
//
// LIVE INCIDENT: a real scoped ynab capture ran 9m20s and died with
// "subprocess timed out" as a FATAL stack trace. Run 1 (full refresh) fit
// under the old fixed 300s TOTAL-DURATION kill; run 2 (incremental) was
// executing CORRECTLY — ynab's audited pacing is ~20s/request, so a
// ~13-request run lawfully needs ~4.5 minutes — and was SIGKILLed by the
// harness's arbitrary total-duration ceiling, which has no relationship to
// how long a lawfully paced connector run actually needs.
//
// Fix: an INACTIVITY watchdog, not a total-duration one. The timer resets on
// every child stdout/stderr data chunk, so a paced connector (which emits
// PROGRESS/RECORD lines between requests) never trips it — only a genuine
// hang (no output at all for the whole window) does. Default window is
// still 300s (the same number the old fixed timeout used, but now with
// honest inactivity semantics instead of a total-duration ceiling);
// `--timeout <seconds>` overrides it.

const DEFAULT_INACTIVITY_WINDOW_SECONDS = 300;

/**
 * FIX 2 — partial evidence for a watchdog verdict: per-stream RECORD counts
 * (from the messages array actually observed this run) plus the last
 * message's type/label and how long ago it arrived. Shared shape between
 * the record and verify CLIs' watchdog verdicts (duplicated per-file, same
 * as the rest of this package's record/verify pairs — see e.g.
 * `handleParsedLine`'s doc comment on why these two files don't share a
 * runtime module).
 */
interface PartialCaptureEvidence {
  lastMessage?: { agoMs: number; label: string; type: string };
  streamRecordCounts: Record<string, number>;
}

/** Human-readable label for one message — RECORD/STATE/PROGRESS name the
 *  stream they belong to; PROGRESS additionally carries a `message` string;
 *  DONE/INTERACTION are self-describing by type alone. Mirrors what
 *  `EmittedMessage` (connector-runtime-protocol.ts) actually puts on each
 *  variant — see this file's `ProtocolMessage` import doc comment for why
 *  these fields are read off the raw parsed JSON rather than a narrower
 *  type. */
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

/** Builds FIX 2's partial-evidence summary from whatever messages this run's
 *  subprocess had emitted before the watchdog fired. */
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

/** Renders FIX 2's plain, no-stack-trace watchdog verdict — the observed
 *  per-stream counts, the last message seen and how long ago, and the
 *  "incomplete by rule" line. Shared render shape the two CLIs both use
 *  (duplicated per-file, see `PartialCaptureEvidence`'s doc comment). */
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
  lines.push("capture is incomplete by rule (killed mid-run)");
  return lines.join("\n");
}

/** Thrown by `createInactivityWatchdog` when its window elapses with no
 *  observed activity. Caught specially in `main().catch()` (mirrors
 *  `bin/scenario-verify.ts`'s `ScenarioValidationError` plain-verdict
 *  pattern) so an inactivity kill prints a plain, evidence-bearing verdict —
 *  never a stack trace — since a killed-for-hanging subprocess is a
 *  diagnosed verdict, not a crash in this CLI's own code. */
export class WatchdogTimeoutError extends Error {
  readonly evidence: PartialCaptureEvidence;
  readonly windowSeconds: number;

  constructor(
    windowSeconds: number,
    observed: { lastMessageSeenAt?: { at: number; label: string; type: string }; messages: readonly ProtocolMessage[] }
  ) {
    const evidence = buildPartialCaptureEvidence(observed.messages, observed.lastMessageSeenAt, Date.now());
    super(
      `[scenario-record] subprocess inactive for ${String(windowSeconds)}s - killed (window: --timeout ${String(windowSeconds)})\n${renderPartialCaptureEvidence(evidence)}`
    );
    this.name = "WatchdogTimeoutError";
    this.windowSeconds = windowSeconds;
    this.evidence = evidence;
  }
}

/**
 * Pure inactivity-timer core, extracted so its suspend/resume semantics are
 * independently unit-testable without spawning a real subprocess or a real
 * TTY (see bin/scenario-cli.test.ts's suspend/resume unit tests — an
 * INTERACTION prompt genuinely waiting on a human at a TTY is not a hang,
 * and the harness has no way to drive a real TTY prompt in an automated
 * test, so that half of the behavior is proven here instead).
 *
 * `touch()` resets the window (call on every child stdout/stderr data
 * chunk). `suspend()` cancels the pending timer without firing it (call the
 * moment an INTERACTION line is read off stdout, before this CLI starts
 * waiting on a human). `resume()` restarts a fresh full-window timer (call
 * once the INTERACTION_RESPONSE has been written back to the child's
 * stdin). `dispose()` cancels any pending timer permanently (call once the
 * child's "close"/"error" event fires, mirroring the existing
 * `clearTimeout(timer)` calls this replaces).
 *
 * Injectable `schedule`/`cancel` (defaulting to the real `setTimeout`/
 * `clearTimeout`) let tests drive suspend/resume logic deterministically
 * without waiting on real wall-clock timers.
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
  entrypoint?: string;
  out?: string;
  /** P2-1: `--persist-otp` — opts an `otp`-kind interaction response INTO
   *  verbatim persistence (the pre-repair unconditional default). Off by
   *  default: an OTP response is now redacted exactly like a credentials
   *  response unless this is explicitly set. See
   *  `bin/scenario-record.ts`'s `toScenarioUserInteraction`/`isOtpPrompt` doc
   *  comments and format.ts's `ScenarioUserInteraction` doc comment. */
  persistOtp: boolean;
  runs: 1 | 2;
  /** `--streams a,b,c` — mirrors `bin/connector-dev.ts`'s `--streams`
   *  exactly; see this file's module docstring. */
  streams?: string[];
  /** `--timeout <seconds>` — overrides `DEFAULT_INACTIVITY_WINDOW_SECONDS`
   *  for the inactivity watchdog (see this file's "Inactivity watchdog"
   *  section). Must be a positive integer. */
  timeoutSeconds: number;
}

function usageAndExit(code: number): never {
  process.stderr.write(
    "Usage: scenario-record <connector> [--runs 1|2] [--out <path>] [--answer <id-or-index>=<value>] " +
      "[--answers <json-file>] [--persist-otp] [--streams <name,name,...>] [--timeout <seconds>]\n"
  );
  process.stderr.write(`Known connectors: ${KNOWN_CONNECTOR_NAMES.join(", ")}\n`);
  process.exit(code);
}

interface MutableArgs {
  answers: string[];
  answersFile: string | undefined;
  connector: string | undefined;
  entrypoint: string | undefined;
  out: string | undefined;
  persistOtp: boolean;
  runs: 1 | 2;
  streams: string[] | undefined;
  timeoutSeconds: number;
}

/** Consumes `--out <value>` / `--entrypoint <value>` / `--answers <value>` at
 *  `argv[i]`, mutating `into[field]`. Returns the next index to resume
 *  parsing from. */
function consumeValueFlag(
  argv: readonly string[],
  i: number,
  into: MutableArgs,
  field: "entrypoint" | "out" | "answersFile"
): number {
  const value = argv[i];
  if (!value) {
    usageAndExit(2);
  }
  into[field] = value;
  return i + 1;
}

function consumeAnswerFlag(argv: readonly string[], i: number, into: MutableArgs): number {
  const value = argv[i];
  if (!value?.includes("=")) {
    process.stderr.write("--answer requires <id-or-index>=<value>\n");
    usageAndExit(2);
  }
  into.answers.push(value);
  return i + 1;
}

/** Consumes `--streams <name,name,...>` at `argv[i]` — mirrors
 *  `bin/connector-dev.ts`'s `consumeStreamsFlag` exactly. */
function consumeStreamsFlag(argv: readonly string[], i: number, into: MutableArgs): number {
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

function consumeRunsFlag(argv: readonly string[], i: number, into: MutableArgs): number {
  const value = argv[i];
  if (value !== "1" && value !== "2") {
    process.stderr.write("--runs must be 1 or 2\n");
    usageAndExit(2);
  }
  into.runs = value === "1" ? 1 : 2;
  return i + 1;
}

const POSITIVE_INTEGER_RE = /^\d+$/;

/** Consumes `--timeout <seconds>` at `argv[i]` — must be a positive integer
 *  (the inactivity watchdog window in seconds; see this file's "Inactivity
 *  watchdog" section). */
function consumeTimeoutFlag(argv: readonly string[], i: number, into: MutableArgs): number {
  const value = argv[i];
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!(value && POSITIVE_INTEGER_RE.test(value) && Number.isInteger(parsed) && parsed > 0)) {
    process.stderr.write("--timeout must be a positive integer (seconds)\n");
    usageAndExit(2);
  }
  into.timeoutSeconds = parsed;
  return i + 1;
}

/**
 * Dispatches one `argv[i - 1]` value-only flag (`--out`, `--entrypoint`,
 * `--answers`, `--answer`, `--runs`, `--streams`, `--timeout`) to its
 * consumer, mutating `into` and returning the next index to resume parsing
 * from. Returns `undefined` for any arg this dispatcher doesn't own —
 * `parseArgs` then falls through to the boolean-flag/positional/usage-exit
 * handling.
 *
 * A lookup table (rather than an if-chain ending in a bare `return;`/`return
 * undefined;`) sidesteps a known conflict between this package's biome
 * config (`noUselessUndefined`, which strips a trailing `return undefined;`)
 * and tsconfig's `noImplicitReturns` (which then rejects the resulting bare
 * `return;` on a function typed to return `number | undefined`) — mirrors
 * `bin/connector-dev.ts`'s `dispatchValueFlag`/`VALUE_FLAG_CONSUMERS`
 * exactly; see that file's doc comment for the full rationale (and
 * `bin/scenario-verify.ts`'s `firstInteractionPromptMismatch` for the same
 * tension resolved with a `??`-chain, used there because that function is a
 * pure computation rather than a side-effecting consumer). Split out of
 * `parseArgs` purely to stay under this package's cognitive-complexity lint
 * ceiling — behavior is unchanged from the fully inline if-chain version. */
const VALUE_FLAG_CONSUMERS: Record<string, (argv: readonly string[], i: number, into: MutableArgs) => number> = {
  "--out": (argv, i, into) => consumeValueFlag(argv, i, into, "out"),
  "--entrypoint": (argv, i, into) => consumeValueFlag(argv, i, into, "entrypoint"),
  "--answers": (argv, i, into) => consumeValueFlag(argv, i, into, "answersFile"),
  "--answer": consumeAnswerFlag,
  "--runs": consumeRunsFlag,
  "--streams": consumeStreamsFlag,
  "--timeout": consumeTimeoutFlag,
};

function dispatchValueFlag(arg: string, argv: readonly string[], i: number, into: MutableArgs): number | undefined {
  return VALUE_FLAG_CONSUMERS[arg]?.(argv, i, into);
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const parsed: MutableArgs = {
    connector: undefined,
    out: undefined,
    entrypoint: undefined,
    runs: 2,
    answers: [],
    answersFile: undefined,
    persistOtp: false,
    streams: undefined,
    timeoutSeconds: DEFAULT_INACTIVITY_WINDOW_SECONDS,
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
    if (arg === "--persist-otp") {
      parsed.persistOtp = true;
      // Justification requirement (P2-1): verbatim OTP persistence is an
      // explicit, printed opt-in decision the caller must own — never a
      // silent flag flip. Printed immediately at parse time so it appears
      // even if the run later fails before reaching any summary output.
      process.stdout.write("persisting OTP verbatim: caller asserts single-use/expired semantics for this provider\n");
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
    runs: parsed.runs,
    answers: parsed.answers,
    persistOtp: parsed.persistOtp,
    timeoutSeconds: parsed.timeoutSeconds,
    ...(parsed.out ? { out: parsed.out } : {}),
    ...(parsed.entrypoint ? { entrypoint: parsed.entrypoint } : {}),
    ...(parsed.answersFile ? { answersFile: parsed.answersFile } : {}),
    ...(parsed.streams ? { streams: parsed.streams } : {}),
  };
}

/** Parses `--answer <id-or-index>=<value>` entries into a map, keyed by the
 *  literal id-or-index text — mirrors `bin/connector-dev.ts`'s
 *  `parseAnswerFlags`. Only the FIRST `=` splits key from value. */
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

/** Loads `--answers <json-file>` — mirrors `bin/connector-dev.ts`'s
 *  `loadAnswersFile`. */
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

/** Mirrors `bin/connector-dev.ts`'s `resolvePreAnsweredValue`: matches by
 *  request_id first, then by 0-based arrival index. */
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

export function defaultOutPath(connector: string, isoStamp: string): string {
  const safeStamp = isoStamp.replace(/:/g, "-");
  return join(PACKAGE_ROOT, "runs", connector, `${safeStamp}-scenario.json`);
}

interface ResolvedConnector {
  /** Set only for a registry-resolved connector (never for `--entrypoint`) —
   *  the directory `source_digest` hashes. */
  connectorDir?: string;
  connectorPath: string;
  /** Set only for a registry-resolved connector — the file
   *  `declaration_digest` hashes. Absent for `--entrypoint`: there is no
   *  bound production manifest to hash a dev/test fixture path against. */
  manifestPath?: string;
  streams: readonly ManifestStream[];
  /** True when `--entrypoint` bypassed the production registry lookup —
   *  feeds `computeEvidenceClass`'s condition (a). */
  usedEntrypointOverride: boolean;
}

/**
 * Filters `allStreams` down to `--streams`' named subset — mirrors
 * `bin/connector-dev.ts`'s `filterStreamsByName` exactly (ergonomics over
 * the existing `START.scope.streams` subset mechanism, not a new concept;
 * see that function's doc comment and this file's module docstring). An
 * unknown name throws with the manifest's actual stream names, failing
 * before any subprocess spawns.
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

/**
 * `--entrypoint` mode's synthetic stream list — mirrors
 * `bin/connector-dev.ts`'s `ENTRYPOINT_MODE_STREAMS` exactly, including the
 * same reason for listing more than one name (lets a test exercise
 * `--streams` filtering through this CLI without a registered connector).
 */
const ENTRYPOINT_MODE_STREAMS: readonly ManifestStream[] = [{ name: "items" }, { name: "extras" }];

/**
 * Resolve the connector entrypoint and the streams to put on START.scope,
 * the same lookup `bin/connector-dev.ts`'s `resolveConnector` performs.
 * `--entrypoint` (dev/test-only) bypasses the registry.
 *
 * `args.streams` (from `--streams`), when present, filters whichever stream
 * list was resolved down to the named subset — applied uniformly regardless
 * of source, mirroring `bin/connector-dev.ts`'s `resolveConnector`.
 */
function resolveConnector(args: CliArgs): ResolvedConnector {
  const resolved = ((): ResolvedConnector => {
    if (args.entrypoint) {
      return { connectorPath: args.entrypoint, streams: ENTRYPOINT_MODE_STREAMS, usedEntrypointOverride: true };
    }
    if (!KNOWN_CONNECTOR_NAMES.includes(args.connector)) {
      process.stderr.write(`Unknown connector: ${args.connector}\n`);
      usageAndExit(2);
    }
    const manifest = readManifest(args.connector);
    const { connectorPath } = getConnectorPaths(args.connector);
    return {
      connectorPath,
      streams: (manifest.streams ?? []) as ManifestStream[],
      usedEntrypointOverride: false,
      manifestPath: join(MANIFEST_DIR, `${args.connector}.json`),
      connectorDir: join(CONNECTORS_DIR, args.connector),
    };
  })();
  if (!args.streams) {
    return resolved;
  }
  return { ...resolved, streams: filterStreamsByName(resolved.streams, args.streams) };
}

/**
 * Mirrors `bin/connector-dev.ts`'s `ProtocolViolationReason` — see that
 * type's doc comment for the full rationale. A recorded run's DONE(succeeded)
 * is not, by itself, proof the subprocess actually finished honestly: a
 * nonzero exit or exit-by-signal after a succeeded DONE, more than one DONE,
 * or any protocol message after the first DONE, all make the run a FAILURE
 * regardless of what the DONE itself claimed. A capture built from such a run
 * must not be trusted as a replay fixture, so `recordOneRun` folds this into
 * the same `ok: false` failure path as every other recording failure.
 */
export type ProtocolViolationReason = "nonzero_exit_after_done" | "multiple_done" | "message_after_done";

/** Computes `ProtocolViolationReason` from one subprocess run's observed
 *  exit — see that type's doc comment for the rationale. Split out of
 *  `runRecordSubprocess`'s `close` handler purely to stay under this
 *  package's cognitive-complexity lint ceiling. */
function computeProtocolViolation(args: {
  code: number | null;
  doneCount: number;
  messageAfterDone: boolean;
  messages: readonly ProtocolMessage[];
  signal: NodeJS.Signals | null;
}): ProtocolViolationReason | undefined {
  const succeededDone = args.messages.find((m) => m.type === "DONE" && m.status === "succeeded");
  // A FAILED DONE legitimately exits non-zero — see the matching comment in
  // bin/connector-dev.ts. Only a claimed SUCCESS that the exit/signal then
  // contradicts is dishonest.
  const nonzeroExitAfterSucceededDone = Boolean(succeededDone) && (args.code !== 0 || Boolean(args.signal));
  let violation: ProtocolViolationReason | undefined;
  if (args.doneCount > 1) {
    violation = "multiple_done";
  } else if (args.messageAfterDone) {
    violation = "message_after_done";
  } else if (nonzeroExitAfterSucceededDone) {
    violation = "nonzero_exit_after_done";
  }
  return violation;
}

interface RecordRunResult {
  code: number | null;
  interactions: ScenarioInteraction[];
  messages: ProtocolMessage[];
  normalizerNames: string[];
  /** FIX E: set to the offending raw line when the subprocess wrote a
   *  nonempty stdout line that failed to parse as JSON, OR (repair wave 6,
   *  P1-2 duty 1) parsed as JSON but carried a `type` that is not one of
   *  `wire-registry.ts`'s `KNOWN_MESSAGE_TYPES` — either way, a
   *  protocol-corrupt capture. `cause` distinguishes the two for an honest
   *  report message (see `handleParsedLine`'s catch site) — a well-formed
   *  JSON object with an unrecognized `type` is not "non-JSON" and must not
   *  be reported as if it were. Populated at most once (the FIRST such
   *  line): later lines don't overwrite it, so the reported line is always
   *  the first violation observed. */
  protocolCorruptLine?: { cause: "non_json" | "unknown_type"; line: string };
  /** Set when this run's DONE-finality was violated — see
   *  `ProtocolViolationReason`. Populated even when the subprocess's own
   *  DONE said `status: "succeeded"`. */
  protocolViolation?: ProtocolViolationReason;
  signal: NodeJS.Signals | null;
  stderr: string;
  storageFailed: boolean;
  /** Any unanswered-prompt failures hit during this run (non-TTY, no
   *  matching --answer) — surfaced so `recordOneRun` can report them the
   *  same way a subprocess spawn/storage failure is reported. */
  unansweredInteractions: Array<{ kind: string; message: string; requestId: string }>;
  userInteractions: ScenarioUserInteraction[];
}

/** Raw shape of a Collection Profile INTERACTION message as parsed off the
 *  subprocess's stdout JSONL — richer than `ProtocolMessage` (which doesn't
 *  model `kind`/`request_id`/`schema`/`timeout_seconds`/`message`), so this
 *  is read directly off the parsed JSON rather than through that type. */
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

/** Builds the INTERACTION_RESPONSE for a pre-supplied `--answer`/`--answers`
 *  value — mirrors `bin/connector-dev.ts`'s `buildPreAnsweredResponse`. */
function buildPreAnsweredResponse(requestId: string, value: string): InteractionResponse {
  return { type: "INTERACTION_RESPONSE", request_id: requestId, status: "success", value, data: { code: value } };
}

/** Mirrors `bin/connector-dev.ts`'s `buildUnansweredResponse`. */
function buildUnansweredResponse(requestId: string, message: string): InteractionResponse {
  return {
    type: "INTERACTION_RESPONSE",
    request_id: requestId,
    status: "cancelled",
    error: { message: `no --answer supplied and stdin is not a TTY: ${message}` },
  };
}

/**
 * `handleInteraction` (src/interaction-handler.ts) returns its own narrower
 * `InteractionResponse` type (`status: "success"|"cancelled"|"timeout"`,
 * `error.message` optional) — a pre-existing, deliberately separate type from
 * connector-runtime-protocol.ts's wire `InteractionResponse` (`status:
 * "success"|"cancelled"|"error"`, `error.message` required). The runtime's
 * own `sendInteraction` (connector-runtime.ts) only checks `type`/`request_id`
 * off stdin — it never validates `status`/`error` shape strictly — so this is
 * a safe, honest normalization at the boundary rather than a behavior change:
 * `"timeout"` maps to `"cancelled"` (the same terminal-failure family from
 * the connector's point of view), and a missing `error.message` gets a
 * fallback string so the required field is always populated.
 */
function toWireInteractionResponse(handled: {
  data?: Record<string, string>;
  error?: { code?: string; message?: string };
  request_id: string;
  status: "success" | "cancelled" | "timeout";
  type: "INTERACTION_RESPONSE";
}): InteractionResponse {
  return {
    type: "INTERACTION_RESPONSE",
    request_id: handled.request_id,
    status: handled.status === "timeout" ? "cancelled" : handled.status,
    ...(handled.data === undefined ? {} : { data: handled.data }),
    ...(handled.error === undefined ? {} : { error: { message: handled.error.message ?? "interaction failed" } }),
  };
}

/**
 * FIX C: `kind: "credentials"` prompts must never persist a real
 * value/data — see format.ts's `ScenarioUserInteraction` doc comment. This
 * strips `value`/`data` and sets `redacted: true` regardless of what the
 * connector-runtime actually sent back, and is NOT affected by
 * `--persist-otp` (that flag only ever opts an OTP-kind prompt INTO verbatim
 * persistence — it has no effect on credentials, which stay redacted
 * unconditionally).
 */
const CREDENTIALS_INTERACTION_KIND = "credentials";

function isCredentialsPrompt(prompt: RawInteractionLine): boolean {
  return prompt.kind === CREDENTIALS_INTERACTION_KIND;
}

/**
 * P2-1 (repair wave 3A, third independent review): `kind: "otp"` prompts are
 * now redacted BY DEFAULT, exactly like credentials — see format.ts's
 * `ScenarioUserInteraction` doc comment for the corrected rationale. Verbatim
 * OTP persistence (the harness's PREVIOUS unconditional default) is now
 * opt-in via `--persist-otp`, which the caller must supply deliberately,
 * asserting the single-use/expired-by-replay-time semantics that make
 * verbatim retention safe for that specific provider — the recorder cannot
 * verify that assertion itself, so it never assumes it.
 */
const OTP_INTERACTION_KIND = "otp";

function isOtpPrompt(prompt: RawInteractionLine): boolean {
  return prompt.kind === OTP_INTERACTION_KIND;
}

/** Strips volatile fields (`request_id`/`type`) into the additive
 *  `ScenarioUserInteraction` shape (src/scenario/format.ts). Redacts the
 *  response entirely for a `credentials`-kind prompt (always — see
 *  `isCredentialsPrompt`'s doc comment) or an `otp`-kind prompt UNLESS
 *  `persistOtp` is true (P2-1 — see `isOtpPrompt`'s doc comment). */
function toScenarioUserInteraction(
  seq: number,
  prompt: RawInteractionLine,
  response: InteractionResponse,
  persistOtp: boolean
): ScenarioUserInteraction {
  const mustRedact = isCredentialsPrompt(prompt) || (isOtpPrompt(prompt) && !persistOtp);
  if (mustRedact) {
    return {
      seq,
      prompt: {
        kind: prompt.kind,
        message: prompt.message,
        ...(prompt.schema ? { schema: prompt.schema } : {}),
        ...(prompt.timeout_seconds === undefined ? {} : { timeout_seconds: prompt.timeout_seconds }),
      },
      response: {
        status: response.status,
        redacted: true,
      },
    };
  }
  return {
    seq,
    prompt: {
      kind: prompt.kind,
      message: prompt.message,
      ...(prompt.schema ? { schema: prompt.schema } : {}),
      ...(prompt.timeout_seconds === undefined ? {} : { timeout_seconds: prompt.timeout_seconds }),
    },
    response: {
      status: response.status,
      ...(response.value === undefined ? {} : { value: response.value }),
      ...(response.data === undefined ? {} : { data: response.data }),
      ...(response.error === undefined ? {} : { error: response.error }),
    },
  };
}

/**
 * Spawns the connector entrypoint with the RECORD preload installed via
 * NODE_OPTIONS, drives START over stdio, and reads back the preload's
 * captured interactions once the subprocess exits (the preload writes them
 * to `capturePath` on `process.on("exit")`, since a subprocess can't return
 * data to its parent any other way).
 *
 * FIX B: `capturePath` and the generated preload module both live inside
 * `args.workspace` (a 0700 mkdtemp directory — see
 * subprocess-fetch-preloads.ts's "Secure evidence workspace" section) rather
 * than loose in the shared OS tmpdir root. The caller (`recordOneRun` via
 * `captureRuns`/`main`) owns the workspace's lifecycle and cleans it up on
 * every terminal path.
 *
 * Also answers any Collection Profile INTERACTION the connector emits
 * mid-run (same `--answer`/`--answers`/TTY-prompt/fail-loud surface as
 * `bin/connector-dev.ts`) and captures each prompt/response pair into
 * `userInteractions` for this run's `ScenarioRun.user_interactions`.
 */
function runRecordSubprocess(args: {
  answers: Record<string, string>;
  connectorPath: string;
  isTty: boolean;
  /** P2-1: when true, an `otp`-kind prompt's response is persisted
   *  verbatim (the pre-repair default); when false (the new default),
   *  it is redacted exactly like a `credentials` prompt. */
  persistOtp: boolean;
  startState: Record<string, unknown> | null;
  streams: readonly ManifestStream[];
  /** Inactivity watchdog window, in seconds — `--timeout` or
   *  `DEFAULT_INACTIVITY_WINDOW_SECONDS`. See this file's "Inactivity
   *  watchdog" section. */
  timeoutSeconds: number;
  workspace: ScenarioEvidenceWorkspace;
}): Promise<RecordRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const capturePath = join(args.workspace.dir, `capture-${String(process.pid)}-${String(Date.now())}.json`);
    const preloadPath = writeRecordPreload(capturePath, args.workspace);

    const child = spawn(process.execPath, ["--import", "tsx", args.connectorPath], {
      cwd: PACKAGE_ROOT,
      env: {
        ...subprocessEnv(),
        NODE_OPTIONS: `--import ${preloadPath}`,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PATCHRIGHT_SKIP_BROWSER_DOWNLOAD ?? "",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: ProtocolMessage[] = [];
    const userInteractions: ScenarioUserInteraction[] = [];
    const unansweredInteractions: RecordRunResult["unansweredInteractions"] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let interactionArrivalIndex = 0;
    let userInteractionSeq = 0;
    let doneCount = 0;
    let messageAfterDone = false;
    // FIX E: the FIRST nonempty stdout line that fails JSON.parse, OR
    // (repair wave 6, P1-2 duty 1) parses fine but carries an unrecognized
    // `type` — marks this run's capture incomplete and, at the CLI level,
    // exits nonzero quoting the offending line. Unlike scenario-verify's
    // REPLAY-side strictness (which fails hard mid-run), recording tolerates
    // the subprocess continuing (matches this function's pre-existing
    // "ignore, keep going" tolerance for stray output) — but the capture as
    // a whole must never be reported as trustworthy once protocol-corrupt
    // output has been observed.
    let protocolCorruptLine: { cause: "non_json" | "unknown_type"; line: string } | undefined;
    // FIX 2: the most recent message's type/label and when it arrived, kept
    // for the watchdog's partial-evidence report — "how long ago" is
    // computed against this at fire time, so the report names exactly what
    // was last observed rather than a vague "it hung".
    let lastMessageSeenAt: { at: number; label: string; type: string } | undefined;
    const watchdog = createInactivityWatchdog(args.timeoutSeconds * 1000, () => {
      child.kill("SIGKILL");
      rejectPromise(
        new WatchdogTimeoutError(args.timeoutSeconds, {
          messages,
          ...(lastMessageSeenAt === undefined ? {} : { lastMessageSeenAt }),
        })
      );
    });

    const answerInteraction = (raw: RawInteractionLine): void => {
      const arrivalIndex = interactionArrivalIndex;
      interactionArrivalIndex += 1;
      const preAnswered = resolvePreAnsweredValue(args.answers, raw.request_id, arrivalIndex);
      const record = (response: InteractionResponse): void => {
        userInteractionSeq += 1;
        userInteractions.push(toScenarioUserInteraction(userInteractionSeq, raw, response, args.persistOtp));
        child.stdin.write(`${JSON.stringify(response)}\n`);
        // CRITICAL: an operator answering an INTERACTION prompt is not a
        // hang — the watchdog was suspended the moment the INTERACTION line
        // was read (see `handleParsedLine` below); resume it now that the
        // response has actually been written back to the child's stdin.
        watchdog.resume();
      };
      if (preAnswered !== undefined) {
        record(buildPreAnsweredResponse(raw.request_id, preAnswered));
        return;
      }
      if (!args.isTty) {
        unansweredInteractions.push({ requestId: raw.request_id, kind: raw.kind, message: raw.message });
        record(buildUnansweredResponse(raw.request_id, raw.message));
        return;
      }
      const schema: InteractionMessage["schema"] = raw.schema as InteractionMessage["schema"] | undefined;
      const interactionMessage: InteractionMessage = {
        kind: raw.kind,
        message: raw.message,
        request_id: raw.request_id,
        ...(schema === undefined ? {} : { schema }),
        ...(raw.timeout_seconds === undefined ? {} : { timeout_seconds: raw.timeout_seconds }),
      };
      handleInteraction(interactionMessage, { connectorName: args.connectorPath })
        .then((response) => {
          record(toWireInteractionResponse(response));
        })
        .catch(() => undefined);
    };

    const isDoneLine = (parsed: unknown): parsed is ProtocolMessage =>
      parsed !== null && typeof parsed === "object" && (parsed as { type?: unknown }).type === "DONE";

    // Handles one already-JSON-parsed stdout line. Split out of the
    // `stdout.on("data")` handler purely to stay under this package's
    // cognitive-complexity lint ceiling — behavior is unchanged from the
    // inline version.
    //
    // Repair wave 6 (P1-2 duty 1): `assertKnownMessageType` (wire-registry.ts)
    // rejects a well-formed JSON object whose `type` is not one of
    // `EmittedMessage`'s declared kinds — thrown here, it is caught by this
    // function's caller (the `try`/`catch` around `handleParsedLine` in the
    // `stdout.on("data")` handler below), which folds it into the SAME
    // `protocolCorruptLine`/"protocol-corrupt stdout" rejection path a
    // non-JSON line already takes — an unrecognized-type message and a
    // non-JSON line are both "this line is not a valid Collection Profile
    // protocol message", so recording fails the same honest way for either.
    const handleParsedLine = (parsed: unknown): void => {
      assertKnownMessageType(parsed);
      lastMessageSeenAt = {
        at: Date.now(),
        type: (parsed as { type: string }).type,
        label: labelForMessage(parsed as ProtocolMessage),
      };
      if (doneCount > 0) {
        // A message after DONE (including a second DONE) violates DONE
        // finality — see `ProtocolViolationReason`. Still recorded (for
        // diagnostics) but must not re-trigger the stdin-close side effect.
        messageAfterDone = true;
      }
      if (isRawInteractionLine(parsed)) {
        // CRITICAL: an operator thinking at a TTY prompt is not a hang.
        // Suspend BEFORE `answerInteraction` does anything else — the TTY
        // branch inside it can wait arbitrarily long on a human via
        // `handleInteraction`, and that wait must never count against the
        // inactivity window. Resumed by `record()`'s `watchdog.resume()`
        // call above, once the response is actually written back to stdin
        // (covers every answering path: pre-answered, non-TTY-unanswered,
        // and the real TTY prompt).
        watchdog.suspend();
        answerInteraction(parsed);
        return;
      }
      if (isDoneLine(parsed)) {
        doneCount += 1;
        // See bin/connector-dev.ts's matching comment: stdin is left open
        // (not `.end()`-ed) so INTERACTION_RESPONSE writes can reach the
        // child later, so this CLI (the "runtime" from the child's point of
        // view) must end stdin once DONE is observed or connector-exit.ts's
        // flushAndExitAfterRuntimeAck hangs waiting for an EOF nobody sends.
        child.stdin.end();
      }
      messages.push(parsed as ProtocolMessage);
    };

    // Repair wave 6 (P1-2 duty 1): parses and type-checks one nonempty
    // stdout line as two separate steps so the FIRST protocol-corrupt line's
    // `cause` is reported honestly — "non_json" only when `JSON.parse`
    // itself threw, "unknown_type" when the line parsed fine but
    // `handleParsedLine`'s `assertKnownMessageType` rejected its `type`.
    // Matches connector-dev's tolerance for stray output: still drains
    // stdout and keeps the subprocess running rather than tearing it down
    // mid-run. Split out of the `stdout.on("data")` handler purely to stay
    // under this package's cognitive-complexity lint ceiling — behavior is
    // unchanged from the inline version.
    const processStdoutLine = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (protocolCorruptLine === undefined) {
          protocolCorruptLine = { line, cause: "non_json" };
        }
        return;
      }
      try {
        handleParsedLine(parsed);
      } catch {
        if (protocolCorruptLine === undefined) {
          protocolCorruptLine = { line, cause: "unknown_type" };
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      // Activity — resets the inactivity window (a no-op while suspended
      // for a pending INTERACTION; see `answerInteraction`/`handleParsedLine`
      // above).
      watchdog.touch();
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.trim()) {
          processStdoutLine(line);
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      watchdog.touch();
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      watchdog.dispose();
      rejectPromise(err);
    });
    child.on("close", (code, signal) => {
      watchdog.dispose();
      let capture: {
        incomplete?: boolean;
        interactions: ScenarioInteraction[];
        normalizerNames: string[];
        pendingAtExit?: number;
        storageFailed: boolean;
        truncatedCount?: number;
      };
      try {
        capture = JSON.parse(readFileSync(capturePath, "utf8")) as typeof capture;
      } catch (err) {
        rejectPromise(
          new Error(
            `scenario-record: failed to read capture file ${capturePath}: ${err instanceof Error ? err.message : String(err)}`
          )
        );
        return;
      }
      const protocolViolation = computeProtocolViolation({
        messages,
        doneCount,
        messageAfterDone,
        code,
        signal,
      });
      resolvePromise({
        code,
        signal,
        messages,
        stderr,
        interactions: capture.interactions,
        normalizerNames: capture.normalizerNames,
        // Any incompleteness signal from the preload (recorder storage error,
        // truncated body, or a request still in flight at exit) makes the
        // capture untrustworthy - fold them all into storageFailed so every
        // downstream complete:false path fires.
        storageFailed:
          capture.storageFailed ||
          capture.incomplete === true ||
          (capture.truncatedCount ?? 0) > 0 ||
          (capture.pendingAtExit ?? 0) > 0,
        userInteractions,
        unansweredInteractions,
        ...(protocolViolation ? { protocolViolation } : {}),
        ...(protocolCorruptLine === undefined ? {} : { protocolCorruptLine }),
      });
    });

    const startMessage = {
      type: "START",
      scope: { streams: args.streams.map((s) => ({ name: s.name })) },
      ...(args.startState === null ? {} : { state: args.startState }),
    };
    // NOT `.end()`: see the matching comment in bin/connector-dev.ts's
    // `runAndStream` — an INTERACTION mid-run needs this same stdin to carry
    // an INTERACTION_RESPONSE back later.
    child.stdin.write(`${JSON.stringify(startMessage)}\n`);
  });
}

/**
 * P1-1 (seventh review): captures `ops` alongside `ids`/`record_sha256s`,
 * index-aligned — each entry is the RECORD's normalized op
 * (`messagesToRecordsAndState`'s `op: "upsert" | "delete"` projection,
 * subprocess-fetch-preloads.ts). Always populated: `ops` is MANDATORY on
 * `ScenarioStreamExpectation` (format.ts, eighth review) — validateScenario
 * rejects any scenario missing it, so there is no legacy tier and no path
 * where this recorder could omit it.
 */
function expectedForRecords(
  records: Array<{ data: unknown; id: string; op: "upsert" | "delete"; stream: string }>
): ScenarioRun["expected"]["records"] {
  const byStream = new Map<string, Array<{ data: unknown; id: string; op: "upsert" | "delete" }>>();
  for (const r of records) {
    const bucket = byStream.get(r.stream);
    if (bucket) {
      bucket.push(r);
    } else {
      byStream.set(r.stream, [r]);
    }
  }
  const out: ScenarioRun["expected"]["records"] = {};
  for (const [stream, recs] of byStream) {
    out[stream] = {
      count: recs.length,
      ids: recs.map((r) => r.id),
      ops: recs.map((r) => r.op),
      record_sha256s: recs.map((r) => hashCanonicalJson(r.data)),
    };
  }
  return out;
}

/** Bundles the recording-run options that stay constant across run 1 and
 *  (when captured) run 2 of a single `scenario-record` invocation. Despite
 *  the name (pre-existing), also carries `timeoutSeconds` — the inactivity
 *  watchdog window is likewise a per-invocation constant threaded through
 *  every run the same way. */
interface InteractionOptions {
  answers: Record<string, string>;
  isTty: boolean;
  /** P2-1: `--persist-otp` — see `runRecordSubprocess`'s matching field doc
   *  comment. */
  persistOtp: boolean;
  /** `--timeout <seconds>` — see `runRecordSubprocess`'s matching field doc
   *  comment. */
  timeoutSeconds: number;
}

async function recordOneRun(
  connectorPath: string,
  streams: readonly ManifestStream[],
  startState: Record<string, unknown> | null,
  interactionOptions: InteractionOptions,
  workspace: ScenarioEvidenceWorkspace
): Promise<{
  finalState: Record<string, unknown>;
  interactions: ScenarioInteraction[];
  normalizerNames: string[];
  ok: boolean;
  protocolTrace: NormalizedTraceEntry[];
  records: Array<{ data: unknown; id: string; op: "upsert" | "delete"; stream: string }>;
  reason?: string;
  userInteractions: ScenarioUserInteraction[];
}> {
  const result = await runRecordSubprocess({
    connectorPath,
    streams,
    startState,
    answers: interactionOptions.answers,
    isTty: interactionOptions.isTty,
    persistOtp: interactionOptions.persistOtp,
    timeoutSeconds: interactionOptions.timeoutSeconds,
    workspace,
  });
  const done = result.messages.find((m) => m.type === "DONE");
  const { records, stateMessages } = messagesToRecordsAndState(result.messages);
  const finalState: Record<string, unknown> = { ...startState };
  for (const s of stateMessages) {
    finalState[s.stream] = s.cursor;
  }
  // FIX 1 — protocol-trace oracle: the same normalization
  // `src/scenario/verify.ts`'s `buildProtocolTrace` applies to the replaying
  // subprocess's messages, applied here to the RECORDING subprocess's
  // messages, so `expected.protocol_trace` and the actual replay trace are
  // built by the identical function. `result.messages` is every parsed
  // stdout line (JSON.parse output, cast to the narrower `ProtocolMessage`
  // type) — the runtime fields `buildProtocolTrace` reads (reason/message/
  // stream/status/error/...) are present on the underlying parsed JSON even
  // though `ProtocolMessage` doesn't model them, so this cast is safe: it is
  // the same data `messagesToRecordsAndState` above already reads off the
  // same array for RECORD/STATE.
  const protocolTrace = buildProtocolTrace(result.messages as unknown as RawTraceMessage[]);
  if (result.storageFailed) {
    return {
      ok: false,
      reason: "recorder preload reported a storage failure while capturing interactions",
      interactions: result.interactions,
      normalizerNames: result.normalizerNames,
      records,
      finalState,
      protocolTrace,
      userInteractions: result.userInteractions,
    };
  }
  // FIX E: a nonempty non-JSON stdout line means this capture is
  // protocol-corrupt — the subprocess wrote something that isn't a valid
  // Collection Profile message, so the recorded run cannot be trusted as a
  // faithful capture even if it otherwise reached a succeeded DONE. Repair
  // wave 6 (P1-2 duty 1): a well-formed JSON object whose `type` is not one
  // of `wire-registry.ts`'s `KNOWN_MESSAGE_TYPES` is reported the same way,
  // but with an honest "unrecognized type" message rather than "non-JSON
  // line" (`result.protocolCorruptLine.cause` distinguishes the two).
  if (result.protocolCorruptLine !== undefined) {
    const { cause, line } = result.protocolCorruptLine;
    const reasonDetail =
      cause === "non_json"
        ? `subprocess wrote a non-JSON line: ${JSON.stringify(line)}`
        : `subprocess wrote a protocol message with an unrecognized type: ${JSON.stringify(line)}`;
    return {
      ok: false,
      reason: `protocol-corrupt stdout: ${reasonDetail}`,
      interactions: result.interactions,
      normalizerNames: result.normalizerNames,
      records,
      finalState,
      protocolTrace,
      userInteractions: result.userInteractions,
    };
  }
  if (result.unansweredInteractions.length > 0) {
    const names = result.unansweredInteractions.map((u) => `${u.kind} (request_id=${u.requestId}): ${u.message}`);
    return {
      ok: false,
      reason: `unanswered interaction prompt(s) — no --answer supplied and stdin is not a TTY: ${names.join("; ")}`,
      interactions: result.interactions,
      normalizerNames: result.normalizerNames,
      records,
      finalState,
      protocolTrace,
      userInteractions: result.userInteractions,
    };
  }
  // A succeeded DONE is not self-certifying — see `ProtocolViolationReason`.
  // This check takes priority over the plain DONE-status check below because
  // it can fire even when `done?.status === "succeeded"`.
  if (result.protocolViolation) {
    return {
      ok: false,
      reason: `protocol_violation: ${result.protocolViolation} (DONE status=${done?.status ?? "none"}, exit code=${String(result.code)}, signal=${String(result.signal)})`,
      interactions: result.interactions,
      normalizerNames: result.normalizerNames,
      records,
      finalState,
      protocolTrace,
      userInteractions: result.userInteractions,
    };
  }
  if (done?.status !== "succeeded") {
    return {
      ok: false,
      reason: `connector run did not reach a succeeded DONE: ${JSON.stringify(done)}; stderr=${result.stderr}`,
      interactions: result.interactions,
      normalizerNames: result.normalizerNames,
      records,
      finalState,
      protocolTrace,
      userInteractions: result.userInteractions,
    };
  }
  return {
    ok: true,
    interactions: result.interactions,
    normalizerNames: result.normalizerNames,
    records,
    finalState,
    protocolTrace,
    userInteractions: result.userInteractions,
  };
}

/** FIX 3: counts one stream's cursor as a rough "how much state" signal —
 *  the number of keys for a plain-object cursor (e.g. ynab's
 *  budget-id-keyed accounts/transactions cursors), the number of entries
 *  for an array cursor, or 1 for any other (scalar/null) cursor shape.
 *  Deliberately generic and honestly labeled "entries", not "accounts" or
 *  any connector-specific noun this function can't actually verify — cursor
 *  shape varies per connector (see this function's caller's doc comment). */
function countCursorEntries(cursor: unknown): number {
  if (Array.isArray(cursor)) {
    return cursor.length;
  }
  if (cursor !== null && typeof cursor === "object") {
    return Object.keys(cursor).length;
  }
  return 1;
}

/**
 * FIX 3: run 2's "RECORDING … state seeded from run 1" line used to
 * interpolate run 1's ENTIRE final state verbatim — observed live: a 3KB
 * JSON blob of per-account fingerprints dumped straight into a progress
 * line. Replaced with a one-line-per-invocation summary: each seeded
 * stream's name and a rough entry count (see `countCursorEntries`'s doc
 * comment for what "entries" means per cursor shape — it is NOT always
 * "accounts", just whatever the cursor's own top-level shape happens to be).
 * The full state is never lost — it still lands in the scenario file's
 * `run.start.state` where any developer who needs the real value can read
 * it, exactly as it always has.
 */
function summarizeSeededState(finalState: Record<string, unknown>): string {
  const streamNames = Object.keys(finalState).sort((a, b) => a.localeCompare(b));
  if (streamNames.length === 0) {
    return "state seeded from run 1 (no streams)";
  }
  const parts = streamNames.map((name) => `${name}: ${String(countCursorEntries(finalState[name]))} cursors`);
  return `state seeded from run 1 (${parts.join(", ")})`;
}

interface CaptureRunsResult {
  complete: boolean;
  normalizerNames: Set<string>;
  runs: ScenarioRun[];
}

/** Drives run 1 (always) and, when requested and run 1 succeeded, run 2
 *  (seeded from run 1's actual committed state). Split out of `main` purely
 *  to stay under this package's cognitive-complexity lint ceiling — behavior
 *  is unchanged from the inline version. */
async function captureRuns(
  args: CliArgs,
  connectorPath: string,
  streams: readonly ManifestStream[],
  interactionOptions: InteractionOptions,
  workspace: ScenarioEvidenceWorkspace
): Promise<CaptureRunsResult> {
  process.stdout.write(`RECORDING ${args.connector} — run 1 (full refresh, state=null)\n`);
  const run1StartedAt = new Date().toISOString();
  const run1 = await recordOneRun(connectorPath, streams, null, interactionOptions, workspace);

  const runs: ScenarioRun[] = [];
  let complete = run1.ok;
  const normalizerNames = new Set(run1.normalizerNames);

  runs.push({
    // Stamp the run's actual start time so replay can pin Date.now() to it
    // (see PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV) and wall-clock-dependent
    // request planning stays deterministic across record and replay.
    clock: { fixed_now: run1StartedAt },
    // FIX 5 — modality-neutral envelope: this recorder only ever captures
    // over recorded HTTP request/response pairs, so every run it writes
    // stamps that one driver literal. See format.ts's `ScenarioRunEnvironment`.
    environment: { network: { driver: "recorded-http" } },
    start: { scope: { streams: streams.map((s) => ({ name: s.name })) }, state: null },
    interactions: run1.interactions,
    expected: {
      records: expectedForRecords(run1.records),
      final_state: run1.finalState,
      protocol_trace: run1.protocolTrace,
    },
    ...(run1.userInteractions.length > 0 ? { user_interactions: run1.userInteractions } : {}),
  });

  if (!run1.ok) {
    process.stderr.write(`FAILED run 1: ${run1.reason ?? "unknown"}\n`);
  }

  if (complete && args.runs === 2) {
    process.stdout.write(
      `RECORDING ${args.connector} — run 2 (incremental, ${summarizeSeededState(run1.finalState)})\n`
    );
    const run2StartedAt = new Date().toISOString();
    const run2 = await recordOneRun(connectorPath, streams, run1.finalState, interactionOptions, workspace);
    for (const name of run2.normalizerNames) {
      normalizerNames.add(name);
    }
    runs.push({
      clock: { fixed_now: run2StartedAt },
      environment: { network: { driver: "recorded-http" } },
      start: {
        scope: { streams: streams.map((s) => ({ name: s.name })) },
        state: run1.finalState,
        state_from_run: 0,
      },
      interactions: run2.interactions,
      expected: {
        records: expectedForRecords(run2.records),
        final_state: run2.finalState,
        protocol_trace: run2.protocolTrace,
      },
      ...(run2.userInteractions.length > 0 ? { user_interactions: run2.userInteractions } : {}),
    });
    if (!run2.ok) {
      complete = false;
      process.stderr.write(`FAILED run 2: ${run2.reason ?? "unknown"}\n`);
    }
  }

  return { runs, complete, normalizerNames };
}

interface BuiltScenario {
  declarationDigest: string | undefined;
  evidenceClass: ScenarioEvidenceClass;
  evidenceReason: string;
  providerContact: ScenarioProviderContact;
  scenario: ConnectorScenario;
  sourceDigest: string | undefined;
}

/** Grounds evidence in what was actually observed (FIX 1) and assembles the
 *  final `ConnectorScenario`. Split out of `main` purely to stay under this
 *  package's cognitive-complexity lint ceiling. */
function buildScenario(
  args: CliArgs,
  captureResult: CaptureRunsResult,
  resolved: { manifestPath: string | undefined; connectorDir: string | undefined; usedEntrypointOverride: boolean },
  capturedAt: string
): BuiltScenario {
  const { runs, complete, normalizerNames } = captureResult;
  const allInteractions = runs.flatMap((r) => r.interactions);
  const providerContact = computeProviderContact(allInteractions);
  const evidenceClass = computeEvidenceClass(resolved.usedEntrypointOverride, providerContact);
  const evidenceReason = evidenceClassReason(resolved.usedEntrypointOverride, providerContact);

  const declarationDigest = resolved.manifestPath ? declarationDigestFor(resolved.manifestPath) : undefined;
  const sourceDigest = resolved.connectorDir ? sourceDigestFor(resolved.connectorDir) : undefined;
  const hasCapturedWith = declarationDigest !== undefined || sourceDigest !== undefined;

  const scenario: ConnectorScenario = {
    format: SCENARIO_FORMAT,
    connector: {
      id: args.connector,
      tool_version: RECORDER_TOOL_VERSION,
      // DEPRECATED-BUT-TOLERATED top-level digests, kept for scenarios/tools
      // that still read them directly — see format.ts's
      // `ScenarioConnectorRef.declaration_digest`/`source_digest` doc
      // comments. `captured_with` below is the field scenario-verify's FIX D
      // report/require-capture-source logic actually reads.
      ...(declarationDigest ? { declaration_digest: declarationDigest } : {}),
      ...(sourceDigest ? { source_digest: sourceDigest } : {}),
      ...(hasCapturedWith
        ? {
            captured_with: {
              ...(declarationDigest ? { declaration_digest: declarationDigest } : {}),
              ...(sourceDigest ? { source_digest: sourceDigest } : {}),
            },
          }
        : {}),
    },
    capture: {
      captured_at: capturedAt,
      evidence_class: evidenceClass,
      privacy_class: "local-only",
      recorder_version: "scenario-record-v1",
      complete,
      provider_contact: providerContact,
    },
    ...(normalizerNames.size > 0
      ? { normalizers: [...normalizerNames].map((param) => ({ param, reason: "credential" })) }
      : {}),
    runs,
  };

  return { scenario, providerContact, evidenceClass, evidenceReason, declarationDigest, sourceDigest };
}

/** Prints the stdout summary block after the scenario file is written. Split
 *  out of `main` purely to stay under this package's cognitive-complexity
 *  lint ceiling. */
function printCaptureSummary(outPath: string, built: BuiltScenario): void {
  const { scenario, providerContact, evidenceClass, evidenceReason, declarationDigest, sourceDigest } = built;
  const { runs, capture } = scenario;
  const interactionCount = runs.reduce((sum, r) => sum + r.interactions.length, 0);
  const userInteractionCount = runs.reduce((sum, r) => sum + (r.user_interactions?.length ?? 0), 0);
  const normalizerText = scenario.normalizers?.length ? scenario.normalizers.map((n) => n.param).join(", ") : "(none)";

  process.stdout.write(`\nwrote scenario to: ${outPath}\n`);
  process.stdout.write(`runs captured: ${runs.length}\n`);
  process.stdout.write(`interactions recorded: ${interactionCount}\n`);
  process.stdout.write(`user_interactions recorded: ${userInteractionCount}\n`);
  process.stdout.write(`normalizers: ${normalizerText}\n`);
  process.stdout.write(`complete: ${String(capture.complete)}\n`);
  // P1-2 (repair wave 3A, formerly FIX 3's "non-loopback honesty"):
  // `non_loopback_contact_observed` observes non-loopback contact, not a
  // verified provider identity — the printed line must not imply more than
  // the mechanics prove (no authority allowlist/authenticity check runs
  // today). synthetic-spike's line is unaffected: it isn't the claim this
  // fix is about.
  const evidenceClassLine =
    evidenceClass === "non_loopback_contact_observed"
      ? "non_loopback_contact_observed (remote contact proven; provider authority policy not yet enforced - derived-from-real is withheld until it is)"
      : evidenceClass;
  process.stdout.write(`evidence_class: ${evidenceClassLine} — ${evidenceReason}\n`);
  process.stdout.write(
    `provider_contact: authorities=[${providerContact.authorities.join(", ")}] completed_requests=${String(
      providerContact.completed_requests
    )} loopback_only=${String(providerContact.loopback_only)} observed=${String(providerContact.observed)}\n`
  );
  process.stdout.write(
    `declaration_digest: ${declarationDigest ?? "(none — no bound manifest, e.g. --entrypoint override)"}\n`
  );
  process.stdout.write(
    `source_digest: ${sourceDigest ?? "(none — no bound connector directory, e.g. --entrypoint override)"}\n`
  );
}

/**
 * FIX B: writes the final scenario JSON atomically — a tmp file in the SAME
 * directory as `outPath` (so the subsequent rename is on the same
 * filesystem and therefore atomic, not a cross-device copy), mode 0600
 * throughout (set at write time so there is never a window where the file
 * exists world/group-readable), then `renameSync` over `outPath`. A crash or
 * kill mid-write leaves at most a stray `.tmp-*` file, never a
 * truncated/partial `outPath`.
 */
function writeScenarioAtomically(outPath: string, contents: string): void {
  const dir = dirname(outPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${String(process.pid)}-${String(Date.now())}-${basename(outPath)}`);
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  // writeFileSync's mode option only applies at file CREATION; if outPath
  // (or, defensively, this fresh tmp file for some platform-specific reason)
  // pre-existed with looser permissions, force 0600 explicitly rather than
  // trusting the create-time mode.
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, outPath);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let resolved: ResolvedConnector;
  try {
    resolved = resolveConnector(args);
  } catch (err) {
    // filterStreamsByName's unknown-stream-name error — fail before
    // spawning anything, same as every other pre-flight arg-validation
    // failure (e.g. Unknown connector, above).
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[scenario-record] FATAL: ${message}\n`);
    process.exitCode = 1;
    return;
  }
  const { connectorPath, streams, usedEntrypointOverride, manifestPath, connectorDir } = resolved;
  const answers = { ...parseAnswerFlags(args.answers), ...(args.answersFile ? loadAnswersFile(args.answersFile) : {}) };
  const isTty = Boolean(process.stdin.isTTY);

  // FIX A (record side): recording deliberately does NOT use network
  // isolation — it needs the live network to talk to the connector's real
  // upstream. Said explicitly rather than left implicit, so the honesty
  // this repair wave is about (never silently claiming a stronger isolation
  // guarantee than what actually happened) also covers the one CLI that
  // intentionally has none.
  process.stdout.write("recording network: live (unisolated by design)\n");

  // FIX B: every generated preload/capture file for this invocation lives
  // inside this single 0700 workspace, cleaned up here in `finally` on EVERY
  // terminal path — success, a captureRuns failure (complete:false, still
  // returns normally), and anything thrown before either.
  const workspace = createScenarioEvidenceWorkspace();
  try {
    const captureResult = await captureRuns(
      args,
      connectorPath,
      streams,
      { answers, isTty, persistOtp: args.persistOtp, timeoutSeconds: args.timeoutSeconds },
      workspace
    );
    const capturedAt = new Date().toISOString();
    const built = buildScenario(
      args,
      captureResult,
      { manifestPath, connectorDir, usedEntrypointOverride },
      capturedAt
    );

    const outPath = args.out ? resolve(args.out) : defaultOutPath(args.connector, capturedAt);
    writeScenarioAtomically(outPath, `${JSON.stringify(built.scenario, null, 2)}\n`);

    printCaptureSummary(outPath, built);

    if (captureResult.complete) {
      process.stdout.write(
        `\nrecorded_replay candidate scenario captured ${capturedAt} (candidate oracle - see docs/reference/connector-evidence-claims.md)\n`
      );
      process.exitCode = 0;
      return;
    }

    process.stderr.write(
      "\nRECORDING INCOMPLETE — capture.complete=false. This scenario is NOT a trustworthy replay fixture; do not use it to claim a verified replay.\n"
    );
    process.exitCode = 1;
  } finally {
    cleanupScenarioEvidenceWorkspace(workspace);
  }
}

// Only run when this module is the process entrypoint (`tsx bin/scenario-
// record.ts ...`), not when it's `import`ed for its pure/testable exports —
// mirrors `bin/connector-dev.ts`'s identical guard (see that file's doc
// comment for the full rationale): before this guard,
// `bin/scenario-cli.test.ts`'s direct unit-import of
// `createInactivityWatchdog` ran the ENTIRE CLI as a side effect of module
// load (including `usageAndExit(2)` on the test process's own argv). Every
// existing subprocess-driven test already runs this file as the real
// entrypoint via `spawnSync(..., ["--import", "tsx", RECORD_CLI_PATH,
// ...])`, so `process.argv[1]` is that exact path in every case that
// matters — this guard changes nothing for them.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    // FIX 2: a watchdog kill is a diagnosed verdict — the subprocess was
    // observed to be genuinely inactive for the whole window — not a crash
    // in this CLI's own code, so it prints plainly (no stack), mirroring
    // `bin/scenario-verify.ts`'s `ScenarioValidationError` plain-verdict
    // pattern at this same catch site.
    if (err instanceof WatchdogTimeoutError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[scenario-record] FATAL: ${message}\n`);
    process.exitCode = 1;
  });
}
