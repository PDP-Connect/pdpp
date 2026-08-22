// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies a scenario against the real connector collect path, strictly
 * offline. For each run, in order:
 *   1. Seed state — `null`, or (when `start.state_from_run` is set) the
 *      ACTUAL final state a prior verified run in THIS verification pass
 *      emitted (never the scenario's originally-recorded `start.state`,
 *      which is reference-only).
 *   2. Execute the real collect path via `runCollector(runIndex, {fetch,
 *      emit, state})` against `createReplayFetch` for this run's
 *      interactions. `emit` is this module's own capture of the protocol's
 *      RECORD/STATE messages — the caller's collector calls it exactly like
 *      it would call the real runtime's emit/emitRecord.
 *   3. Assert per-stream record counts/ids/content hashes and the run's
 *      final committed state against `run.expected`.
 *
 * `final_state` is built the same way the reference runtime commits STATE
 * messages: `newState[stream] = cursor` per STATE message, merged onto the
 * run's seed state (see reference-implementation/runtime/index.ts's
 * `handleStateMessage`: `newState[stateStream] = msg.cursor`). This module
 * reimplements that one-line merge rather than importing the runtime, since
 * pulling in the full reference runtime here would be a much heavier
 * dependency for a single merge rule.
 *
 * ─── Protocol-trace oracle (additive) ──────────────────────────────────────
 *
 * PDPP connectors' primary truth is COMPLETENESS semantics, not just which
 * records got emitted — a connector that silently drops a detail gap instead
 * of reporting it, or that claims `DONE(succeeded)` after a run that actually
 * hit an unrecoverable provider error, has lied about completeness even if
 * every RECORD it did emit was byte-correct. `run.expected.protocol_trace`
 * (format.ts, additive) captures a normalized, emission-order projection of
 * the seven completeness-bearing message kinds (SKIP_RESULT, DETAIL_COVERAGE,
 * DETAIL_GAP, DETAIL_GAP_ATTEMPTED, DETAIL_GAP_RECOVERED,
 * DETAIL_GAPS_PAGE_REQUEST, and the terminal DONE — see `TRACE_POLICY` below
 * for the machine-enforced, exhaustive statement of every `EmittedMessage`
 * kind's disposition) so a scenario can prove them too, not just
 * RECORD/STATE.
 * `normalizeTraceMessage` (below) is the single normalization function both
 * `bin/scenario-record.ts` (building the expected trace at capture time) and
 * this module (comparing the actual trace at replay time) call, so record
 * and verify can never drift on what "the same trace" means. `verifyTrace`
 * performs the comparison and reports a `trace_mismatch` VerifyFailure naming
 * the first divergence.
 *
 * FAIL-CLOSED SHAPE CHECKING (repair wave 3B, P1-3; extended repair wave 4,
 * P2-1 to "strict parsers reject, never sanitize" — every truth-bearing
 * field, not just the top-level required ones): every tracked kind now
 * has a STRICT shape check. A message whose `type` is one of the tracked
 * kinds but fails that kind's shape check — a required field missing, wrong
 * type, or (for `detail_gap`) `reason` outside the closed enum — throws
 * `TraceNormalizationError` instead of silently normalizing to `undefined`
 * and dropping out of the trace. This applies identically whether the
 * message came from a REAL run being recorded (`bin/scenario-record.ts`'s
 * `buildProtocolTrace` call, which has no try/catch around it — a malformed
 * emit fails the recording outright) or a replay being verified (this
 * module's `verifyRun`). The previous behavior — silently returning
 * `undefined` for a malformed tracked-kind message — would have let a
 * connector emit a truncated/malformed completeness message and have it
 * vanish from the trace as if it were an untracked kind like PROGRESS,
 * exactly the silent-drop failure mode this oracle exists to catch. Untracked
 * kinds (RECORD, STATE, PROGRESS, INTERACTION, ASSISTANCE, ASSISTANCE_STATUS,
 * and anything else) are unaffected — `normalizeTraceMessage` returns
 * `undefined` for those without throwing, exactly as before.
 */

import { hashCanonicalJson } from "@pdpp/collector-runtime";
import type { EmittedMessage } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { validateRuntimeContinuationFact } from "@pdpp/connector-protocol/connector-runtime-protocol";
import type {
  ConnectorScenario,
  NormalizedTraceEntry,
  ScenarioRun,
  ScenarioStreamExpectation,
  TraceValueDigest,
} from "./format.ts";
import { createReplayFetch, type ReplayFetch } from "./replay.ts";

/**
 * Repair wave 4 (P1-2) — machine-enforced trace exhaustiveness. Every
 * `EmittedMessage["type"]` gets an explicit, named disposition here, so this
 * table (and the `satisfies Record<EmittedMessage["type"], TraceDisposition>`
 * clause on `TRACE_POLICY` below) BREAKS COMPILATION the moment
 * connector-runtime-protocol.ts's `EmittedMessage` union gains a new member
 * this table doesn't account for. This replaces the previous
 * `TRACE_NORMALIZERS` lookup table's implicit exhaustiveness (which only
 * enumerated the six TRACKED kinds and let every other kind fall through
 * `undefined` with no compiler check that the fallthrough set was actually
 * "everything else, on purpose") with an explicit, exhaustive statement of
 * intent for all thirteen kinds:
 *   - `"covered_elsewhere"` — RECORD/STATE are tracked by the separate
 *     records-and-cursor oracle (`ScenarioStreamExpectation`/`final_state`),
 *     not this trace.
 *   - `"diagnostic_excluded"` — PROGRESS; a diagnostic/operator-legibility
 *     channel, not a completeness claim (connector-runtime-protocol.ts's own
 *     doc comment on `ProgressExtra`).
 *   - `"tracked"` — the seven completeness-bearing kinds this oracle
 *     actually normalizes and compares: SKIP_RESULT, DETAIL_COVERAGE,
 *     DETAIL_GAP, DETAIL_GAP_ATTEMPTED, DETAIL_GAP_RECOVERED,
 *     DETAIL_GAPS_PAGE_REQUEST (added this wave — see `normalizeDetailGapsPageRequest`),
 *     and the terminal DONE.
 *   - `"covered_by_interaction_oracle"` — INTERACTION is verified by the
 *     separate scripted-interaction-replay oracle (bin/scenario-verify.ts's
 *     `user_interactions` script), not this trace.
 *   - `"unsupported_claim_withheld"` — ASSISTANCE/ASSISTANCE_STATUS: the
 *     browser/human-in-the-loop escalation surface this offline HTTP-replay
 *     oracle has no driver to verify against (format.ts's
 *     `NormalizedTraceEntry` doc comment, "EXCLUDED-BY-POLICY, NOT BY
 *     OVERSIGHT"). Observing either of these kinds in a run's actual
 *     messages now WITHHOLDS the canonical `recorded_replay` claim (FIX 2d,
 *     wired through `claims.ts`'s `observedUnsupportedEvidenceSurface`)
 *     rather than silently passing as if the run proved nothing unverifiable
 *     happened.
 */
export type TraceDisposition =
  | "covered_elsewhere"
  | "diagnostic_excluded"
  | "tracked"
  | "covered_by_interaction_oracle"
  | "unsupported_claim_withheld";

export const TRACE_POLICY = {
  RECORD: "covered_elsewhere",
  STATE: "covered_elsewhere",
  PROGRESS: "diagnostic_excluded",
  SKIP_RESULT: "tracked",
  DETAIL_COVERAGE: "tracked",
  DETAIL_GAP: "tracked",
  DETAIL_GAP_ATTEMPTED: "tracked",
  DETAIL_GAP_RECOVERED: "tracked",
  DETAIL_GAPS_PAGE_REQUEST: "tracked",
  DONE: "tracked",
  INTERACTION: "covered_by_interaction_oracle",
  ASSISTANCE: "unsupported_claim_withheld",
  ASSISTANCE_STATUS: "unsupported_claim_withheld",
} satisfies Record<EmittedMessage["type"], TraceDisposition>;

/** The subset of `TRACE_POLICY` keys dispositioned `"tracked"` — kept in
 *  sync with `TRACE_NORMALIZERS`' key set below by construction (both are
 *  derived from the same six-now-seven tracked kinds; a mismatch between
 *  them is caught by `scenario.test.ts`'s TRACE_POLICY-exhaustiveness test). */
const UNSUPPORTED_CLAIM_WITHHELD_TYPES: ReadonlySet<string> = new Set(
  Object.entries(TRACE_POLICY)
    .filter(([, disposition]) => disposition === "unsupported_claim_withheld")
    .map(([type]) => type)
);

/**
 * Repair wave 4 (P1-2, FIX 2d): true when `messages` includes at least one
 * message whose `type` is dispositioned `"unsupported_claim_withheld"` in
 * `TRACE_POLICY` (today: ASSISTANCE or ASSISTANCE_STATUS). Called by
 * `bin/scenario-verify.ts` on the accumulated raw messages from every run in
 * a scenario, and threaded into `evaluateClaimEligibility`
 * (`src/scenario/claims.ts`) as `observedUnsupportedEvidenceSurface` — the
 * run still verifies normally (this is NOT a verification failure), but the
 * canonical `recorded_replay` claim is withheld because the connector
 * exercised an evidence surface this oracle cannot observe.
 */
export function observedUnsupportedEvidenceSurface(messages: readonly { type: string }[]): boolean {
  return messages.some((msg) => UNSUPPORTED_CLAIM_WITHHELD_TYPES.has(msg.type));
}

/**
 * Raw shape of the seven completeness-bearing message kinds this oracle
 * tracks, as parsed off a connector subprocess's stdout JSONL (or, for an
 * in-process `RunCollector`, whatever shape that collector's own emit path
 * produces). Deliberately loose/defensive (every field optional except
 * `type`) because the source is untyped JSON either way — narrowed instance
 * by instance in `normalizeTraceMessage` below.
 */
export interface RawTraceMessage {
  considered?: unknown;
  continuation?: unknown;
  covered?: unknown;
  detail?: unknown;
  detail_locator?: unknown;
  error?: unknown;
  gap_id?: unknown;
  gap_keys?: unknown;
  hydrated_keys?: unknown;
  last_error?: unknown;
  lease_id?: unknown;
  list_cursor?: unknown;
  max_bytes?: unknown;
  message?: unknown;
  optional_skip_keys?: unknown;
  parent_stream?: unknown;
  reason?: unknown;
  record_key?: unknown;
  records_emitted?: unknown;
  recovery_hint?: unknown;
  reference_only?: unknown;
  request_id?: unknown;
  required_keys?: unknown;
  retryable?: unknown;
  state_stream?: unknown;
  status?: unknown;
  stream?: unknown;
  streams?: unknown;
  type: string;
}

/**
 * Thrown by `normalizeTraceMessage`/`buildProtocolTrace` when a message's
 * `type` is one of the six tracked completeness-bearing kinds but the
 * message fails that kind's strict shape check — see this module's
 * doc comment ("FAIL-CLOSED SHAPE CHECKING") for why this is a throw rather
 * than a silent `undefined`.
 */
export class TraceNormalizationError extends Error {
  readonly rawType: string;

  constructor(rawType: string, reason: string) {
    super(`scenario verify: malformed ${rawType} protocol message — ${reason}. Refusing to normalize it.`);
    this.name = "TraceNormalizationError";
    this.rawType = rawType;
  }
}

/**
 * Computes the `TraceValueDigest` for a field the format.ts field-disposition
 * table (`NormalizedTraceEntry`'s doc comment) marks `digested` — a PRESENCE
 * flag plus a FULL sha256 (hex) of the value's canonical JSON form.
 * `undefined`/absent normalizes to `{present: false}` (no hash computed, so
 * "absent" and "present but hashes to some value" can never collide in the
 * `present` flag itself). Digesting (not dropping) an opaque/provider-shaped
 * field still lets `verifyTrace` catch a value SUBSTITUTION — mutation test
 * (f) in scenario.test.ts — while never retaining the raw value in a
 * scenario file.
 *
 * Repair wave 4 (P2-2): this now hashes over `hashCanonicalJson` — the SAME
 * canonical-JSON sha256 routine `hashRecordDataStrict` (below) uses for
 * record-content hashing, rather than a bespoke `JSON.stringify` + truncated
 * 8-hex-char digest. Two problems with the old approach: (1) `JSON.stringify`
 * is NOT canonical (key order is insertion order, not sorted — two
 * semantically-identical objects with differently-ordered keys hashed
 * differently, a false-positive mismatch this oracle must not produce); (2)
 * an 8-hex-char (32-bit) prefix has a non-negligible birthday-bound collision
 * probability across a large corpus of distinct opaque provider ids — full
 * sha256 (like every other content hash this package computes) closes that
 * gap. `hashCanonicalJson` on `undefined` is guarded the same way
 * `hashRecordDataStrict` guards it (see `assertNoUndefinedInTree`) —
 * `digestTraceValue` itself already returns `{present: false}` before ever
 * calling `hashCanonicalJson` when `value` is `undefined`, so the wrapper's
 * undefined-rejection only matters for `undefined` nested INSIDE an
 * otherwise-present object/array (e.g. a `detail_locator` bag with a literal
 * `undefined` field) — reusing `assertNoUndefinedInTree` here keeps that
 * guarantee consistent with `hashRecordDataStrict`'s.
 */
function digestTraceValue(value: unknown): TraceValueDigest {
  if (value === undefined) {
    return { present: false };
  }
  assertNoUndefinedInTree(value, "");
  return { present: true, sha256: hashCanonicalJson(value) };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Strict parse of a completeness-bearing count field that the RUNTIME itself
 * only ever emits as an exact non-negative integer — `considered`/`covered`
 * on DETAIL_COVERAGE. Mirrors connector-runtime.ts's `buildDetailCoverageMessage`
 * emission-side guard (connector-runtime.ts:550 `considered`, connector-
 * runtime.ts:554 `covered`): `typeof x === "number" && Number.isInteger(x) &&
 * x >= 0`. That guard is inline (not exported), so this reproduces it rather
 * than importing it — reproduction, not a new layer, per this module's
 * fail-closed parity policy. A fractional, negative, `NaN`, or `Infinity`
 * value is not something the real runtime would ever put on the wire for
 * this field, so the trace oracle must reject it too rather than coercing it
 * with the looser `asNumber` used elsewhere for fields the runtime does not
 * constrain to integers (e.g. `http_status`, `max_bytes`).
 */
function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * `asNonNegativeInteger`, but for an OPTIONAL field where "present but
 * fails the check" must reject the whole message rather than silently fall
 * back to "absent" — a connector-emitted `considered: -1` or `considered:
 * 1.5` is not a legitimate omission, it is a malformed completeness claim
 * the real runtime would never produce (see `asNonNegativeInteger`'s doc
 * comment for the cited runtime guard). Returns `undefined` only when
 * `value` itself is `undefined`.
 */
function requireOptionalNonNegativeInteger(rawType: string, fieldName: string, value: unknown): number | undefined {
  if (value === undefined) {
    return;
  }
  const parsed = asNonNegativeInteger(value);
  if (parsed === undefined) {
    throw new TraceNormalizationError(
      rawType,
      `${fieldName} is present but not a non-negative integer: ${JSON.stringify(value)}`
    );
  }
  return parsed;
}

/**
 * `requireOptionalNonNegativeInteger`, but for an OPTIONAL string|number
 * identifier field (`gap_id`/`lease_id` — connector-runtime-protocol.ts
 * types every occurrence of both as `string`, even where the wire type
 * marks the field optional). Repair wave 6 (P2-2 duty 2): closes the
 * review's named hole — `digestTraceValue` alone happily digests ANY value
 * (a number, an object, a boolean), so a connector emitting `gap_id: 42`
 * previously normalized cleanly with no failure, silently accepting a shape
 * the runtime's own `string` typing would never produce. Returns `undefined`
 * only when `value` itself is `undefined` (the field is legitimately absent
 * — never true for DETAIL_GAP_ATTEMPTED's gap_id/lease_id or
 * DETAIL_GAP_RECOVERED's gap_id, which are REQUIRED on the wire; those
 * callers check for `undefined` themselves as a separate "missing required
 * field" error, so a value that reaches this helper already coming from a
 * DEFINED raw field, this only guards the TYPE).
 */
function requireOptionalIdString(rawType: string, fieldName: string, value: unknown): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new TraceNormalizationError(rawType, `${fieldName} is present but not a string: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Strict shape check for DETAIL_GAP's `detail_locator` — REQUIRED on the wire
 * (connector-runtime-protocol.ts's `DetailGapMessage.detail_locator: {kind:
 * string, [field]: ...}`, no `?`). Repair wave 6 (P2-2 duty 2): closes the
 * review's named hole — this field was previously read only via
 * `digestTraceValue(raw.detail_locator)` in `normalizeDetailGapDigests`,
 * which silently normalizes `undefined` to `{present: false}` with no
 * failure and never inspects the object's shape at all, so a DETAIL_GAP with
 * no `detail_locator`, or one whose `kind` was missing/blank/non-string,
 * previously normalized cleanly. Now: REQUIRED (missing throws), must be a
 * plain object (not an array, not `null`), and `kind` must be a non-blank
 * string. The locator's OTHER fields remain free-form (the wire type itself
 * declares `[field: string]: string | number | boolean | null | Record<...>`
 * — arbitrary provider-shaped lookup fields) and are not individually
 * type-checked here; the whole object is still digested (never retained
 * verbatim) by `normalizeDetailGapDigests`, so a malformed EXTRA field would
 * still be caught by a digest mismatch on replay even though this function
 * doesn't reject it directly.
 */
function assertDetailLocatorShape(raw: RawTraceMessage): void {
  const locator = raw.detail_locator;
  if (typeof locator !== "object" || locator === null || Array.isArray(locator)) {
    throw new TraceNormalizationError(
      "DETAIL_GAP",
      `detail_locator is required and must be an object, got ${JSON.stringify(locator)}`
    );
  }
  const { kind } = locator as Record<string, unknown>;
  if (typeof kind !== "string" || kind.trim().length === 0) {
    throw new TraceNormalizationError(
      "DETAIL_GAP",
      `detail_locator.kind is required and must be a non-blank string, got ${JSON.stringify(kind)}`
    );
  }
}

/**
 * Strict parse of a truth-bearing key array (`required_keys`/`hydrated_keys`/
 * `gap_keys`/`optional_skip_keys` on DETAIL_COVERAGE). Repair wave 4 (P2-1):
 * this used to silently FILTER OUT any element that wasn't `string | number`
 * — a best-effort sanitize that would make a connector emitting one
 * malformed key (an object, `null`, a nested array) silently lose that key
 * from the trace instead of failing the run. A key array is
 * completeness-bearing evidence (it IS the "did the connector account for
 * this exact set of items" claim); silently dropping an element changes what
 * was claimed without saying so. Now: ANY non-string/non-number element
 * anywhere in the array rejects the WHOLE message via `rawType` (caller-
 * supplied, since this helper covers multiple fields across multiple
 * kinds) — matching this module's "strict parsers reject, never sanitize"
 * policy. Returns `undefined` only when `value` itself is `undefined`
 * (the field is legitimately absent, e.g. `gap_keys`/`optional_skip_keys` on
 * a coverage message that reported no gaps) or not an array at all when
 * absence is not an option (caller decides via its own required-field check).
 */
function asKeyArray(rawType: string, fieldName: string, value: unknown): Array<string | number> | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new TraceNormalizationError(rawType, `${fieldName} is present but not an array`);
  }
  value.forEach((element, index) => {
    if (typeof element !== "string" && typeof element !== "number") {
      throw new TraceNormalizationError(
        rawType,
        `${fieldName}[${String(index)}] is ${JSON.stringify(element)} — every element must be string|number`
      );
    }
  });
  return value as Array<string | number>;
}

/**
 * A recovery_hint's normalized `{action, retryable?}` — shared shape both
 * SKIP_RESULT and DONE's error carry (connector-runtime-protocol.ts's
 * `EmittedMessage`'s `recovery_hint`/`error.recovery_hint` fields: either a
 * bare string or `{action: string; retryable?: boolean}` — `action` is
 * REQUIRED in the object form on the wire type, `retryable` optional). Split
 * out purely to keep `normalizeTraceMessage`'s per-kind helpers under this
 * package's cognitive-complexity lint ceiling.
 *
 * Repair wave 4 (P2-1): STRICT — a `recovery_hint` that is present but
 * neither a string NOR a well-shaped `{action, retryable?}` object (e.g. a
 * number, an array, an object whose `retryable` isn't a boolean) THROWS
 * `TraceNormalizationError` naming `rawType`, instead of silently coercing
 * the malformed shape down to `{}` (which used to make a malformed
 * recovery_hint indistinguishable from an absent one — exactly the
 * silent-drop failure mode this module's "strict parsers reject, never
 * sanitize" policy exists to close).
 *
 * Repair wave 6 (P2-2 duty 2): closes the review's named hole — the object
 * form's `action` was previously OPTIONAL here, so `{}` and `{retryable:
 * true}` both silently normalized to a hint carrying no `action` at all,
 * even though connector-runtime-protocol.ts's own `recovery_hint` union
 * declares `action: string` REQUIRED whenever the object form (as opposed to
 * the bare-string form) is used. `action` missing or non-string on the
 * object form now throws, same as every other required-field violation in
 * this module.
 */
function normalizeRecoveryHint(rawType: string, hint: unknown): { action: string; retryable?: boolean } | undefined {
  if (hint === undefined) {
    return;
  }
  if (typeof hint === "string") {
    return { action: hint };
  }
  if (typeof hint !== "object" || hint === null || Array.isArray(hint)) {
    throw new TraceNormalizationError(
      rawType,
      `recovery_hint is present but neither a string nor an object: ${JSON.stringify(hint)}`
    );
  }
  const record = hint as Record<string, unknown>;
  const { action, retryable } = record;
  if (typeof action !== "string") {
    throw new TraceNormalizationError(
      rawType,
      `recovery_hint is an object but action is missing or not a string (required on the object form): ${JSON.stringify(hint)}`
    );
  }
  if (retryable !== undefined && typeof retryable !== "boolean") {
    throw new TraceNormalizationError(
      rawType,
      `recovery_hint.retryable is present but not a boolean: ${JSON.stringify(retryable)}`
    );
  }
  return { action, ...(retryable === undefined ? {} : { retryable }) };
}

/**
 * Strict shape check for `SKIP_RESULT.continuation` — CALLS the runtime's own
 * emission-side validator, `validateRuntimeContinuationFact`
 * (connector-runtime-protocol.ts:247-265), directly, instead of reproducing
 * its rules here. That function is exported and already asserts EXACTLY what
 * the review demands: `boundary` a non-blank string (`Boolean(fact.boundary.
 * trim())` — rejects `""` and whitespace-only), `considered`/`covered`/
 * `slice_start`/`slice_end` each `Number.isSafeInteger(...) && >= 0` (rejects
 * fractional/negative/`NaN`/`Infinity`), `slice_end >= slice_start`, and the
 * two fixed literals `owner === "runtime"` / `remaining === true`. Calling it
 * by reference means this oracle's notion of "well-formed continuation" can
 * never drift from the runtime's own — the two cannot diverge because there
 * is only one implementation, not two kept manually in sync. Throws
 * `TraceNormalizationError` naming the malformed continuation, translating
 * the runtime validator's generic `Error` (it has no oracle-specific error
 * type) into this module's own error type so callers keep seeing
 * `TraceNormalizationError` uniformly across every field this file checks.
 */
function normalizeContinuation(raw: unknown):
  | {
      boundary: string;
      considered: number;
      covered: number;
      owner: "runtime";
      remaining: true;
      slice_start: number;
      slice_end: number;
    }
  | undefined {
  if (raw === undefined) {
    return;
  }
  try {
    validateRuntimeContinuationFact(raw);
  } catch (err) {
    // biome-ignore lint/style/useErrorCause: TraceNormalizationError's constructor (this file) takes a plain string reason, matching every other throw site in this module — the validator's message is already folded into that reason string, so nothing is lost by not also attaching `cause`.
    throw new TraceNormalizationError(
      "SKIP_RESULT",
      `continuation failed the runtime's own validateRuntimeContinuationFact check: ${err instanceof Error ? err.message : String(err)} (value: ${JSON.stringify(raw)})`
    );
  }
  return raw;
}

function normalizeSkipResult(raw: RawTraceMessage): NormalizedTraceEntry {
  const stream = asString(raw.stream);
  const reason = asString(raw.reason);
  const message = asString(raw.message);
  if (stream === undefined || reason === undefined || message === undefined) {
    throw new TraceNormalizationError(
      "SKIP_RESULT",
      "missing one or more required string fields (stream, reason, message)"
    );
  }
  const recoveryHint = normalizeRecoveryHint("SKIP_RESULT", raw.recovery_hint);
  const recoveryAction = recoveryHint?.action;
  const recoveryRetryable = recoveryHint?.retryable;
  const continuation = normalizeContinuation(raw.continuation);
  return {
    kind: "skip_result",
    stream,
    reason,
    message,
    ...(recoveryAction === undefined ? {} : { recovery_action: recoveryAction }),
    ...(recoveryRetryable === undefined ? {} : { recovery_retryable: recoveryRetryable }),
    ...(continuation === undefined ? {} : { continuation }),
  };
}

/**
 * DETAIL_COVERAGE's `reference_only` is a fixed protocol literal (`true` —
 * connector-runtime-protocol.ts's `DetailCoverageMessage`), exactly like
 * DETAIL_GAP's own status/retryable/reference_only literals. Repair wave 4
 * (P2-1): this field was previously never checked at all — a coverage
 * message missing it, or carrying `false`, normalized identically to one
 * that correctly declared `true`. Now enforced the same fail-closed way
 * `assertDetailGapFixedLiterals` enforces DETAIL_GAP's.
 */
function assertDetailCoverageReferenceOnly(raw: RawTraceMessage): void {
  if (raw.reference_only !== true) {
    throw new TraceNormalizationError(
      "DETAIL_COVERAGE",
      `reference_only must be the fixed literal true, got ${JSON.stringify(raw.reference_only)}`
    );
  }
}

function normalizeDetailCoverage(raw: RawTraceMessage): NormalizedTraceEntry {
  const stream = asString(raw.stream);
  const stateStream = asString(raw.state_stream);
  const requiredKeys = asKeyArray("DETAIL_COVERAGE", "required_keys", raw.required_keys);
  const hydratedKeys = asKeyArray("DETAIL_COVERAGE", "hydrated_keys", raw.hydrated_keys);
  if (stream === undefined || stateStream === undefined || requiredKeys === undefined || hydratedKeys === undefined) {
    throw new TraceNormalizationError(
      "DETAIL_COVERAGE",
      "missing one or more required fields (stream, state_stream, required_keys[], hydrated_keys[])"
    );
  }
  assertDetailCoverageReferenceOnly(raw);
  const gapKeys = asKeyArray("DETAIL_COVERAGE", "gap_keys", raw.gap_keys);
  const optionalSkipKeys = asKeyArray("DETAIL_COVERAGE", "optional_skip_keys", raw.optional_skip_keys);
  const considered = requireOptionalNonNegativeInteger("DETAIL_COVERAGE", "considered", raw.considered);
  const covered = requireOptionalNonNegativeInteger("DETAIL_COVERAGE", "covered", raw.covered);
  return {
    kind: "detail_coverage",
    stream,
    state_stream: stateStream,
    required_keys: requiredKeys,
    hydrated_keys: hydratedKeys,
    ...(gapKeys === undefined ? {} : { gap_keys: gapKeys }),
    ...(optionalSkipKeys === undefined ? {} : { optional_skip_keys: optionalSkipKeys }),
    ...(considered === undefined ? {} : { considered }),
    ...(covered === undefined ? {} : { covered }),
  };
}

type DetailGapReason = "rate_limited" | "retry_exhausted" | "temporary_unavailable" | "upstream_pressure";
const DETAIL_GAP_REASONS: ReadonlySet<string> = new Set([
  "rate_limited",
  "retry_exhausted",
  "temporary_unavailable",
  "upstream_pressure",
]);

function isDetailGapReason(value: unknown): value is DetailGapReason {
  return typeof value === "string" && DETAIL_GAP_REASONS.has(value);
}

/** DETAIL_GAP's status/retryable/reference_only are fixed protocol literals
 *  (connector-runtime-protocol.ts's `DetailGapMessage`) — compared-directly
 *  per the field-disposition table, so their strict check IS the value
 *  check: any other value is a malformed message, not a legitimate variant.
 *  Split out purely to keep `normalizeDetailGap` under this package's
 *  cognitive-complexity lint ceiling. */
function assertDetailGapFixedLiterals(raw: RawTraceMessage): void {
  if (raw.status !== "pending" || raw.retryable !== true || raw.reference_only !== true) {
    throw new TraceNormalizationError(
      "DETAIL_GAP",
      `status/retryable/reference_only must be the fixed literals "pending"/true/true, got ${JSON.stringify({ status: raw.status, retryable: raw.retryable, reference_only: raw.reference_only })}`
    );
  }
}

/**
 * Strict shape check + normalize for `DetailGapNetworkPressure`
 * (connector-runtime-protocol.ts) carried on DETAIL_GAP's `detail`/
 * `last_error` — repair wave 4 FIX 2b. `error_class`/`method` REQUIRED
 * strings, `status` optional number, all three compared-directly;
 * `endpoint_route` REQUIRED string, digested (see format.ts's
 * `NormalizedNetworkPressure`/field-disposition table for why —
 * privacy-safe: a route may embed provider-shaped identifiers).
 * `attempt`/`max_attempts`/`retry_after_ms`/`safe_headers` are read only to
 * validate they're well-typed WHEN present (never surfaced in the returned
 * shape — excluded-volatile per the NORMALIZATION list). Returns `undefined`
 * when `raw` itself is `undefined` (no network_pressure on this
 * detail/last_error at all — legitimate absence). Throws
 * `TraceNormalizationError` on any other malformed shape — repair wave 4
 * P2-1 "strict parsers reject, never sanitize".
 */
function normalizeNetworkPressure(
  rawType: string,
  fieldPath: string,
  raw: unknown
): { error_class: string; method: string; status?: number; endpoint_route_digest: TraceValueDigest } | undefined {
  if (raw === undefined) {
    return;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TraceNormalizationError(rawType, `${fieldPath} is present but not an object`);
  }
  const pressure = raw as Record<string, unknown>;
  const errorClass = asString(pressure.error_class);
  const method = asString(pressure.method);
  const endpointRoute = asString(pressure.endpoint_route);
  if (errorClass === undefined || method === undefined || endpointRoute === undefined) {
    throw new TraceNormalizationError(
      rawType,
      `${fieldPath} is missing one or more required string fields (error_class, method, endpoint_route): ${JSON.stringify(pressure)}`
    );
  }
  const status = pressure.status === undefined ? undefined : asNumber(pressure.status);
  if (pressure.status !== undefined && status === undefined) {
    throw new TraceNormalizationError(rawType, `${fieldPath}.status is present but not a finite number`);
  }
  if (pressure.attempt !== undefined && asNumber(pressure.attempt) === undefined) {
    throw new TraceNormalizationError(rawType, `${fieldPath}.attempt is present but not a finite number`);
  }
  if (pressure.max_attempts !== undefined && asNumber(pressure.max_attempts) === undefined) {
    throw new TraceNormalizationError(rawType, `${fieldPath}.max_attempts is present but not a finite number`);
  }
  if (pressure.retry_after_ms !== undefined && asNumber(pressure.retry_after_ms) === undefined) {
    throw new TraceNormalizationError(rawType, `${fieldPath}.retry_after_ms is present but not a finite number`);
  }
  if (
    pressure.safe_headers !== undefined &&
    (typeof pressure.safe_headers !== "object" ||
      pressure.safe_headers === null ||
      Array.isArray(pressure.safe_headers))
  ) {
    throw new TraceNormalizationError(rawType, `${fieldPath}.safe_headers is present but not an object`);
  }
  return {
    error_class: errorClass,
    method,
    ...(status === undefined ? {} : { status }),
    endpoint_route_digest: digestTraceValue(endpointRoute),
  };
}

/**
 * DETAIL_GAP's optional `detail`/`last_error` diagnostic sub-objects,
 * flattened to the same fields `normalizeDetailGap` returns. Split out
 * purely to keep `normalizeDetailGap` under this package's
 * cognitive-complexity lint ceiling.
 *
 * Repair wave 4 (P2-1): `detail`/`last_error` themselves are now
 * VALIDATED-OR-FAIL, not silently cast-and-read — a `detail`/`last_error`
 * that is present but not an object throws, rather than making every field
 * read off it silently evaluate to `undefined` (indistinguishable from the
 * sub-object being entirely absent). `class`/`http_status`/`message` are
 * still individually optional (a class-only or status-only diagnostic is a
 * legitimate partial report per the runtime's own typing), but a
 * WRONG-TYPED value for a field that IS present (e.g. `class: 42`) now
 * throws instead of silently reading as absent. `network_pressure` (FIX 2b)
 * is validated by `normalizeNetworkPressure`.
 */
function assertDiagnosticObjectShape(
  rawType: string,
  fieldPath: string,
  value: unknown
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TraceNormalizationError(rawType, `${fieldPath} is present but not an object`);
  }
  return value as Record<string, unknown>;
}

interface NormalizedDetailDiagnostic {
  detailClass?: string;
  detailHttpStatus?: number;
  detailNetworkPressure?: {
    error_class: string;
    method: string;
    status?: number;
    endpoint_route_digest: TraceValueDigest;
  };
}

interface NormalizedLastErrorDiagnostic {
  lastErrorClass?: string;
  lastErrorHttpStatus?: number;
  lastErrorMessage?: string;
  lastErrorNetworkPressure?: {
    error_class: string;
    method: string;
    status?: number;
    endpoint_route_digest: TraceValueDigest;
  };
}

/** The `detail` half of `normalizeDetailGapDiagnostics` — split out purely to
 *  keep both halves, and the function that combines them, under this
 *  package's cognitive-complexity lint ceiling. */
function normalizeDetailGapDetail(detail: Record<string, unknown> | undefined): NormalizedDetailDiagnostic {
  const detailClass = detail ? asString(detail.class) : undefined;
  if (detail?.class !== undefined && detailClass === undefined) {
    throw new TraceNormalizationError("DETAIL_GAP", "detail.class is present but not a string");
  }
  const detailHttpStatus = detail ? asNumber(detail.http_status) : undefined;
  if (detail?.http_status !== undefined && detailHttpStatus === undefined) {
    throw new TraceNormalizationError("DETAIL_GAP", "detail.http_status is present but not a finite number");
  }
  const detailNetworkPressure = detail
    ? normalizeNetworkPressure("DETAIL_GAP", "detail.network_pressure", detail.network_pressure)
    : undefined;
  return {
    ...(detailClass === undefined ? {} : { detailClass }),
    ...(detailHttpStatus === undefined ? {} : { detailHttpStatus }),
    ...(detailNetworkPressure === undefined ? {} : { detailNetworkPressure }),
  };
}

/** The `last_error` half of `normalizeDetailGapDiagnostics` — split out
 *  purely to keep both halves, and the function that combines them, under
 *  this package's cognitive-complexity lint ceiling. */
function normalizeDetailGapLastError(lastError: Record<string, unknown> | undefined): NormalizedLastErrorDiagnostic {
  const lastErrorClass = lastError ? asString(lastError.class) : undefined;
  if (lastError?.class !== undefined && lastErrorClass === undefined) {
    throw new TraceNormalizationError("DETAIL_GAP", "last_error.class is present but not a string");
  }
  const lastErrorHttpStatus = lastError ? asNumber(lastError.http_status) : undefined;
  if (lastError?.http_status !== undefined && lastErrorHttpStatus === undefined) {
    throw new TraceNormalizationError("DETAIL_GAP", "last_error.http_status is present but not a finite number");
  }
  const lastErrorMessage = lastError ? asString(lastError.message) : undefined;
  if (lastError?.message !== undefined && lastErrorMessage === undefined) {
    throw new TraceNormalizationError("DETAIL_GAP", "last_error.message is present but not a string");
  }
  const lastErrorNetworkPressure = lastError
    ? normalizeNetworkPressure("DETAIL_GAP", "last_error.network_pressure", lastError.network_pressure)
    : undefined;
  return {
    ...(lastErrorClass === undefined ? {} : { lastErrorClass }),
    ...(lastErrorHttpStatus === undefined ? {} : { lastErrorHttpStatus }),
    ...(lastErrorMessage === undefined ? {} : { lastErrorMessage }),
    ...(lastErrorNetworkPressure === undefined ? {} : { lastErrorNetworkPressure }),
  };
}

function normalizeDetailGapDiagnostics(
  raw: RawTraceMessage
): { parentStream?: string } & NormalizedDetailDiagnostic & NormalizedLastErrorDiagnostic {
  const detail = assertDiagnosticObjectShape("DETAIL_GAP", "detail", raw.detail);
  const lastError = assertDiagnosticObjectShape("DETAIL_GAP", "last_error", raw.last_error);
  const parentStream = asString(raw.parent_stream);
  if (raw.parent_stream !== undefined && parentStream === undefined) {
    throw new TraceNormalizationError("DETAIL_GAP", "parent_stream is present but not a string");
  }
  return {
    ...(parentStream === undefined ? {} : { parentStream }),
    ...normalizeDetailGapDetail(detail),
    ...normalizeDetailGapLastError(lastError),
  };
}

/** DETAIL_GAP's digested fields (gap_id/lease_id/list_cursor/detail_locator)
 *  — see format.ts's field-disposition table. Split out purely to keep
 *  `normalizeDetailGap` under this package's cognitive-complexity lint
 *  ceiling.
 *
 *  Repair wave 6 (P2-2 duty 2): `gap_id`/`lease_id` now go through
 *  `requireOptionalIdString` before digesting — validated-when-present per
 *  the wire type's `string` typing (a numeric gap_id/lease_id now throws
 *  instead of silently digesting whatever value was present). */
function normalizeDetailGapDigests(raw: RawTraceMessage): {
  gap_id_digest?: TraceValueDigest;
  lease_id_digest?: TraceValueDigest;
  list_cursor_digest?: TraceValueDigest;
  detail_locator_digest?: TraceValueDigest;
} {
  const gapId = requireOptionalIdString("DETAIL_GAP", "gap_id", raw.gap_id);
  const leaseId = requireOptionalIdString("DETAIL_GAP", "lease_id", raw.lease_id);
  const gapIdDigest = digestTraceValue(gapId);
  const leaseIdDigest = digestTraceValue(leaseId);
  const listCursorDigest = digestTraceValue(raw.list_cursor);
  const detailLocatorDigest = digestTraceValue(raw.detail_locator);
  return {
    ...(gapIdDigest.present ? { gap_id_digest: gapIdDigest } : {}),
    ...(leaseIdDigest.present ? { lease_id_digest: leaseIdDigest } : {}),
    ...(listCursorDigest.present ? { list_cursor_digest: listCursorDigest } : {}),
    ...(detailLocatorDigest.present ? { detail_locator_digest: detailLocatorDigest } : {}),
  };
}

function normalizeDetailGap(raw: RawTraceMessage): NormalizedTraceEntry {
  const stream = asString(raw.stream);
  const { reason } = raw;
  const recordKeyRaw = raw.record_key;
  const recordKey = typeof recordKeyRaw === "string" || typeof recordKeyRaw === "number" ? recordKeyRaw : undefined;
  if (stream === undefined || recordKey === undefined || !isDetailGapReason(reason)) {
    throw new TraceNormalizationError(
      "DETAIL_GAP",
      "missing stream/record_key, or reason is not one of the closed enum values"
    );
  }
  assertDetailGapFixedLiterals(raw);
  // Repair wave 6 (P2-2 duty 2): detail_locator is REQUIRED on the wire —
  // see `assertDetailLocatorShape`'s doc comment.
  assertDetailLocatorShape(raw);
  const {
    parentStream,
    detailClass,
    detailHttpStatus,
    detailNetworkPressure,
    lastErrorClass,
    lastErrorHttpStatus,
    lastErrorMessage,
    lastErrorNetworkPressure,
  } = normalizeDetailGapDiagnostics(raw);
  return {
    kind: "detail_gap",
    stream,
    reason,
    record_key: recordKey,
    status: "pending",
    retryable: true,
    reference_only: true,
    // Repair wave 4: explicit snake_case mapping — the diagnostics helper's
    // return shape is camelCase (matching this module's internal-variable
    // convention); `NormalizedTraceEntry`'s `detail_gap` fields are
    // snake_case (matching the trace's on-disk JSON convention). A prior
    // version of this function spread the camelCase object directly, which
    // TypeScript's structural excess-property check does not catch through
    // a spread — the camelCase keys silently rode along as extra properties
    // that never matched any `NormalizedTraceEntry` field name, so
    // `parent_stream`/`detail_class`/etc. were NEVER actually populated by
    // this normalizer. Mapped explicitly here so the trace entry the
    // verifier builds actually carries the fields format.ts's type declares.
    ...(parentStream === undefined ? {} : { parent_stream: parentStream }),
    ...(detailClass === undefined ? {} : { detail_class: detailClass }),
    ...(detailHttpStatus === undefined ? {} : { detail_http_status: detailHttpStatus }),
    ...(detailNetworkPressure === undefined ? {} : { detail_network_pressure: detailNetworkPressure }),
    ...(lastErrorClass === undefined ? {} : { last_error_class: lastErrorClass }),
    ...(lastErrorHttpStatus === undefined ? {} : { last_error_http_status: lastErrorHttpStatus }),
    ...(lastErrorMessage === undefined ? {} : { last_error_message: lastErrorMessage }),
    ...(lastErrorNetworkPressure === undefined ? {} : { last_error_network_pressure: lastErrorNetworkPressure }),
    ...normalizeDetailGapDigests(raw),
  };
}

/**
 * DETAIL_GAP_ATTEMPTED (repair wave 3B) — connector-runtime-protocol.ts's
 * `DetailGapAttemptedMessage`: `gap_id`/`lease_id` REQUIRED strings (both
 * digested — see format.ts's field-disposition table), `reference_only:
 * true` fixed.
 *
 * Repair wave 6 (P2-2 duty 2): the wire type declares BOTH `gap_id` and
 * `lease_id` as `string` (not `string | number`) — this previously accepted
 * either type before digesting, which is looser than the runtime type
 * declares. Now: present-but-not-a-string (e.g. a number) rejects, matching
 * "enforce exactly what the runtime type declares" for this required field.
 */
function normalizeDetailGapAttempted(raw: RawTraceMessage): NormalizedTraceEntry {
  const stream = asString(raw.stream);
  const gapId = asString(raw.gap_id);
  const leaseId = asString(raw.lease_id);
  if (stream === undefined || gapId === undefined || leaseId === undefined) {
    throw new TraceNormalizationError(
      "DETAIL_GAP_ATTEMPTED",
      `missing or non-string stream, gap_id, or lease_id (all required strings on the wire): ${JSON.stringify({ stream: raw.stream, gap_id: raw.gap_id, lease_id: raw.lease_id })}`
    );
  }
  if (raw.reference_only !== true) {
    throw new TraceNormalizationError("DETAIL_GAP_ATTEMPTED", 'reference_only must be the fixed literal "true"');
  }
  return {
    kind: "detail_gap_attempted",
    stream,
    reference_only: true,
    gap_id_digest: digestTraceValue(gapId),
    lease_id_digest: digestTraceValue(leaseId),
  };
}

/**
 * DETAIL_GAP_RECOVERED (repair wave 3B) — connector-runtime-protocol.ts's
 * `DetailGapRecoveredMessage`: `gap_id` required string (digested),
 * `lease_id` optional string / `record_key` optional string|number
 * (`lease_id` digested when present; `record_key` compared-directly,
 * matching DETAIL_GAP's disposition), `reference_only: true` fixed.
 *
 * Repair wave 6 (P2-2 duty 2): the wire type declares `gap_id: string`
 * (required) and `lease_id?: string` (optional but, when present, a
 * string) — this previously accepted `string | number` for `gap_id` and any
 * type at all for `lease_id`. Now: `gap_id` missing or non-string rejects;
 * `lease_id` present but non-string (e.g. a number) also rejects, via
 * `requireOptionalIdString`.
 */
function normalizeDetailGapRecovered(raw: RawTraceMessage): NormalizedTraceEntry {
  const stream = asString(raw.stream);
  const gapId = asString(raw.gap_id);
  if (stream === undefined || gapId === undefined) {
    throw new TraceNormalizationError(
      "DETAIL_GAP_RECOVERED",
      `missing or non-string stream or gap_id (both required strings on the wire): ${JSON.stringify({ stream: raw.stream, gap_id: raw.gap_id })}`
    );
  }
  if (raw.reference_only !== true) {
    throw new TraceNormalizationError("DETAIL_GAP_RECOVERED", 'reference_only must be the fixed literal "true"');
  }
  const recordKeyRaw = raw.record_key;
  const recordKey = typeof recordKeyRaw === "string" || typeof recordKeyRaw === "number" ? recordKeyRaw : undefined;
  const leaseId = requireOptionalIdString("DETAIL_GAP_RECOVERED", "lease_id", raw.lease_id);
  const leaseIdDigest = leaseId === undefined ? undefined : digestTraceValue(leaseId);
  return {
    kind: "detail_gap_recovered",
    stream,
    reference_only: true,
    gap_id_digest: digestTraceValue(gapId),
    ...(recordKey === undefined ? {} : { record_key: recordKey }),
    ...(leaseIdDigest === undefined ? {} : { lease_id_digest: leaseIdDigest }),
  };
}

/**
 * Repair wave 4 (FIX 2c): DONE's `records_emitted` — connector-runtime-
 * protocol.ts's `EmittedMessage`'s DONE variant declares it a REQUIRED
 * `number` on the wire (no `?`), so this trace oracle requires it too rather
 * than treating it as optional. This is the aggregate connector-declared
 * total; compared-directly (see format.ts's field-disposition table) because
 * it is aggregate accounting truth the per-stream `ScenarioStreamExpectation`
 * oracle does not pin — that oracle only checks counts for streams the
 * scenario declared an expectation for, so a connector emitting an
 * undeclared extra stream's records would inflate `records_emitted` without
 * either oracle noticing on its own; comparing this trace field closes that
 * gap.
 *
 * Repair wave 6 (P2-2 duty 2): closes the review's named hole on DONE's
 * `error` sub-object. connector-runtime-protocol.ts's `EmittedMessage` DONE
 * variant declares `error?: { code?: string; message: string; recovery_hint?:
 * ...; retryable: boolean }` — when `error` is present at all, `message` AND
 * `retryable` are BOTH REQUIRED on the wire (only `code`/`recovery_hint` are
 * optional). Previously this normalizer read `error.retryable`
 * validated-when-present and never even looked at `error.message` — an empty
 * `{}` or a `{code: "x"}` error object normalized cleanly with no failure,
 * silently accepting a shape the runtime itself would never emit. Now: an
 * `error` object present but missing `message` (or `message` not a string),
 * or missing `retryable` (or `retryable` not a boolean), throws — matching
 * this module's "enforce exactly what the runtime type declares" policy.
 * `message` MAY carry provider-shaped diagnostic text (the runtime's own type
 * doesn't constrain its content), so it is DIGESTED into the trace entry as
 * `error_message_digest` (never compared-directly, never retained verbatim) —
 * added to the field-disposition table (format.ts) as a digested field,
 * alongside the pre-existing compared-directly `error_code`/`error_retryable`.
 */
function normalizeDone(raw: RawTraceMessage): NormalizedTraceEntry {
  const { status } = raw;
  if (status !== "succeeded" && status !== "failed") {
    throw new TraceNormalizationError("DONE", 'status must be "succeeded" or "failed"');
  }
  const recordsEmitted = asNumber(raw.records_emitted);
  if (recordsEmitted === undefined || recordsEmitted < 0) {
    throw new TraceNormalizationError(
      "DONE",
      `records_emitted is required and must be a non-negative finite number, got ${JSON.stringify(raw.records_emitted)}`
    );
  }
  const error = assertDiagnosticObjectShape("DONE", "error", raw.error);
  const errorCode = error ? asString(error.code) : undefined;
  if (error?.code !== undefined && errorCode === undefined) {
    throw new TraceNormalizationError("DONE", "error.code is present but not a string");
  }
  let errorMessageDigest: TraceValueDigest | undefined;
  let errorRetryable: unknown;
  if (error) {
    const errorMessage = asString(error.message);
    if (errorMessage === undefined) {
      throw new TraceNormalizationError(
        "DONE",
        `error is present but message is missing or not a string (required on the wire whenever error is present): ${JSON.stringify(error)}`
      );
    }
    errorRetryable = error.retryable;
    if (typeof errorRetryable !== "boolean") {
      throw new TraceNormalizationError(
        "DONE",
        `error is present but retryable is missing or not a boolean (required on the wire whenever error is present): ${JSON.stringify(error)}`
      );
    }
    errorMessageDigest = digestTraceValue(errorMessage);
  }
  const recoveryHint = normalizeRecoveryHint("DONE", error?.recovery_hint);
  const errorRecoveryAction = recoveryHint?.action;
  const errorRecoveryRetryable = recoveryHint?.retryable;
  return {
    kind: "done",
    status,
    records_emitted: recordsEmitted,
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
    ...(typeof errorRetryable === "boolean" ? { error_retryable: errorRetryable } : {}),
    ...(errorMessageDigest === undefined ? {} : { error_message_digest: errorMessageDigest }),
    ...(errorRecoveryAction === undefined ? {} : { error_recovery_action: errorRecoveryAction }),
    ...(errorRecoveryRetryable === undefined ? {} : { error_recovery_retryable: errorRecoveryRetryable }),
  };
}

/**
 * DETAIL_GAPS_PAGE_REQUEST (repair wave 4, FIX 2a) —
 * connector-runtime-protocol.ts's `DetailGapsPageRequestMessage`:
 * `request_id` REQUIRED string, `reference_only: true` fixed literal, both
 * compared-directly (a runtime-assigned correlation id and a fixed
 * protocol literal carry no provider content); `max_bytes` optional number,
 * `streams` optional string[] — both connector-declared, no provider
 * content, so both compared-directly too (unlike DETAIL_COVERAGE's key
 * arrays, `streams` here is stream NAMES the connector itself declared, not
 * provider-issued record keys — see format.ts's field-disposition table).
 */
function normalizeDetailGapsPageRequest(raw: RawTraceMessage): NormalizedTraceEntry {
  const requestId = asString(raw.request_id);
  if (requestId === undefined) {
    throw new TraceNormalizationError("DETAIL_GAPS_PAGE_REQUEST", "missing request_id (required on the wire)");
  }
  if (raw.reference_only !== true) {
    throw new TraceNormalizationError(
      "DETAIL_GAPS_PAGE_REQUEST",
      `reference_only must be the fixed literal true, got ${JSON.stringify(raw.reference_only)}`
    );
  }
  const maxBytes = raw.max_bytes === undefined ? undefined : asNumber(raw.max_bytes);
  if (raw.max_bytes !== undefined && maxBytes === undefined) {
    throw new TraceNormalizationError("DETAIL_GAPS_PAGE_REQUEST", "max_bytes is present but not a finite number");
  }
  let streams: readonly string[] | undefined;
  if (raw.streams !== undefined) {
    if (!Array.isArray(raw.streams)) {
      throw new TraceNormalizationError("DETAIL_GAPS_PAGE_REQUEST", "streams is present but not an array");
    }
    raw.streams.forEach((entry, index) => {
      if (typeof entry !== "string") {
        throw new TraceNormalizationError(
          "DETAIL_GAPS_PAGE_REQUEST",
          `streams[${String(index)}] is ${JSON.stringify(entry)} — every element must be a string`
        );
      }
    });
    streams = raw.streams as readonly string[];
  }
  return {
    kind: "detail_gaps_page_request",
    request_id: requestId,
    reference_only: true,
    ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }),
    ...(streams === undefined ? {} : { streams }),
  };
}

/** Per-kind normalizers, keyed by the raw message's `type` — see
 *  `normalizeTraceMessage`'s doc comment. A plain lookup table (rather than
 *  an if/else-if chain) makes the "exactly one of these seven kinds, nothing
 *  else" dispatch exhaustive-by-construction and keeps every branch a single
 *  expression, both of which independently satisfy this package's
 *  cognitive-complexity lint ceiling. Every normalizer here THROWS
 *  `TraceNormalizationError` on a shape-check failure rather than returning
 *  `undefined` — see this module's "FAIL-CLOSED SHAPE CHECKING" doc comment.
 *  This table's key set is exactly the `"tracked"`-dispositioned subset of
 *  `TRACE_POLICY` above — kept in sync by `scenario.test.ts`'s TRACE_POLICY-
 *  exhaustiveness test. */
const TRACE_NORMALIZERS: Record<string, (raw: RawTraceMessage) => NormalizedTraceEntry> = {
  SKIP_RESULT: normalizeSkipResult,
  DETAIL_COVERAGE: normalizeDetailCoverage,
  DETAIL_GAP: normalizeDetailGap,
  DETAIL_GAP_ATTEMPTED: normalizeDetailGapAttempted,
  DETAIL_GAP_RECOVERED: normalizeDetailGapRecovered,
  DETAIL_GAPS_PAGE_REQUEST: normalizeDetailGapsPageRequest,
  DONE: normalizeDone,
};

/**
 * Normalizes one raw protocol message into a `NormalizedTraceEntry`, or
 * `undefined` when the message is not one of the seven tracked kinds (every
 * other message type — RECORD, STATE, PROGRESS, INTERACTION, ASSISTANCE,
 * ASSISTANCE_STATUS — is out of scope for this oracle; see format.ts's
 * `NormalizedTraceEntry` doc comment, including its "EXCLUDED-BY-POLICY, NOT
 * BY OVERSIGHT" note on why ASSISTANCE/ASSISTANCE_STATUS are excluded, and
 * `TRACE_POLICY` above for the machine-enforced, exhaustive statement of
 * every kind's disposition).
 * Volatile fields (retry-attempt counters, retry-after hints, safe_headers)
 * are dropped here — see that same doc comment for the full list and why.
 * THROWS `TraceNormalizationError` when the message's `type` IS one of the
 * tracked kinds but fails that kind's strict shape check — see this
 * module's "FAIL-CLOSED SHAPE CHECKING" doc comment.
 */
export function normalizeTraceMessage(raw: RawTraceMessage): NormalizedTraceEntry | undefined {
  return TRACE_NORMALIZERS[raw.type]?.(raw);
}

/**
 * Normalizes an entire message stream into emission-order trace entries —
 * `normalizeTraceMessage` applied to every message, dropping anything that
 * isn't one of the tracked kinds. Used by both `bin/scenario-record.ts`
 * (building `expected.protocol_trace` — with NO try/catch around this call,
 * so a malformed tracked-kind message fails the recording outright, per this
 * module's "FAIL-CLOSED SHAPE CHECKING" doc comment) and this module's
 * `verifyRun` (building the actual trace to compare, wrapped in try/catch
 * there to report a clean `trace_normalization_error` VerifyFailure instead
 * of an unhandled throw). THROWS `TraceNormalizationError` — see
 * `normalizeTraceMessage`.
 */
export function buildProtocolTrace(messages: readonly RawTraceMessage[]): NormalizedTraceEntry[] {
  const trace: NormalizedTraceEntry[] = [];
  for (const message of messages) {
    const entry = normalizeTraceMessage(message);
    if (entry) {
      trace.push(entry);
    }
  }
  return trace;
}

/**
 * Compares `actual` (the trace built from THIS replay run's real messages)
 * against `expected` (the scenario's recorded `protocol_trace`), reporting a
 * single `trace_mismatch` VerifyFailure naming the FIRST divergence — a
 * readable "expected X at index N, got Y" diff rather than a full structural
 * dump, since the whole array is already visible in the scenario file for
 * anyone who needs it. Length mismatches (one side ran out of entries before
 * the other) are reported the same way, comparing against `undefined` at the
 * first index past the shorter array's end.
 */
function verifyTrace(
  runIndex: number,
  actual: NormalizedTraceEntry[],
  expected: NormalizedTraceEntry[]
): VerifyFailure[] {
  const length = Math.max(actual.length, expected.length);
  for (let i = 0; i < length; i += 1) {
    const actualEntry = actual[i];
    const expectedEntry = expected[i];
    if (JSON.stringify(actualEntry) !== JSON.stringify(expectedEntry)) {
      return [
        {
          kind: "trace_mismatch",
          runIndex,
          detail: `protocol_trace[${String(i)}] expected ${JSON.stringify(expectedEntry) ?? "undefined"}, got ${JSON.stringify(actualEntry) ?? "undefined"}`,
        },
      ];
    }
  }
  return [];
}

/**
 * Walks a value and throws if any object property or array element is
 * `undefined` anywhere in the tree. Exists because `hashCanonicalJson`
 * (local-device-envelope.ts's `toCanonicalValue`) silently DROPS `undefined`
 * object properties (`if (item !== undefined) out[key] = ...`) and
 * `JSON.stringify` silently turns an `undefined` ARRAY element into `null`
 * — either way, two records that differ only by an undefined-vs-absent (or
 * undefined-vs-null) field hash IDENTICALLY. That is a silent hash
 * collision: `verifyStream`'s record_hash check exists specifically to
 * catch a tampered/wrong record body, and a collision defeats it exactly
 * where it matters (a subtly wrong emitted record passing as correct).
 *
 * This only guards in-process emitters — a `RunCollector` that gets its
 * records from a subprocess's JSONL stdout (bin/scenario-verify.ts's own
 * `runCollector`) can never produce `undefined` in `r.data` in the first
 * place, since JSON.parse cannot produce it. The guard matters for a
 * `RunCollector` that calls `emit` directly in-process (e.g.
 * connectors/oura/scenario.spike.test.ts's shape, or any future in-process
 * collector) where a connector could construct a record data object
 * containing a literal `undefined` value.
 */
function assertNoUndefinedInTree(value: unknown, path: string): void {
  if (value === undefined) {
    throw new Error(
      `scenario verify: record data contains \`undefined\` at "${path || "$root"}" — canonical-JSON hashing would silently drop or null this value, which can hide a real content difference behind an identical hash. Refusing to hash it.`
    );
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoUndefinedInTree(item, `${path}[${String(index)}]`);
    });
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertNoUndefinedInTree(item, path ? `${path}.${key}` : key);
  }
}

/** `hashCanonicalJson(data)`, but throws first if `data` contains an
 *  `undefined` anywhere (see `assertNoUndefinedInTree`). */
function hashRecordDataStrict(data: unknown): string {
  assertNoUndefinedInTree(data, "");
  return hashCanonicalJson(data);
}

export interface RunCollectorRecordedRecord {
  data: unknown;
  id: string;
  /** P1-1 (seventh review): normalized op, defaulting to `"upsert"` when the
   *  emitting `RunCollector` never supplied one (every hand-rolled
   *  `RunCollector` in scenario.test.ts, and the oura/spotify spike
   *  collectors, predate `op` and never emit it) — see `verifyRun`'s emit
   *  closure below for where the default is applied. */
  op: "upsert" | "delete";
  stream: string;
}

export type RunCollectorEmit = (
  msg:
    | {
        data: unknown;
        id: string;
        /** Optional for backward compatibility: a `RunCollector` that never
         *  supplies `op` (every existing hand-rolled one, predating P1-1)
         *  defaults to `"upsert"` — see `RunCollectorRecordedRecord.op`. */
        op?: "upsert" | "delete";
        stream: string;
        type: "RECORD";
      }
    | { cursor: unknown; stream: string; type: "STATE" }
    /**
     * ADDITIVE — a raw completeness-bearing protocol message
     * (SKIP_RESULT/DETAIL_COVERAGE/DETAIL_GAP/DONE) this run observed, for
     * the protocol-trace oracle. Optional for every existing `RunCollector`:
     * a collector that never emits `TRACE` (every hand-rolled `RunCollector`
     * in scenario.test.ts, and connectors/oura|spotify's spike collectors)
     * simply produces an empty actual trace, which `verifyRun` only compares
     * against `run.expected.protocol_trace` when that field is present (see
     * `verifyRun`'s trace-comparison block) — a scenario with no
     * `protocol_trace` expectation is entirely unaffected by a collector
     * that never emits this variant.
     */
    | ({ type: "TRACE" } & Omit<RawTraceMessage, "type"> & { rawType: string })
) => void;

export interface RunCollectorArgs {
  emit: RunCollectorEmit;
  fetch: typeof fetch;
  state: unknown;
}

/**
 * Drives one run of the real connector's collect path. Implementations
 * (e.g. connectors/oura/scenario.spike.test.ts's) construct whatever
 * connector-specific context `collect()` needs, wiring `args.fetch` in as
 * the HTTP layer, `args.state` as the seed, and routing every RECORD/STATE
 * the connector would emit through `args.emit`.
 */
export type RunCollector = (runIndex: number, args: RunCollectorArgs) => Promise<void>;

export interface VerifyFailure {
  detail: string;
  kind:
    | "count"
    | "ids"
    | "record_hash"
    | "final_state"
    | "replay_mismatch"
    | "unconsumed_interactions"
    | "vacuous_run"
    | "stream_set_mismatch"
    | "trace_mismatch"
    /**
     * ADDITIVE (repair wave 3B) — a message this run actually emitted was one
     * of the six tracked completeness-bearing kinds but failed that kind's
     * strict shape check (`TraceNormalizationError`, thrown by
     * `normalizeTraceMessage`/`buildProtocolTrace`). Distinct from
     * `trace_mismatch` (which means both sides normalized cleanly but
     * disagree) — this means the ACTUAL run's own trace could not even be
     * built, which is reported as a run failure rather than silently dropping
     * the malformed message and comparing whatever normalized cleanly.
     */
    | "trace_normalization_error"
    /**
     * The ACTUAL run's `op` at a given index disagrees with
     * `run.expected.records[stream].ops` at that same index (a delete
     * replayed as an upsert, or vice versa, or any other literal mismatch).
     * `ops` is mandatory on every stream expectation (format.ts;
     * validate.ts's `validateExpectationOps` rejects a scenario missing it
     * before replay ever starts) — see `verifyStreamOps`'s doc comment.
     */
    | "record_op_mismatch";
  runIndex: number;
  stream?: string;
}

export interface VerifyMetrics {
  interactionCount: number;
  normalizerCount: number;
}

export interface VerifyResult {
  failures: VerifyFailure[];
  metrics: VerifyMetrics;
  pass: boolean;
}

function mergeStateMessages(seed: unknown, stateMessages: Array<{ cursor: unknown; stream: string }>): unknown {
  const base: Record<string, unknown> =
    seed !== null && typeof seed === "object" && !Array.isArray(seed) ? { ...(seed as Record<string, unknown>) } : {};
  for (const msg of stateMessages) {
    base[msg.stream] = msg.cursor;
  }
  return base;
}

function groupRecordsByStream(records: RunCollectorRecordedRecord[]): Map<string, RunCollectorRecordedRecord[]> {
  const byStream = new Map<string, RunCollectorRecordedRecord[]>();
  for (const record of records) {
    const bucket = byStream.get(record.stream);
    if (bucket) {
      bucket.push(record);
    } else {
      byStream.set(record.stream, [record]);
    }
  }
  return byStream;
}

/**
 * P1 (eighth review — supersedes the P1-1/seventh-review optional design):
 * compares each actual record's normalized `op` against `expected.ops` at
 * the same index, index-aligned exactly like the `record_hash` loop above
 * it. `expected.ops` is now MANDATORY on every stream expectation
 * (format.ts's `ScenarioStreamExpectation.ops` doc comment) and
 * `validateScenario` (validate.ts) already rejected any scenario missing it,
 * misaligned in length, or carrying an invalid literal, BEFORE this function
 * (or any replay) is ever reached — so this always compares unconditionally,
 * no absent-ops bypass. Split out of `verifyStream` purely to keep that
 * function under this package's cognitive-complexity lint ceiling.
 */
function verifyStreamOps(
  runIndex: number,
  stream: string,
  actual: RunCollectorRecordedRecord[],
  expected: ScenarioStreamExpectation
): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  const actualIds = actual.map((r) => r.id);
  for (let i = 0; i < Math.max(actual.length, expected.ops.length); i += 1) {
    const actualOp = actual[i]?.op;
    const expectedOp = expected.ops[i];
    if (actualOp !== expectedOp) {
      failures.push({
        kind: "record_op_mismatch",
        runIndex,
        stream,
        detail: `record[${String(i)}] (id=${actualIds[i] ?? "?"}) expected op ${JSON.stringify(expectedOp)}, got ${JSON.stringify(actualOp)}`,
      });
    }
  }
  return failures;
}

function verifyStream(
  runIndex: number,
  stream: string,
  actual: RunCollectorRecordedRecord[],
  expected: ScenarioStreamExpectation
): VerifyFailure[] {
  const failures: VerifyFailure[] = [];

  if (actual.length !== expected.count) {
    failures.push({
      kind: "count",
      runIndex,
      stream,
      detail: `expected ${String(expected.count)} record(s), got ${String(actual.length)}`,
    });
  }

  const actualIds = actual.map((r) => r.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expected.ids)) {
    failures.push({
      kind: "ids",
      runIndex,
      stream,
      detail: `expected ids ${JSON.stringify(expected.ids)}, got ${JSON.stringify(actualIds)}`,
    });
  }

  const actualHashes = actual.map((r) => hashRecordDataStrict(r.data));
  for (let i = 0; i < Math.max(actualHashes.length, expected.record_sha256s.length); i += 1) {
    const actualHash = actualHashes[i];
    const expectedHash = expected.record_sha256s[i];
    if (actualHash !== expectedHash) {
      failures.push({
        kind: "record_hash",
        runIndex,
        stream,
        detail: `record[${String(i)}] (id=${actualIds[i] ?? "?"}) expected sha256 ${String(expectedHash)}, got ${String(actualHash)}`,
      });
    }
  }

  failures.push(...verifyStreamOps(runIndex, stream, actual, expected));

  return failures;
}

/**
 * Compares this run's actual protocol trace against `run.expected.protocol_trace`
 * when the scenario recorded one — see the call site in `verifyRun` for the
 * legacy-scenario and fail-closed rationale. Split out purely to keep
 * `verifyRun` under this package's cognitive-complexity lint ceiling.
 */
function verifyRunProtocolTrace(
  runIndex: number,
  run: ScenarioRun,
  rawTraceMessages: RawTraceMessage[]
): VerifyFailure[] {
  if (run.expected.protocol_trace === undefined) {
    return [];
  }
  try {
    const actualTrace = buildProtocolTrace(rawTraceMessages);
    return verifyTrace(runIndex, actualTrace, run.expected.protocol_trace);
  } catch (err) {
    return [
      {
        kind: "trace_normalization_error",
        runIndex,
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}

/**
 * Verify every run in `scenario` against `runCollector`, strictly offline.
 * Runs execute in array order so `state_from_run` can reference an earlier
 * run's ACTUAL emitted final state. A run's own failures do not prevent
 * later runs from executing (all runs attempt; failures accumulate) so a
 * single scenario reports every problem it has, not just the first.
 */
async function verifyRun(
  runIndex: number,
  scenario: ConnectorScenario,
  runCollector: RunCollector,
  actualFinalStateByRun: Map<number, unknown>
): Promise<VerifyFailure[]> {
  const failures: VerifyFailure[] = [];
  const run = scenario.runs[runIndex] as ScenarioRun;

  // A run with zero recorded interactions AND zero expected records proves
  // nothing: the collector could do absolutely nothing (or crash before
  // ever calling fetch/emit) and this run would still "pass" every
  // assertion below vacuously — there is no interaction to mismatch, no
  // record count/id/hash to check, and final_state trivially matches
  // whatever an empty seed merges to. Report this explicitly instead of
  // silently reporting pass:true for a run that verified nothing.
  if (run.interactions.length === 0 && Object.keys(run.expected.records).length === 0) {
    failures.push({
      kind: "vacuous_run",
      runIndex,
      detail:
        "run has zero recorded interactions and zero expected records - it cannot prove anything about the connector and must not be reported as passing",
    });
    return failures;
  }

  const seedState =
    run.start.state_from_run === undefined
      ? run.start.state
      : (actualFinalStateByRun.get(run.start.state_from_run) ?? null);

  const replay: ReplayFetch = createReplayFetch(run, scenario.normalizers);

  const records: RunCollectorRecordedRecord[] = [];
  const stateMessages: Array<{ cursor: unknown; stream: string }> = [];
  const rawTraceMessages: RawTraceMessage[] = [];
  const emit: RunCollectorEmit = (msg) => {
    if (msg.type === "RECORD") {
      records.push({ stream: msg.stream, id: msg.id, data: msg.data, op: msg.op ?? "upsert" });
    } else if (msg.type === "STATE") {
      // Enforced here as well as at the wire boundary
      // (assertValidStateMessage in messagesToRecordsAndState): the CLI's
      // RunCollector validates upstream, but a future RunCollector that
      // bypasses the shared projection must not be able to feed malformed
      // STATE into final_state silently (pre-submission audit finding).
      if (typeof msg.stream !== "string" || msg.stream.length === 0) {
        throw new TraceNormalizationError(
          "STATE",
          `emitted with invalid stream ${JSON.stringify(msg.stream)} - nonempty string required`
        );
      }
      stateMessages.push({ stream: msg.stream, cursor: msg.cursor });
    } else {
      const { rawType, ...rest } = msg;
      rawTraceMessages.push({ ...rest, type: rawType });
    }
  };

  try {
    await runCollector(runIndex, { fetch: replay.fetch, state: seedState, emit });
  } catch (err) {
    failures.push({
      kind: "replay_mismatch",
      runIndex,
      detail: err instanceof Error ? err.message : String(err),
    });
    return failures;
  }

  try {
    replay.assertAllConsumed();
  } catch (err) {
    failures.push({
      kind: "unconsumed_interactions",
      runIndex,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const finalState = mergeStateMessages(seedState, stateMessages);
  actualFinalStateByRun.set(runIndex, finalState);

  const byStream = groupRecordsByStream(records);

  // Stream-set exactness (FIX 2a): the actual set of streams the collector
  // emitted at least one record for must equal the expected set IN EITHER
  // DIRECTION — a stream the scenario expected but the collector never
  // touched is already caught below by verifyStream's count check (0 vs
  // expected.count), but a stream the collector emitted that the scenario
  // never declared an expectation for would otherwise pass silently (no
  // expected.records entry means no verifyStream call at all for it). An
  // extra, unexpected stream is exactly the kind of undeclared side effect
  // this harness exists to catch.
  const expectedStreams = new Set(Object.keys(run.expected.records));
  const actualStreams = new Set(byStream.keys());
  const extraStreams = [...actualStreams].filter((s) => !expectedStreams.has(s));
  const missingStreams = [...expectedStreams].filter((s) => !actualStreams.has(s));
  if (extraStreams.length > 0 || missingStreams.length > 0) {
    failures.push({
      kind: "stream_set_mismatch",
      runIndex,
      detail: `actual emitted stream set differs from expected — extra: [${extraStreams.join(", ")}], missing: [${missingStreams.join(", ")}]`,
    });
  }

  for (const [stream, expected] of Object.entries(run.expected.records)) {
    failures.push(...verifyStream(runIndex, stream, byStream.get(stream) ?? [], expected));
  }

  if (hashCanonicalJson(finalState) !== hashCanonicalJson(run.expected.final_state)) {
    failures.push({
      kind: "final_state",
      runIndex,
      detail: `expected final_state ${JSON.stringify(run.expected.final_state)}, got ${JSON.stringify(finalState)}`,
    });
  }

  // Protocol-trace oracle: only compared when this run's scenario actually
  // recorded one (`run.expected.protocol_trace !== undefined`) — a scenario
  // captured before this field existed (or a `RunCollector` that never emits
  // `TRACE`, e.g. every hand-rolled collector in scenario.test.ts and the
  // oura/spotify spike collectors) is unaffected: legacy scenarios verify
  // exactly as before, and `bin/scenario-verify.ts` prints "protocol trace:
  // not captured (legacy scenario)" for them instead of silently comparing
  // against an absent expectation. FAIL-CLOSED (repair wave 3B): a malformed
  // tracked-kind message in the ACTUAL run now reports a
  // `trace_normalization_error` instead of silently dropping — see
  // `verifyRunProtocolTrace`.
  failures.push(...verifyRunProtocolTrace(runIndex, run, rawTraceMessages));

  return failures;
}

export async function verifyScenario(scenario: ConnectorScenario, runCollector: RunCollector): Promise<VerifyResult> {
  const actualFinalStateByRun = new Map<number, unknown>();
  const interactionCount = scenario.runs.reduce((sum, run) => sum + run.interactions.length, 0);

  // Runs must execute strictly in order — a later run's `state_from_run`
  // reads the ACTUAL final state a prior run wrote into
  // `actualFinalStateByRun` — but that ordering has to be expressed WITHOUT
  // an `await` inside a `for`/`while` loop body (this package's
  // `noAwaitInLoops` conformance gate). `reduce` over a `Promise` chain
  // keeps every await in a `.then()` callback instead, structurally
  // satisfying the rule rather than needing an allowlist exception — same
  // pattern as connectors/github/index.test.ts's `ingestPullRequestRecords`.
  const failures = await scenario.runs.reduce<Promise<VerifyFailure[]>>(
    (previous, _run, runIndex) =>
      previous.then(async (acc) => {
        const runFailures = await verifyRun(runIndex, scenario, runCollector, actualFinalStateByRun);
        return [...acc, ...runFailures];
      }),
    Promise.resolve([])
  );

  return {
    pass: failures.length === 0,
    failures,
    metrics: {
      normalizerCount: scenario.normalizers?.length ?? 0,
      interactionCount,
    },
  };
}
