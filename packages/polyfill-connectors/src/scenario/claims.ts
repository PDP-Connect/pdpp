// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized claim-eligibility evaluator (repair wave 3A, P1-1; declaration-
 * binding split and the ASSISTANCE-withholding condition added repair wave
 * 4, P1-1/P1-2; driver-evidence prerequisite added repair wave 6, P1-1).
 *
 * `bin/scenario-verify.ts` used to print `recorded_replay: PASS` the moment
 * every per-run comparison passed — but a passing comparison only proves the
 * REPLAY matched what was recorded; it says nothing about whether the
 * replay's PROVENANCE and ISOLATION actually back the stronger claim that
 * printed line makes (a real registered connector, a genuine capture-time
 * declaration digest AND a genuine capture-time source digest EACH bound to
 * the current subject's freshly-recomputed counterpart, every run declaring
 * the transport it was captured over, a protocol-trace oracle present, the
 * replay actually run under OS-level network isolation rather than the
 * weaker process-local-only fallback, no run having exercised an evidence
 * surface — ASSISTANCE — this offline oracle cannot observe, and the
 * declared driver's own minimum-evidence bar actually being met — see
 * `wire-registry.ts`'s `DRIVER_EVIDENCE_POLICIES`). Nine independent
 * conditions, any one of which failing means `recorded_replay: PASS`
 * overclaims.
 *
 * `evaluateClaimEligibility` is the SINGLE place that decides this. It never
 * decides pass/fail (that remains `verifyScenario`'s job, unconditionally,
 * before this function is ever consulted) — it only decides WHICH positive
 * claim a passing verification is allowed to print:
 *   - every condition holds: `recorded_replay: PASS` is honest.
 *   - any condition fails: only the weaker `diagnostic_replay: PASS` is
 *     honest, printed alongside `recorded_replay: WITHHELD` and the specific
 *     `limitations` that caused the downgrade — so the failure mode is named,
 *     not just silently softer language.
 */

import type { ConnectorScenario } from "./format.ts";

/** Every independent reason `recorded_replay: PASS` can be withheld — exact,
 *  fixed strings (printed verbatim under `limitations:` and asserted on
 *  verbatim by tests), one per failed eligibility condition.
 *
 * Repair wave 4 (P1-1): the old coarse pair
 * (`capturedWithSourceDigestPresent`/`subjectDigestsComputed`) collapsed two
 * genuinely independent bindings — the DECLARATION digest binding and the
 * SOURCE digest binding — into one boolean each, so a scenario missing only
 * its declaration digest (or only its source digest) produced the exact same
 * limitation string as one missing both, or one where the current subject
 * simply had no manifest/connector directory to hash. That hid which half of
 * "capture-time identity" actually failed. The four `ClaimEligibilityInput`
 * observations below name each half precisely, and canonical `recorded_replay`
 * now requires ALL FOUR to hold — each missing one gets its OWN limitation
 * string (not a shared, vaguer one), so an operator fixing one at a time sees
 * exactly which binding still needs work. */
export type ClaimLimitation =
  | "unbound entrypoint replay"
  | "no capture-time declaration digest"
  | "no capture-time source digest"
  | "current manifest missing - declaration digest not computed"
  | "current connector source missing - source digest not computed"
  | "environment driver not declared for every run"
  | "legacy scenario without protocol trace"
  | "network isolation: process-local only - descendant escape not excluded"
  | "connector exercised an evidence surface the oracle cannot observe (ASSISTANCE)"
  | "no recorded provider interaction - driver evidence for recorded-http not satisfied";

export interface ClaimEligibilityInput {
  /** True when `scenario.connector.captured_with` (or its deprecated
   *  top-level fallback) carries a `declaration_digest` — the capture-time
   *  half of the declaration-identity binding. */
  capturedDeclarationDigestPresent: boolean;
  /** True when `scenario.connector.captured_with` (or its deprecated
   *  top-level fallback) carries a `source_digest` — the capture-time half of
   *  the source-identity binding. */
  capturedSourceDigestPresent: boolean;
  /** True when the CURRENT subject's declaration digest was actually
   *  computed this run — i.e. a bound manifest file existed to hash. Always
   *  false when `isEntrypointOverride` is true (no bound manifest to compute
   *  against). */
  currentDeclarationDigestComputed: boolean;
  /** True when the CURRENT subject's source digest was actually computed
   *  this run — i.e. a bound connector directory existed to hash. Always
   *  false when `isEntrypointOverride` is true (no bound directory to
   *  compute against). */
  currentSourceDigestComputed: boolean;
  /** Repair wave 6 (P1-1): true when EVERY run's declared driver's own
   *  minimum-evidence bar (`wire-registry.ts`'s `DRIVER_EVIDENCE_POLICIES`)
   *  is satisfied for this scenario — for `recorded-http`, at least one
   *  recorded HTTP interaction exists across the scenario's runs. Computed
   *  by `bin/scenario-verify.ts` via `wire-registry.ts`'s
   *  `driverEvidenceSatisfied` and passed in already-resolved, so this
   *  evaluator stays a pure function of its inputs (matching every other
   *  observation on this interface) rather than re-deriving driver policy
   *  itself. */
  driverEvidenceSatisfied: boolean;
  /** True when `--entrypoint` was used — an unbound (unregistered) connector
   *  replay (condition a). */
  isEntrypointOverride: boolean;
  /** True when OS-namespace isolation (isolation.ts's
   *  `isNamespaceIsolationAvailable()`) was ACTIVE for this replay, as
   *  opposed to the weaker process-local-only fallback (condition f). */
  isNamespaceIsolationActive: boolean;
  /** Repair wave 4 (P1-2, FIX 2d): true when this run's messages included at
   *  least one kind `TRACE_POLICY` (verify.ts) dispositions
   *  `"unsupported_claim_withheld"` — today, ASSISTANCE or ASSISTANCE_STATUS.
   *  The connector exercised an evidence surface this offline HTTP-replay
   *  oracle cannot observe, so even an otherwise-fully-eligible run must not
   *  print the unqualified `recorded_replay: PASS` claim. */
  observedUnsupportedEvidenceSurface: boolean;
  scenario: ConnectorScenario;
}

export type ClaimDecision =
  | { claim: "recorded_replay" }
  | { claim: "diagnostic_replay"; limitations: readonly ClaimLimitation[] };

/** Condition (d): every run declares `environment.network.driver ===
 *  "recorded-http"`. A run with no `environment` at all (legacy) fails this
 *  — see format.ts's `ScenarioRunEnvironment` doc comment: absence is "no
 *  modality claim made", which is exactly the case this eligibility gate
 *  must not treat as satisfying a driver claim. */
function everyRunDeclaresRecordedHttpDriver(scenario: ConnectorScenario): boolean {
  return scenario.runs.every((run) => run.environment?.network?.driver === "recorded-http");
}

/** Condition (e): every run carries `expected.protocol_trace`. Absent on ANY
 *  run (including a scenario captured before this field existed) fails this
 *  condition — see format.ts's `ScenarioRunExpected.protocol_trace` doc
 *  comment for why absence is "legacy scenario", not vacuously satisfied. */
function everyRunHasProtocolTrace(scenario: ConnectorScenario): boolean {
  return scenario.runs.every((run) => run.expected.protocol_trace !== undefined);
}

/**
 * Evaluates every eligibility condition independently and returns the full
 * set of limitations that fail — never short-circuits on the first failure,
 * so a scenario failing multiple conditions at once reports all of them (an
 * operator fixing one limitation at a time should see the next one
 * immediately, not play whack-a-mole one condition at a time).
 */
export function evaluateClaimEligibility(input: ClaimEligibilityInput): ClaimDecision {
  const limitations: ClaimLimitation[] = [];

  if (input.isEntrypointOverride) {
    limitations.push("unbound entrypoint replay");
  }
  // Declaration-identity binding and source-identity binding are now two
  // INDEPENDENT checks (repair wave 4, P1-1) — each of the four observations
  // gets its own exact limitation string when it fails, rather than
  // collapsing "missing capture-time digest" and "current subject
  // uncomputable" into one shared line. A scenario can fail one, some, or all
  // four; every failing one is reported.
  if (!input.capturedDeclarationDigestPresent) {
    limitations.push("no capture-time declaration digest");
  }
  if (!input.capturedSourceDigestPresent) {
    limitations.push("no capture-time source digest");
  }
  if (!input.currentDeclarationDigestComputed) {
    limitations.push("current manifest missing - declaration digest not computed");
  }
  if (!input.currentSourceDigestComputed) {
    limitations.push("current connector source missing - source digest not computed");
  }
  if (!everyRunDeclaresRecordedHttpDriver(input.scenario)) {
    limitations.push("environment driver not declared for every run");
  }
  if (!everyRunHasProtocolTrace(input.scenario)) {
    limitations.push("legacy scenario without protocol trace");
  }
  if (!input.isNamespaceIsolationActive) {
    limitations.push("network isolation: process-local only - descendant escape not excluded");
  }
  if (input.observedUnsupportedEvidenceSurface) {
    limitations.push("connector exercised an evidence surface the oracle cannot observe (ASSISTANCE)");
  }
  if (!input.driverEvidenceSatisfied) {
    limitations.push("no recorded provider interaction - driver evidence for recorded-http not satisfied");
  }

  if (limitations.length === 0) {
    return { claim: "recorded_replay" };
  }
  return { claim: "diagnostic_replay", limitations };
}
