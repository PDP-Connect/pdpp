// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized claim-eligibility evaluator (repair wave 3A, P1-1; declaration-
 * binding split and the ASSISTANCE-withholding condition added repair wave
 * 4, P1-1/P1-2; driver-evidence prerequisite added repair wave 6, P1-1;
 * recorded-browser driver support and its mandatory staleness limitation
 * added alongside `browser-har-replay.ts`; isolation-evidence-boundary and
 * repository-UDS-socket-scan conditions added by the bounded P1 repair
 * following external review of the merged tree ab415be6c).
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
 *
 * RECORDED-BROWSER IS STRUCTURALLY CAPPED AT `diagnostic_replay` — never an
 * oversight, a permanent, machine-enforced ceiling. `everyRunDeclaresRecordedHttpDriver`
 * below checks the literal `"recorded-http"`; a scenario whose runs declare
 * `"recorded-browser"` fails that condition on EVERY replay, by construction,
 * so `recorded_replay: PASS` is unreachable for a browser-driven scenario no
 * matter how many other conditions it satisfies. This is deliberate: a
 * browser replay proves DATA MAPPING (recorded network responses -> emitted
 * records), not page choreography (anti-bot JS and timer nondeterminism make
 * click/navigation sequences non-deterministically replayable), so it must
 * never read as equivalent to `recorded-http`'s stronger claim. See
 * `buildBrowserStalenessLimitation` below for the second, independent
 * enforcement this driver adds: even the weaker `diagnostic_replay: PASS` a
 * passing browser scenario earns always carries a limitation naming the
 * exact capture timestamp it was verified against, so no report or reader
 * can quote a passing browser replay without that disclaimer riding along.
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
/**
 * The recorded-browser staleness disclaimer, PARAMETERIZED on the
 * scenario's own `capture.captured_at` ISO-8601 timestamp — a TypeScript
 * template-literal type rather than a single fixed string, because the
 * timestamp is genuinely per-scenario data, not a closed enum value like
 * every other `ClaimLimitation`. This is deliberately BAKED INTO the claim
 * object (`ClaimDecision.limitations`), not left to prose printed nearby: a
 * caller reading `limitations` programmatically (or a human quoting a
 * passing browser replay out of context) gets the disclaimer riding along
 * with the PASS itself, not as a separately-droppable line. See
 * `buildBrowserStalenessLimitation` below for the single place this string
 * is constructed, and this module's doc comment for why recorded-browser can
 * never reach the unqualified `recorded_replay` claim in the first place —
 * this staleness limitation is a SECOND, independent enforcement on top of
 * that structural cap, not a substitute for it: it exists specifically so
 * that even the weaker `diagnostic_replay: PASS` a browser scenario earns
 * never reads as "still works against the live provider" on its own.
 */
export type ScenarioStalenessLimitation =
  `recorded-browser: verified against capture of ${string}; asserts nothing about the live provider`;

/**
 * The repository-UDS-socket withholding limitation, PARAMETERIZED on the
 * comma-joined list of pre-existing socket paths `findPreexistingSocketsUnderReadOnlyBinds()`
 * found under a `ro` bind for THIS run — a TypeScript template-literal type,
 * matching `ScenarioStalenessLimitation`'s own reasoning: the path(s) are
 * genuinely per-run data, not a closed enum value. See
 * `buildPreexistingSocketLimitation` below for the single place this string
 * is constructed, and this module's doc comment ("REPOSITORY-UDS EXCEPTION,
 * RECONCILED") for the reasoning: recursive read-only (isolation.ts's
 * `recursiveReadOnlyRemountCommand`) closes the ability to CREATE a socket
 * under a `ro` bind, so the only sockets an isolated child can ever dial
 * through one are sockets that ALREADY EXISTED at spawn time — a finite,
 * checkable fact about this specific run, not an open-ended exception.
 */
export type PreexistingSocketLimitation =
  `pre-existing socket(s) found under a read-only bind at spawn time, dialable despite recursive read-only: ${string}`;

/**
 * The socket-scan-incomplete limitation, PARAMETERIZED on the comma-joined
 * list of subtree paths `findPreexistingSocketsUnderReadOnlyBinds()` could
 * NOT fully enumerate (P1-2, external review of ced8300be) — distinct from
 * `PreexistingSocketLimitation` (a socket was actually FOUND) because "I
 * could not prove this subtree clean" and "I found a socket" are two
 * independently true facts a caller must be able to tell apart, matching
 * `SocketScanResult`'s own `sockets`/`errors` split. An unreadable subtree
 * (whether `chmod 000` or `chmod 311` — search-without-read, a genuinely
 * separate DAC permission, confirmed to hide a live, connectable socket
 * from enumeration exactly as effectively as `000` does) means the scan's
 * `sockets` list cannot be trusted as exhaustive, so this withholds the
 * strong claim identically to actually finding one.
 */
export type SocketScanIncompleteLimitation =
  `pre-existing-socket scan could not fully enumerate one or more read-only bind subtrees (unreadable path(s), possibly hiding a dialable socket): ${string}`;

export type ClaimLimitation =
  | "unbound entrypoint replay"
  | "no capture-time declaration digest"
  | "no capture-time source digest"
  | "current manifest missing - declaration digest not computed"
  | "current connector source missing - source digest not computed"
  | "environment driver not declared for every run"
  | "non-recorded-http driver - canonical replay is defined only for recorded-http"
  | "legacy scenario without protocol trace"
  | "network isolation: process-local only - descendant escape not excluded"
  | "network isolation: launcher trust or recursive read-only filesystem closure not proven for this run"
  | "connector exercised an evidence surface the oracle cannot observe (ASSISTANCE)"
  | "no recorded provider interaction - driver evidence for recorded-http not satisfied"
  | "no recorded HAR entries - driver evidence for recorded-browser not satisfied"
  | PreexistingSocketLimitation
  | SocketScanIncompleteLimitation
  | ScenarioStalenessLimitation;

/**
 * Builds the exact repository-UDS-socket limitation string for a run whose
 * pre-existing-socket scan found at least one match. `socketPaths` must be
 * non-empty — callers only invoke this when
 * `preexistingSocketsUnderReadOnlyBinds.length > 0` (see
 * `evaluateClaimEligibility`).
 */
export function buildPreexistingSocketLimitation(socketPaths: readonly string[]): PreexistingSocketLimitation {
  return `pre-existing socket(s) found under a read-only bind at spawn time, dialable despite recursive read-only: ${socketPaths.join(", ")}`;
}

/**
 * Builds the exact socket-scan-incomplete limitation string for a run whose
 * scan hit at least one unreadable subtree. `unreadablePaths` must be
 * non-empty — callers only invoke this when
 * `preexistingSocketScanIncomplete` is true (see `evaluateClaimEligibility`).
 */
export function buildSocketScanIncompleteLimitation(
  unreadablePaths: readonly string[]
): SocketScanIncompleteLimitation {
  return `pre-existing-socket scan could not fully enumerate one or more read-only bind subtrees (unreadable path(s), possibly hiding a dialable socket): ${unreadablePaths.join(", ")}`;
}

/**
 * Builds the exact staleness limitation string for a scenario carrying at
 * least one `recorded-browser` run — see `ScenarioStalenessLimitation`'s doc
 * comment for why this is a template, not a fixed literal. `capturedAt` is
 * `scenario.capture.captured_at` — the SAME timestamp `bin/scenario-verify.ts`
 * already prints on every `diagnostic_replay: PASS (captured ...)` line, so
 * this limitation and that prose can never disagree on which capture they're
 * naming (both read the one field, never two independently-tracked copies).
 */
export function buildBrowserStalenessLimitation(capturedAt: string): ScenarioStalenessLimitation {
  return `recorded-browser: verified against capture of ${capturedAt}; asserts nothing about the live provider`;
}

/** True when any run in `scenario` declares the `recorded-browser` network
 *  driver — the trigger condition for `buildBrowserStalenessLimitation`'s
 *  mandatory limitation. A scenario mixing drivers across runs (not produced
 *  by any recorder this build ships, but not rejected by validate.ts either)
 *  still gets the disclaimer the moment ONE run is browser-driven — the
 *  disclaimer is about what the OVERALL claim can honestly assert, and a
 *  single browser-driven run already makes "verified against the live
 *  provider" false for the scenario as a whole. */
function anyRunDeclaresBrowserDriver(scenario: ConnectorScenario): boolean {
  return scenario.runs.some((run) => run.environment?.network?.driver === "recorded-browser");
}

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
  /**
   * External review of the merged tree (ab415be6c) found the evidence
   * boundary this claim rests on was itself unproven in two ways: (1) the
   * `unshare`/`bwrap` launcher binaries were resolved through the CALLER's
   * inherited `$PATH` rather than a trusted absolute path, so a
   * PATH-prepended fake launcher could be selected in place of the real one;
   * (2) the unshare mechanism's `--rbind` submounts only had their TOP mount
   * remounted read-only — Linux does not apply `remount,ro,bind` recursively
   * — so a nested mount under a `ro` bind (e.g. `REPO_ROOT`) stayed writable.
   * Either defect lets `isNamespaceIsolationActive` read `true` (namespaces
   * genuinely exist) while the filesystem/launcher half of the OS-isolation
   * claim does not actually hold. `isNamespaceIsolationActive` alone is no
   * longer sufficient for `recorded_replay`: this field must ALSO be true,
   * set by `bin/scenario-verify.ts` only once both the trusted-launcher
   * resolution (isolation.ts's `resolveTrustedLauncherPath`) and the
   * recursive-read-only post-pivot verification
   * (`postPivotVerificationStatements`'s per-submount check) are wired in and
   * this replay's own isolated child was verified against them.
   */
  isolationEvidenceBoundaryProven: boolean;
  /** Repair wave 4 (P1-2, FIX 2d): true when this run's messages included at
   *  least one kind `TRACE_POLICY` (verify.ts) dispositions
   *  `"unsupported_claim_withheld"` — today, ASSISTANCE or ASSISTANCE_STATUS.
   *  The connector exercised an evidence surface this offline HTTP-replay
   *  oracle cannot observe, so even an otherwise-fully-eligible run must not
   *  print the unqualified `recorded_replay: PASS` claim. */
  observedUnsupportedEvidenceSurface: boolean;
  /**
   * REPOSITORY-UDS EXCEPTION, RECONCILED (P1, external review of ab415be6c):
   * a `ro` bind (e.g. `REPO_ROOT`) blocks WRITES, not reads/dials — a Unix
   * domain socket file that already existed under a `ro` bind at spawn time
   * stays dialable from inside the isolated child regardless of recursive
   * read-only, confirmed empirically (a `curl --unix-socket` against a real
   * `REPO_ROOT`-internal socket succeeds with both the trusted-launcher and
   * recursive-ro fixes applied). Recursive read-only DOES close the other
   * half: a connector cannot CREATE a new socket under a `ro` bind once
   * every submount is genuinely read-only, so the only sockets reachable
   * this way are ones that existed BEFORE the spawn — a finite, checkable
   * precondition, not an open-ended gap. `bin/scenario-verify.ts` populates
   * this from `isolation.ts`'s `findPreexistingSocketsUnderReadOnlyBinds()`,
   * run immediately before spawning. An EMPTY array means the scan found
   * nothing — combined with `isolationEvidenceBoundaryProven`, this is what
   * justifies `recorded_replay`'s OS-isolation claim being airtight for this
   * specific run; a NON-EMPTY array withholds the strong claim and names
   * every path found (see `buildPreexistingSocketLimitation`), rather than
   * silently accepting the old, undocumented, open-ended exception.
   */
  preexistingSocketsUnderReadOnlyBinds: readonly string[];
  /**
   * SCAN COMPLETENESS (P1-2, external review of ced8300be): `false` whenever
   * `findPreexistingSocketsUnderReadOnlyBinds()`'s scan could not fully
   * enumerate one or more subtrees (an unreadable directory — `readdirSync`
   * throws `EACCES` identically whether the directory is `chmod 000` or
   * `chmod 311` — search permitted, read denied, a genuinely separate DAC
   * bit that still leaves a KNOWN-name socket inside it fully connectable,
   * confirmed empirically). Gated on the SAME `else if` rung as
   * `preexistingSocketsUnderReadOnlyBinds` (see `evaluateClaimEligibility`)
   * — an incomplete scan withholds `recorded_replay` exactly like a
   * non-empty socket list does, never merely a softer warning, because an
   * incomplete scan means the empty-array case above cannot be trusted as
   * "scanned clean."
   */
  preexistingSocketScanIncomplete: boolean;
  /** Absolute paths of every subtree the scan could not enumerate — named
   *  explicitly so `buildSocketScanIncompleteLimitation`'s limitation string
   *  points at the exact path, matching this module's "name the path"
   *  discipline for every other socket-scan-derived limitation. Non-empty
   *  only when `preexistingSocketScanIncomplete` is true. */
  preexistingSocketScanUnreadablePaths: readonly string[];
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

/** True when every run declares SOME driver, whatever it is. Distinguishes
 *  "no driver declared at all" (legacy/unknown modality) from "a driver is
 *  declared, just not the one canonical replay is defined for" (e.g.
 *  `recorded-browser`). Both withhold `recorded_replay`, but saying "not
 *  declared" about a scenario that plainly declares `recorded-browser` would
 *  itself be a claim exceeding the evidence. */
function everyRunDeclaresSomeDriver(scenario: ConnectorScenario): boolean {
  return scenario.runs.every((run) => run.environment?.network?.driver !== undefined);
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
    limitations.push(
      everyRunDeclaresSomeDriver(input.scenario)
        ? "non-recorded-http driver - canonical replay is defined only for recorded-http"
        : "environment driver not declared for every run"
    );
  }
  if (!everyRunHasProtocolTrace(input.scenario)) {
    limitations.push("legacy scenario without protocol trace");
  }
  if (!input.isNamespaceIsolationActive) {
    limitations.push("network isolation: process-local only - descendant escape not excluded");
  } else if (!input.isolationEvidenceBoundaryProven) {
    limitations.push(
      "network isolation: launcher trust or recursive read-only filesystem closure not proven for this run"
    );
  } else if (input.preexistingSocketsUnderReadOnlyBinds.length > 0) {
    limitations.push(buildPreexistingSocketLimitation(input.preexistingSocketsUnderReadOnlyBinds));
  } else if (input.preexistingSocketScanIncomplete) {
    // P1-2 (external review of ced8300be): a scan that could not fully
    // enumerate a subtree is NOT the same fact as "scanned, found nothing"
    // — it must withhold the strong claim on its own rung, checked AFTER
    // the non-empty-sockets case above (a run that both found a socket AND
    // hit an unreadable subtree reports the found-socket limitation, the
    // more specific and more actionable of the two) but still strictly
    // gating `recorded_replay`, same severity as every other condition on
    // this chain.
    limitations.push(buildSocketScanIncompleteLimitation(input.preexistingSocketScanUnreadablePaths));
  }
  if (input.observedUnsupportedEvidenceSurface) {
    limitations.push("connector exercised an evidence surface the oracle cannot observe (ASSISTANCE)");
  }
  const browserDriverDeclared = anyRunDeclaresBrowserDriver(input.scenario);
  if (!input.driverEvidenceSatisfied) {
    // Repair wave: browser-driven connector verification — the two driver-
    // evidence limitation strings are DISTINCT (`wire-registry.ts`'s
    // `DRIVER_EVIDENCE_POLICIES` gives each driver its own `limitation`
    // string; this mirrors that split rather than reporting one driver's
    // failure with the other driver's wording). A scenario mixing drivers
    // across runs is not produced by any recorder this build ships, but if
    // one somehow reached here, naming the browser-specific reason whenever
    // ANY run declared that driver is more informative than silently
    // defaulting to the recorded-http wording for a browser scenario.
    limitations.push(
      browserDriverDeclared
        ? "no recorded HAR entries - driver evidence for recorded-browser not satisfied"
        : "no recorded provider interaction - driver evidence for recorded-http not satisfied"
    );
  }
  // MANDATORY, unconditional whenever any run is browser-driven — not gated
  // on any other condition failing, and not skippable by the scenario
  // otherwise being fully eligible. See this module's doc comment
  // ("RECORDED-BROWSER IS STRUCTURALLY CAPPED") for why this claim can never
  // reach `recorded_replay` in the first place (making this branch
  // unreachable from a `recorded_replay` decision) and why the disclaimer
  // still needs to be an explicit, always-present limitation rather than
  // relying on that structural cap alone: a reader inspecting `limitations`
  // should never have to infer staleness from the ABSENCE of a stronger
  // claim — it must be named.
  if (browserDriverDeclared) {
    limitations.push(buildBrowserStalenessLimitation(input.scenario.capture.captured_at));
  }

  if (limitations.length === 0) {
    return { claim: "recorded_replay" };
  }
  return { claim: "diagnostic_replay", limitations };
}
