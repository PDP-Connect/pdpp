// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one server-owned synthesized verdict every owner surface renders verbatim.
 *
 * `synthesizeRenderedVerdict` is a PURE projection of evidence the connection-health
 * snapshot already carries. It performs no I/O and reads no clock; the same inputs
 * always produce the same verdict. It does NOT introduce a second state machine: the
 * headline `state`, the orthogonal axes, `forward_disposition`, `conditions[]`, the
 * refresh evidence, and the per-stream rollups are all read from existing projection
 * output. `deriveForwardDisposition` (`connection-health.ts`) remains the SOLE
 * terminality oracle — `terminal` is always DERIVED from it, never an independent flag.
 *
 * The two load-bearing axes of the verdict are orthogonal (design D1):
 *
 *   - `tone`    answers collection health — a worst-wins rollup over health axes.
 *   - `channel` answers "whether to interrupt the owner" — a function of WHO can
 *               resolve the condition, computed in the SAME pass AFTER `tone`.
 *
 * Freshness is a co-rendered axis, not a health label: Reddit-stale can remain
 * `green/advisory` with a refresh affordance, while a retryable Chase gap is
 * `amber/advisory` and a revoked credential is `amber/attention`. A runtime fault caps every
 * per-connection `channel` at `calm` while leaving each `tone` honest (design D7 /
 * invariant S4) so one dead scheduler never produces N false attention pulls.
 *
 * Suppressed self-handled signals are ROUTED to the inspection-layer `detail`, never
 * deleted (design D4 / invariant S3): `detail` is a strict superset of anything the
 * attention layer drops. `detail` and the calibration `trace` are owner-only
 * diagnostics and SHALL NOT be exposed to grant-scoped clients.
 *
 * See `openspec/changes/redesign-connection-health-verdict-and-recovery` and
 * `docs/research/slvp-connector-health-FINAL-design-2026-06-15.md`.
 */

import {
  type AcknowledgedLossRecord,
  acknowledgedLossProgressHeadline,
  acknowledgedLossStatement,
  acknowledgedLossTone,
} from "./acknowledged-loss.ts";
import {
  CONNECTION_CONDITION_REASONS,
  type ConnectionAttentionEvidence,
  type ConnectionHealthSnapshot,
  type ConnectionRefreshEvidence,
  type CoverageAxis,
  deriveForwardDisposition,
  type ForwardDisposition,
  hasAffirmativePassiveRecoveryEvidence,
  isAssistedRefresh,
  isManualRefreshOnly,
  type OwnerActionSurface,
} from "./connection-health.ts";

// ─── Public verdict types ──────────────────────────────────────────────────

/**
 * Worst-wins collection-health tone. Orthogonal to {@link RenderedChannel}: it
 * answers "is collection healthy?", never "whether to interrupt". `grey` is the
 * unknown/checking tone.
 */
export type VerdictTone = "amber" | "green" | "grey" | "red";

/**
 * Fixed health-label set. Action-demand language ("Needs you") is reserved for
 * `channel === "attention"` and owner-satisfiable required actions, not for
 * stale freshness or other advisory states. Grey labels are evidence-dependent:
 * "Checking" requires active work; otherwise missing evidence reads "Not
 * measured".
 *
 * `amber` tone splits into two labels (`labelForPill`): "Needs refresh" is
 * reserved for a connection that is otherwise working but not current —
 * idle-with-prior-success, stale freshness, or `owner_refresh_due` — where the
 * owner action is a routine nudge, not a fix. "Missing data" is reserved for real
 * collection trouble: coverage gaps, attention, or a stalled outbox. Both
 * labels can carry `channel: "advisory"`; the label distinguishes "needs a
 * routine refresh" from "something is actually wrong" without changing whether
 * the owner is interrupted.
 *
 * B3 (owner ledger 2026-08-22): this label was "Degraded", which is engineering
 * jargon — the owner said it "means nothing to a user". "Missing data" is the
 * plain-English claim that is true across EVERY case this amber rollup covers:
 * a coverage gap means some data was not collected; open attention means
 * collection is blocked so data is not arriving; a stalled outbox means
 * collected data is stuck on the device and has not landed. It is deliberately
 * NOT cheerier than "Degraded" — it names the actual loss to the owner rather
 * than describing the system's internal condition.
 */
export type VerdictLabel =
  // Terminal and honest: records preserved, collection finished, nothing will
  // resume. Applied by the summary projection to an archived source, never
  // derived from a tone (no `TONE_TO_LABEL` entry maps to it) — a source is
  // archived because of what it IS, not because of how its axes scored.
  | "Archived"
  | "Can't collect"
  | "Checking"
  | "Healthy"
  | "Import complete"
  | "Missing data"
  // Owner decision 2026-08-23: a NON-REQUIRED stream the connector intended to
  // collect (`coverage_policy: collect`, or no policy) has been lost for good.
  // The source still works and still delivers everything load-bearing, so
  // "Missing data" would overstate it and "Healthy" would hide a real loss.
  // Named in the same plain-English register as "Missing data" — it says what
  // the owner lost and that it was not the essential part.
  | "Missing optional data"
  // A local-collector dead-letter backlog that is a strict MINORITY of the
  // records that host handled. The source is demonstrably still collecting —
  // the majority uploaded — so "Can't collect" is a false red. The loss is
  // still permanent and still needs a manual recovery, so it is never green.
  // The exact proportion always rides along in the action summary ("1 of
  // 10,001"); this label only sets the tone the owner reads first.
  | "Some records stuck"
  | "Needs refresh"
  | "Not measured"
  // Terminal and honest, like "Archived": this source never connected, so
  // there is no collection to describe, only a setup attempt that did not
  // finish. Applied by the summary projection to a `setup_failed` source,
  // never derived from a tone — see `archiveRenderedVerdict` in `ref-control.ts`.
  | "Setup never completed"
  | "Syncing";

export interface VerdictPill {
  readonly label: VerdictLabel;
  readonly tone: VerdictTone;
}

/**
 * Owner-interruption routing, computed AFTER `tone` in the same pass.
 *
 *   - `calm`      : the system is handling it; the owner cannot accelerate it.
 *   - `advisory`  : owner-actionable-but-non-urgent, an owner-optional accelerant,
 *                   or a visible maintainer/status condition (no dead owner button).
 *   - `attention` : an owner-satisfiable action exists AND the owner is the SOLE
 *                   resolution (the system cannot progress with the access it holds).
 */
export type RenderedChannel = "advisory" | "attention" | "calm";

/**
 * A co-required annotation. On `calm`/`advisory` verdicts the kind is restricted to
 * `freshness | schedule | activity` and the text carries NO raw mechanistic counts
 * (invariant S2). `coverage`/`attention`/`outbox` kinds may only appear on a non-calm,
 * non-advisory (i.e. `attention`-channel) verdict where naming the mechanism is the
 * point.
 */
export type AnnotationKind = "activity" | "attention" | "coverage" | "freshness" | "outbox" | "schedule";

export interface VerdictAnnotation {
  readonly kind: AnnotationKind;
  /** Owner-facing sentence. No raw gap/retry/backlog counts on calm/advisory. */
  readonly text: string;
}

/** The fixed required-action kind taxonomy. */
export type RequiredActionKind =
  | "add_info"
  | "backfill"
  | "code_fix"
  | "contact_support"
  | "reattach_schedule"
  | "reauth"
  | "refresh_now"
  | "retry_gap"
  | "wait";

export type ActionAudience = "maintainer" | "none" | "owner";

export type ActionUrgency = "now" | "overdue" | "soon" | "verifying";

export type ActionRemediationKind = "local_collector_recovery";

export type ActionRemediationCause =
  | "dead_letter_backlog"
  | "stale_heartbeat"
  | "stale_pending"
  | "state_read_failed"
  | "stalled_unknown"
  | "transient_upload_failure";

export type ActionRemediationCommandKind =
  | "local_collector_doctor"
  | "local_collector_recover_apply"
  | "local_collector_recover_preview"
  | "local_collector_retry_dead_letters_apply"
  | "local_collector_retry_dead_letters_preview"
  | "local_collector_run";

export interface ActionRemediationCommand {
  /** Safe copy-paste template; placeholders are non-secret values the console already knows. */
  readonly command_template: string;
  /** Stable symbolic command id so owner surfaces can substitute deployment-specific args safely. */
  readonly kind: ActionRemediationCommandKind;
  /** Owner-facing command label. */
  readonly label: string;
}

export interface ActionRemediationTarget {
  /** Owner surfaces resolve host/source labels from existing source-instance bindings. */
  readonly identity_source: "source_instance_bindings";
  /** The recovery runs on the device/local host that owns the collector outbox. */
  readonly kind: "local_device";
}

export interface ActionRemediation {
  /** Stalled local collector cause derived from connection-health conditions. */
  readonly cause: ActionRemediationCause;
  /** Ordered commands for this cause. State-read and stale-pending intentionally omit dead-letter commands. */
  readonly commands: readonly ActionRemediationCommand[];
  /** Cause-specific remediation family. */
  readonly kind: ActionRemediationKind;
  /** Primary owner step for focused recovery panels. */
  readonly label: string;
  /** One sentence explaining what the action does. */
  readonly summary: string;
  /** Target identity source for focused recovery panels. */
  readonly target: ActionRemediationTarget;
}

export interface RequiredActionTarget {
  readonly kind: "sync";
  readonly run_id: string;
}

/**
 * The one unified satisfaction contract (design D3). A single discriminated union the
 * self-heal watcher evaluates for EVERY owner-actionable kind — never per-kind bespoke
 * logic. `wait | code_fix | contact_support` carry `{ kind: "none" }` and are not
 * owner-satisfiable.
 */
export type SatisfactionContract =
  | { readonly kind: "attention_resolved" }
  | { readonly kind: "backfill_window_covered" }
  | { readonly kind: "confirming_run_succeeded" }
  | { readonly kind: "credential_present_and_unrejected" }
  | { readonly kind: "gap_recovered" }
  | { readonly kind: "none" }
  | { readonly kind: "schedule_attached_and_enabled" };

export interface RequiredAction {
  /** Stream ids this action affects; empty for connection-level actions. */
  readonly affects: readonly string[];
  readonly audience: ActionAudience;
  /** Non-secret owner-facing call to action. */
  readonly cta: string;
  readonly kind: RequiredActionKind;
  /** Optional focused remediation payload for owner-action panels. */
  readonly remediation?: ActionRemediation;
  /** The single unified satisfaction contract for this action. */
  readonly satisfied_when: SatisfactionContract;
  /** Bounded product surface this owner action opens. */
  readonly surface?: OwnerActionSurface;
  /** Optional exact sync target for owner actions backed by a validated run id. */
  readonly target?: RequiredActionTarget;
  /**
   * DERIVED from the forward disposition — `terminal === (forward_disposition ===
   * "terminal")`. Never an independent value (design D2 / invariant 4).
   */
  readonly terminal: boolean;
  readonly urgency: ActionUrgency;
}

/** A per-stream row whose `action_ref` indexes into `required_actions[]`. */
export interface VerdictStreamRow {
  /** Index into `required_actions[]`, or `null` when the stream needs no action. */
  readonly action_ref: number | null;
  /** Clamped: `collected <= considered` always (honesty invariant 2). */
  readonly collected: number | null;
  readonly considered: number | null;
  readonly coverage: CoverageAxis;
  readonly disposition: ForwardDisposition;
  /** Owner-facing per-stream sentence; never claims resumed collection if terminal. */
  readonly statement: string;
  readonly stream_id: string;
}

export type ProgressMode = "deferred" | "local_device" | "manual" | "scheduled";

/**
 * Collection-model-aware progress (design D9). Privileges the right "did it work?"
 * signal so a structurally-zero `records_emitted` is never the headline number.
 */
export interface RenderedProgress {
  /**
   * For `deferred`, raw gap-drain counts are intentionally NOT exposed here:
   * they are mechanistic inspection evidence and live in `detail.detail_gap_backlog`.
   * The synthesizer still uses drain evidence to choose the public qualitative
   * headline, but the number itself stays one disclosure layer down.
   */
  readonly gaps_drained_last_run: number | null;
  /** The single owner-facing productivity sentence the mode privileges. */
  readonly headline: string;
  /** ISO-8601 last-refreshed instant for `manual`/`deferred` recency. */
  readonly last_refreshed_at: string | null;
  readonly mode: ProgressMode;
  /** For `scheduled`: records committed last run. `null` when not applicable. */
  readonly records_committed_last_run: number | null;
  /** Retained record total; the durable "is there data?" signal. */
  readonly retained_records: number | null;
}

/**
 * Inspection-layer detail (design D4). A strict superset of any evidence the
 * attention layer drops. Owner-only — never grant-scoped.
 */
export interface VerdictDetail {
  /**
   * Durable owner acknowledgement, carried verbatim from the projection.
   * This is structured evidence for owner controls; it is never inferred from
   * the rendered forward statement and is removed by the grant-scoped mapper.
   */
  readonly acknowledged_loss: AcknowledgedLossRecord | null;
  readonly collection_rate: ConnectionHealthSnapshot["collection_rate"];
  readonly conditions: ConnectionHealthSnapshot["conditions"];
  /**
   * Provider coverage-horizon/provenance disclosures, carried verbatim from
   * {@link ConnectionHealthSnapshot.coverage_horizons}. PURE PASS-THROUGH:
   * no tone/channel/label computation above reads this field — it exists
   * solely so the owner-facing inspection layer can render
   * `coverageHorizonDisclosure` (`runtime/coverage-horizon.ts`) text. Never
   * present on `pill`/`channel`/`annotations`. Empty when the caller did not
   * supply horizon evidence.
   */
  readonly coverage_horizons: ConnectionHealthSnapshot["coverage_horizons"];
  readonly detail_gap_backlog: ConnectionHealthSnapshot["detail_gap_backlog"];
  readonly dominant_condition_id: string | null;
  readonly forward_disposition: ForwardDisposition;
  readonly next_attempt_at: string | null;
  readonly reason_code: string | null;
  readonly state: ConnectionHealthSnapshot["state"];
  /**
   * Every signal the silence predicate suppressed from the attention layer, present
   * here verbatim so suppressed truth is always one disclosure away (invariant S3).
   */
  readonly suppressed: readonly SuppressedSignal[];
}

/** A signal routed away from the attention channel and into `detail`. */
export interface SuppressedSignal {
  /** Where in `detail` the full evidence lives (e.g. `detail_gap_backlog`). */
  readonly detail_field: string;
  readonly kind: "cooldown" | "drain" | "runtime_fault" | "syncing";
  readonly reason: string;
}

/**
 * Low-noise calibration trace (design "Calibration plan"). NOT an owner-surface field
 * and NOT grant-scoped — a build/test and operator diagnostic that proves the verdict
 * is not hand-waved. Explains, per verdict: what set the tone, what set the channel,
 * what was suppressed and where it landed, the primary action, and the contract that
 * clears it.
 */
export interface CalibrationTrace {
  readonly channel_cause: string;
  readonly detail_destinations: readonly string[];
  readonly primary_action_kind: RequiredActionKind | null;
  readonly runtime_capped: boolean;
  readonly satisfied_when: SatisfactionContract | null;
  readonly suppressed_evidence: readonly SuppressedSignal[];
  readonly tone_cause: VerdictTone;
  readonly tone_inputs: readonly { readonly axis: string; readonly tone: VerdictTone }[];
}

export interface RenderedVerdict {
  readonly annotations: readonly VerdictAnnotation[];
  readonly channel: RenderedChannel;
  /** Owner-only inspection layer. Never grant-scoped. */
  readonly detail: VerdictDetail;
  readonly forward_statement: string;
  readonly pill: VerdictPill;
  readonly progress: RenderedProgress;
  /** Ordered by urgency; the first is primary, the rest render behind "+N more". */
  readonly required_actions: readonly RequiredAction[];
  readonly streams: readonly VerdictStreamRow[];
  /** Owner-only/operator calibration diagnostic. Never grant-scoped. */
  readonly trace: CalibrationTrace;
}

// ─── Synthesizer input ──────────────────────────────────────────────────────

/**
 * Per-stream rollup the synthesizer reads. Mirrors the run-local `RuntimeCollectionFact`
 * coverage shape (`collected` / `considered`, with `considered: null` meaning unknown)
 * plus the durable retryability/attention signals the disposition oracle needs. This is
 * a synthesizer INPUT; the wire-forwarding of these rows from ref-control is Dispatch C.
 */
export interface StreamRollup {
  /** Whether structured owner attention is open for this stream's gap. */
  readonly attention_open: boolean;
  readonly collected: number | null;
  readonly considered: number | null;
  readonly coverage: CoverageAxis;
  /** Whether the stream's outstanding gap is recoverable by an ordinary future run. */
  readonly gap_retryable: boolean;
  /** Manifest stream priority. `required` streams weight the worst-wins rollup. */
  readonly priority: "accepted_absence" | "optional" | "required";
  /**
   * Recovery action the runtime attached to this stream's outstanding gap, when
   * known. `"retry_by_runtime"` means an ordinary future run already retries
   * this stream without owner involvement — the owner-facing retry CTA must
   * not claim credit for work the runtime does on its own. `null`/absent means
   * unknown (no skip fact, or a value the runtime hasn't declared): callers
   * must treat unknown the same as owner-actionable, never the same as
   * `retry_by_runtime`.
   */
  readonly recovery_action?: string | null;
  readonly stream_id: string;
  /**
   * Whether this stream's ENTIRE terminal shortfall carries durable per-item
   * proof of impossibility — the collection report entry's
   * `coverage_unfillable_accounted`, computed once by
   * `isStreamFullyUnfillableAccounted`
   * (`server/connector-gap-classification.ts`) and only carried here. Meaningful
   * solely alongside `coverage: "terminal_gap"`. Optional; absent/`false`
   * preserves the shipped behavior exactly.
   */
  readonly unfillable_accounted?: boolean;
}

/**
 * Optional progress evidence. Collection-model facts the synthesizer privileges by
 * `mode`. All fields are nullable; the synthesizer never fabricates a number.
 */
export interface ProgressEvidence {
  /**
   * When this connection's required-stream coverage was last PROVEN — the
   * oldest `evidence_as_of` across required streams already proven complete
   * (`oldestRequiredCompleteEvidenceAsOf`, `server/ref-control.ts`). A
   * DIFFERENT anchor from {@link last_refreshed_at}: that one is
   * connection-record recency (the last successful run / device heartbeat),
   * this one is the age of the coverage proof itself. A run can succeed and
   * refresh records without re-proving every required stream, so the two
   * legitimately diverge — and when they do, the owner-facing freshness
   * sentence must age against THIS one, not the flattering one.
   *
   * Optional and nullable: absent/`null`/unparseable means no proof stands
   * behind a claim about coverage age, and the sentence falls back to the
   * record-recency wording rather than inventing a date.
   */
  readonly coverage_proven_at?: string | null;
  readonly gaps_drained_last_run?: number | null;
  readonly last_refreshed_at?: string | null;
  readonly mode: ProgressMode;
  /** Observation instant supplied by the caller; keeps this module pure. */
  readonly observed_at?: string | null;
  readonly records_committed_last_run?: number | null;
  readonly retained_records?: number | null;
}

/**
 * Typed instance-schedule evidence for the `reattach_schedule` required
 * action (Wave 10a, owner review 2026-07-09). Optional — omitted callers get
 * byte-identical prior behavior (no `reattach_schedule` emission).
 *
 * `mode` mirrors `OwnerStateScheduleMode` (`owner-state.ts`) — that module
 * imports this type rather than declaring its own, so there is ONE owner of
 * "what does a disabled schedule mean" across both the verdict synthesis and
 * the owner-state resolver:
 *   - `manual`             : no schedule row exists. `reattach_schedule` is unreachable.
 *   - `scheduled-active`   : a schedule row exists and is enabled. Unreachable (nothing to reattach).
 *   - `scheduled-disabled` : a schedule row exists and is disabled — the ONLY
 *                             mode `reattach_schedule` can emit from, and
 *                             only when the connection has a prior success
 *                             (`hasPriorSuccess`) and no higher-priority
 *                             action already exists (`buildRequiredActions`'
 *                             `actions.length === 0` gate, run AFTER every
 *                             reauth/code_fix/add_info/refresh_now/retry_gap
 *                             check — a disabled schedule must never mask a
 *                             more urgent defect).
 */
export interface ScheduleEvidence {
  readonly hasPriorSuccess: boolean;
  readonly mode: "manual" | "scheduled-active" | "scheduled-disabled";
}

// ─── Tone (worst-wins) ──────────────────────────────────────────────────────

const TONE_RANK: Record<VerdictTone, number> = { amber: 2, green: 0, grey: 1, red: 3 };

/**
 * Actions whose entire promise is "do this and the missing data arrives". Under
 * an owner-acknowledged permanent loss that promise is false, so these are
 * withdrawn rather than left as an action item the owner can never clear.
 *
 * `code_fix` is included: for a provider-side purge or a provider API that
 * contradicts itself, there is no connector change that recovers the data, and
 * claiming otherwise blames our code for the provider's act. `reauth` and
 * `add_info` are deliberately NOT included — a broken credential is a real,
 * separately-fixable defect that an acknowledged loss must not paper over.
 */
const RECOVERY_PROMISING_ACTION_KINDS: ReadonlySet<RequiredActionKind> = new Set<RequiredActionKind>([
  "backfill",
  "code_fix",
  "refresh_now",
  "retry_gap",
]);

/**
 * The tone axes an acknowledged loss is allowed to speak for. An
 * acknowledgement explains why DATA is missing; it says nothing about whether
 * the credential works or the outbox is draining.
 *
 * `state` is deliberately EXCLUDED. The headline state is the worst-wins rollup
 * of everything, so a red `state` can be driven by a blocked credential that
 * the acknowledgement does not excuse — and honesty invariant 5
 * (`toneBelowBaseStateViolation`) independently forbids a tone below the base
 * state tone. Softening on `state` would trip that invariant, which is exactly
 * the check catching the mistake.
 */
const ACKNOWLEDGED_LOSS_TONE_AXES: ReadonlySet<string> = new Set(["coverage", "disposition"]);

/**
 * True when every axis voting `red` is one an acknowledged loss can explain.
 * If any other axis is red, the connection has a second, unacknowledged problem
 * and must keep its red tone.
 */
function redIsOnlyFromCoverage(toneInputs: readonly { readonly axis: string; readonly tone: VerdictTone }[]): boolean {
  return toneInputs.every((input) => input.tone !== "red" || ACKNOWLEDGED_LOSS_TONE_AXES.has(input.axis));
}

const TONE_TO_LABEL: Record<VerdictTone, VerdictLabel> = {
  amber: "Missing data",
  green: "Healthy",
  grey: "Not measured",
  red: "Can't collect",
};

/**
 * Axes whose amber-or-worse tone always means real collection trouble, never a
 * routine nudge: `coverage` (a stream gap), `attention` (owner-attention open),
 * `outbox` (stalled uploads). `state` reaching `degraded`/`needs_attention` is
 * likewise always real trouble. The amber-but-not-broken states are `idle`
 * with a prior success and `cooling_off`, whose health authority requires
 * affirmative passive-recovery evidence.
 * `disposition` similarly is always real trouble EXCEPT `owner_refresh_due`
 * (`resumable`/`awaiting_owner` only ever arise from an outstanding coverage
 * gap — `deriveForwardDisposition`, `connection-health.ts` — so they always
 * co-occur with a real `coverage` gap in practice, but are checked explicitly
 * here rather than relying on that co-occurrence).
 */
const DEGRADING_AXES = new Set(["coverage", "attention", "outbox"]);
const NON_DEGRADING_AMBER_STATES = new Set(["idle", "cooling_off"]);

/**
 * Whether an optional terminal loss is the ONLY thing that made this verdict
 * degrade — i.e. the connection is otherwise working. Every non-coverage
 * degrading signal (state, attention, outbox) must be clean, and the coverage
 * axis's amber must be attributable solely to optional terminal streams: no
 * required stream may be contributing an amber-or-worse coverage tone of its
 * own. If anything else is also wrong, the honest label is the broader
 * "Missing data" — the narrower claim would under-report real trouble.
 */
function optionalLossIsSoleDegradation(
  streams: readonly StreamRollup[],
  toneInputs: readonly { axis: string; tone: VerdictTone }[]
): boolean {
  const anyOptionalTerminalLoss = streams.some((stream) => isOptionalTerminalLoss(stream));
  if (!anyOptionalTerminalLoss) {
    return false;
  }
  // Any degrading axis OTHER than coverage means something else is also wrong.
  // `coverage` is excluded because it is the axis the optional loss ITSELF
  // drives amber — including it here would make this check always false.
  const nonCoverageDegrading = toneInputs.some(
    (input) => DEGRADING_AXES.has(input.axis) && input.axis !== "coverage" && TONE_RANK[input.tone] >= TONE_RANK.amber
  );
  if (nonCoverageDegrading) {
    return false;
  }
  // A required stream carrying its own amber-or-worse coverage is real trouble
  // regardless of what the optional streams are doing.
  const requiredCoverageDegrading = streams.some(
    (stream) =>
      stream.priority === "required" &&
      !streamCoverageIsFullyAccounted(stream) &&
      TONE_RANK[coverageTone(stream.coverage)] >= TONE_RANK.amber
  );
  return !requiredCoverageDegrading;
}

/**
 * Whether a minority dead-letter backlog is the ONLY thing that made this
 * verdict degrade. "Some records stuck" is a narrow claim — it says the source
 * works and a subset of records did not upload — so it may only be made when
 * nothing else is also wrong. Any other degrading axis (coverage, attention)
 * or a broken headline state means the honest label is the broader "Missing
 * data"; the narrower one would under-report real trouble.
 *
 * `outbox` is excluded from the other-axis scan for the same reason `coverage`
 * is excluded in `optionalLossIsSoleDegradation`: it is the axis this very
 * condition drives amber, so including it would make the check always false.
 *
 * `state` gets the same treatment, and it is load-bearing rather than
 * cosmetic. A dead-letter stall DERIVES `state: "degraded"` on its own
 * (`classifyDegradedEvidence` → `hasIndependentDegradingEvidence`,
 * `connection-health.ts`: the stall's `LocalExporterAvailable` /
 * `BacklogClear` conditions are themselves the degrading evidence). Treating
 * that derived state as independent trouble would double-count ONE signal and
 * make this branch unreachable for the exact production shape it exists to
 * fix. So the state is accepted when its degrading conditions are only ever
 * the stall's own; any OTHER false condition still means real, separate
 * trouble and forfeits the narrow label.
 */
function minorityDeadLetterIsSoleDegradation(
  snapshot: ConnectionHealthSnapshot,
  toneInputs: readonly { axis: string; tone: VerdictTone }[]
): boolean {
  if (!isMinorityDeadLetterStall(snapshot)) {
    return false;
  }
  const nonOutboxDegrading = toneInputs.some(
    (input) => DEGRADING_AXES.has(input.axis) && input.axis !== "outbox" && TONE_RANK[input.tone] >= TONE_RANK.amber
  );
  if (nonOutboxDegrading) {
    return false;
  }
  if (
    NON_DEGRADING_AMBER_STATES.has(snapshot.state) ||
    TONE_RANK[baseStateTone(snapshot.state, snapshot.last_success_at)] < TONE_RANK.amber
  ) {
    return true;
  }
  // `degraded` is the one amber state a dead-letter stall derives by itself.
  // Accept it only when the stall's own conditions are the ONLY false ones.
  return snapshot.state === "degraded" && !hasNonOutboxFalseCondition(snapshot);
}

/**
 * Whether any CURRENT failing condition comes from somewhere other than the
 * local-device outbox stall. These are the conditions that would have made the
 * connection degraded regardless of the backlog, so their presence means the
 * narrow "Some records stuck" claim is not the whole story.
 */
function hasNonOutboxFalseCondition(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) =>
      condition.current &&
      condition.status === "false" &&
      condition.type !== "LocalExporterAvailable" &&
      condition.type !== "BacklogClear"
  );
}

/**
 * Whether stale freshness is the ONLY reason the headline state degraded — a
 * source that is collecting fine but is simply overdue for its next run.
 *
 * WHY THIS EXISTS (live defect 2026-08-25). A SCHEDULABLE connector whose data
 * has aged past its staleness window reaches `state: "degraded"`, because the
 * `Fresh` condition is `false` at `warning` severity and that is independent
 * degrading evidence (`isDegradingCondition`, `connection-health.ts`). The two
 * stale-advisory classifiers that would soften it to `idle`
 * (`classifyManualStaleAdvisory` / `classifyAssistedStaleAdvisory`) are ordered
 * AFTER `classifyDegradedEvidence` and only apply to manual-refresh-only or
 * assisted-refresh connectors, so a plain `background_safe`/`automatic`
 * connector never reaches them.
 *
 * `amberLabel` then read `degraded` as `stateIsBroken` and printed "Missing
 * data", while `buildForwardStatement` — which reads the DISPOSITION, and the
 * disposition stayed `complete` because `deriveForwardDisposition`'s Rule 4
 * likewise fires only for manual/assisted refresh — printed "Current and
 * collecting normally." Jellyfin, Notion and Steam rendered exactly that pair
 * in production: an amber "Missing data" pill above a sentence claiming the
 * source was current.
 *
 * The pill was the wrong side. Nothing was missing: coverage was green,
 * attention clear, outbox clear. Per this module's own label vocabulary,
 * "Missing data" is reserved for real collection trouble (coverage gaps,
 * attention, a stalled outbox) and "Needs refresh" is the label for a
 * connection "that is otherwise working but not current". So a
 * staleness-only degradation takes "Needs refresh", the same label the
 * manual-refresh path already produced for the identical owner-facing
 * situation.
 *
 * The check is deliberately EVIDENCE-BASED rather than a new state in
 * {@link NON_DEGRADING_AMBER_STATES}: `degraded` is a real degradation for
 * every other cause, and blanket-listing it would relabel genuine coverage
 * gaps. Requiring `Fresh` to be the sole current false condition keeps every
 * other degrading cause on "Missing data".
 *
 * Exported for `fleet-health.ts`'s `materiallyBlocked` gate (workstream A,
 * cadence-relative lateness): the SAME evidence-based test that keeps this
 * module's pill from misreading ordinary lateness as "Missing data" must
 * also keep the fleet banner from misreading it as a material block — see
 * `banner_warranted`'s doc comment on `FleetHealthVerdict`, which already
 * commits to "does NOT fire for ordinary cadence-relative lateness." A
 * single shared predicate is the only way both surfaces cannot drift apart.
 */
/**
 * Whether the connection's most recent run failed. This is the `degraded` cause
 * that leaves coverage complete and the disposition `complete` — the earlier
 * runs still proved coverage, and no run owes more data — so it is invisible to
 * both of those axes and must be read off the condition directly.
 */
function hasFailedCollectionCondition(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) => condition.current && condition.status === "false" && condition.type === "CollectionSucceeded"
  );
}

/**
 * Whether cadence lateness is the ONLY thing wrong with this connection.
 *
 * ONE predicate, shared by `owner-state.ts` (resolver) and `fleet-health.ts`
 * (material/diagnostic classification), so those two surfaces cannot drift
 * apart on the same question. `staleFreshnessIsSoleDegradation` above is
 * retained for LABEL selection, where its broader "any staleness-only
 * degradation" reading is intentional; this one is narrower and is the only
 * input permitted to suppress a system-fault classification.
 *
 * Keyed on the explicit `snapshot.lateness` FACT, never on the rendered tone. A
 * merely-late source legitimately earns an amber pill, which made it
 * indistinguishable from real degradation: ordinary lateness resolved
 * `system_degraded`, grouped as `system_issue`, and fired the global banner for
 * a source whose next run simply had not happened yet.
 *
 * Fails closed on every axis:
 *  - requires a POSITIVE lateness fact (`late` or `overdue`). `unknown` — no
 *    declared cadence, or never a successful run — softens nothing, so a source
 *    that cannot be judged keeps whatever verdict it had.
 *  - requires the freshness axis to be `stale`. Lateness explains staleness and
 *    nothing else.
 *  - requires EVERY current false condition to be `Fresh`. One unrelated
 *    failing condition — credentials, runtime, coverage, outbox — and this
 *    returns false, so a genuinely broken source is never softened by also
 *    happening to be late.
 *
 * `overdue` is included: mature lateness is a real degradation on the ROW (it
 * keeps `warning` severity and its `degraded` headline) but it is still not a
 * SYSTEM FAULT, and may not banner without an independently proven
 * owner-actionable or blocked cause.
 */
export function cadenceLatenessIsSoleDegradation(snapshot: ConnectionHealthSnapshot): boolean {
  const lateness = snapshot.lateness?.state;
  if (lateness !== "late" && lateness !== "overdue") {
    return false;
  }
  if (snapshot.axes.freshness !== "stale") {
    return false;
  }
  const falseConditions = snapshot.conditions.filter((condition) => condition.current && condition.status === "false");
  return falseConditions.length > 0 && falseConditions.every((condition) => condition.type === "Fresh");
}

export function staleFreshnessIsSoleDegradation(snapshot: ConnectionHealthSnapshot): boolean {
  if (snapshot.state !== "degraded" || snapshot.axes.freshness !== "stale") {
    return false;
  }
  const falseConditions = snapshot.conditions.filter((condition) => condition.current && condition.status === "false");
  return falseConditions.length > 0 && falseConditions.every((condition) => condition.type === "Fresh");
}

/**
 * Decide the amber label. Four outcomes, in order of specificity:
 *
 *   - "Some records stuck" when the sole degradation is a minority dead-letter
 *     backlog on the local collector's host.
 *   - "Missing optional data" when the sole degradation is a lost collect-intent
 *     non-required stream (owner decision 2026-08-23).
 *   - "Needs refresh" when EVERY reason the tone reached amber-or-worse is one
 *     of the not-actually-broken shapes: `state: idle` (with a prior success),
 *     `state: cooling_off`, `freshness: stale`, or `disposition:
 *     owner_refresh_due`.
 *   - "Missing data" otherwise — any other axis reaching amber-or-worse, `state`
 *     outside those non-degrading states, or `disposition` being anything other
 *     than `owner_refresh_due` means real trouble.
 *
 * The optional-loss check runs FIRST because that state would otherwise be
 * indistinguishable from a required coverage gap: both surface as an amber
 * `coverage` axis, and only the stream rollups know which kind it is.
 */
function amberLabel(
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  toneInputs: readonly { axis: string; tone: VerdictTone }[],
  streams: readonly StreamRollup[]
): VerdictLabel {
  if (minorityDeadLetterIsSoleDegradation(snapshot, toneInputs)) {
    return "Some records stuck";
  }
  if (optionalLossIsSoleDegradation(streams, toneInputs)) {
    return "Missing optional data";
  }
  const stateIsNotActuallyBroken =
    NON_DEGRADING_AMBER_STATES.has(snapshot.state) || staleFreshnessIsSoleDegradation(snapshot);
  const stateIsBroken =
    !stateIsNotActuallyBroken && TONE_RANK[baseStateTone(snapshot.state, snapshot.last_success_at)] >= TONE_RANK.amber;
  const dispositionIsBroken =
    disposition !== "owner_refresh_due" && TONE_RANK[dispositionTone(disposition)] >= TONE_RANK.amber;
  const hasDegradingAxis = toneInputs.some(
    (input) => DEGRADING_AXES.has(input.axis) && TONE_RANK[input.tone] >= TONE_RANK.amber
  );
  return stateIsBroken || dispositionIsBroken || hasDegradingAxis ? "Missing data" : "Needs refresh";
}

function labelForPill(
  tone: VerdictTone,
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  toneInputs: readonly { axis: string; tone: VerdictTone }[],
  streams: readonly StreamRollup[] = []
): VerdictLabel {
  if (tone === "grey" && snapshot.badges.syncing) {
    return "Checking";
  }
  if (tone === "green" && snapshot.axes.outbox === "active") {
    return "Syncing";
  }
  // A one-time import that reached green did so BECAUSE freshness is
  // not_applicable, not because it proved current. "Healthy" implies an
  // ongoing collection loop this source will never run again; "Import
  // complete" names the actual, final state honestly.
  //
  // `importCompletionProven` (receipt-gated: `CollectionSucceeded === true`)
  // is required alongside `freshnessNotApplicable`, not `freshnessNotApplicable`
  // alone: an `idle` connection with no prior success ALSO tones green (see
  // `baseStateTone`), so a never-run manual connector — `Fresh: not_applicable`
  // from source-kind alone, but no receipt ever proving an import finished —
  // must not be labeled "Import complete".
  if (tone === "green" && importCompletionProven(snapshot) && freshnessNotApplicable(snapshot)) {
    return "Import complete";
  }
  if (tone === "amber") {
    const label = amberLabel(snapshot, disposition, toneInputs, streams);
    // An active run dominates a routine "needs refresh" nudge (Wave 10a
    // active-run visibility): when every reason the tone reached amber is a
    // not-actually-broken shape (idle-with-prior-success, stale, or
    // owner_refresh_due) AND a run is currently advancing, the connection is
    // already doing the thing the nudge would ask for — render `Syncing`
    // like the green/active-outbox case, not `Needs refresh`. Real trouble
    // (`Missing data`) is never softened this way; active work does not mask a
    // genuine defect.
    if (label === "Needs refresh" && snapshot.badges.syncing) {
      return "Syncing";
    }
    return label;
  }
  return TONE_TO_LABEL[tone];
}

function worse(a: VerdictTone, b: VerdictTone): VerdictTone {
  return TONE_RANK[a] >= TONE_RANK[b] ? a : b;
}

/**
 * Base tone implied by the headline state — NEVER read straight as the pill tone.
 *
 * `idle` covers two distinct shapes: a genuinely never-run connection with no
 * evidence yet (no prior success), and a connection that HAS run before but is
 * currently not making progress on its own — owner-paused schedule, or a
 * stale manual/assisted-refresh advisory (`classifyOwnerPaused` /
 * `classifyStaleAdvisory`, `connection-health.ts`). The first case has nothing
 * to act on and stays green. The second case is a live connection sitting on
 * old data or a paused schedule; the owner has a legible action (resume the
 * schedule, run a refresh) so it must not read as `Healthy`.
 */
function baseStateTone(state: ConnectionHealthSnapshot["state"], lastSuccessAt: string | null): VerdictTone {
  switch (state) {
    case "healthy":
      return "green";
    case "idle":
      return lastSuccessAt === null ? "green" : "amber";
    case "cooling_off":
      return "amber";
    case "needs_attention":
      return "amber";
    case "degraded":
      return "amber";
    case "blocked":
      return "red";
    case "unknown":
      return "grey";
    default: {
      // Exhaustiveness guard: a new state must declare a base tone.
      const _never: never = state;
      return _never;
    }
  }
}

/**
 * A completed one-time import (`source_kind = 'manual'`) declares its `Fresh`
 * condition `not_applicable` — a settled answer, not a pending one (see
 * `conditionIsSettledSatisfied`, `connection-health.ts`, and
 * `design-notes/source-state-truth-2026-08-18.md`). `axes.freshness` itself
 * stays `unknown` (it is derived straight from raw freshness evidence, which
 * a finished import never produces), so the tone/label/annotation layer must
 * read the CONDITION, not the axis, to avoid re-encoding the same "we don't
 * know" doubt the condition model already settled.
 */
export function freshnessNotApplicable(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) =>
      condition.type === "Fresh" &&
      condition.status === "not_applicable" &&
      condition.reason === CONNECTION_CONDITION_REASONS.FRESHNESS_NOT_APPLICABLE_COMPLETE
  );
}

/**
 * Whether a one-time import has POSITIVE RECEIPT PROOF that it actually
 * finished ingesting something — i.e. `CollectionSucceeded` settled `true`
 * via `CONDITION_REASON.COLLECTION_SUCCEEDED_IMPORT_COMPLETE`, which
 * `collectionSucceededCondition` (`connection-health.ts`) only grants from
 * `ConnectionAcquisitionEvidence.complete`, which the caller (`ref-control.ts`)
 * only sets from a real terminal run record — never from `source_kind` alone.
 *
 * `freshnessNotApplicable` above answers a NARROWER question ("does the
 * freshness axis apply to this connection kind at all") and is correctly
 * `true` even for a manual connection that has never run — that is honest
 * copy about why there is no freshness timestamp. This function answers the
 * STRONGER question callers actually mean when they render a completion
 * claim ("Import complete", `ownerState.resolver === "healthy"`): use this
 * one, not `freshnessNotApplicable` alone, anywhere the answer feeds an
 * owner-facing claim that data collection succeeded.
 */
export function importCompletionProven(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) =>
      condition.type === "CollectionSucceeded" &&
      condition.status === "true" &&
      condition.reason === CONNECTION_CONDITION_REASONS.COLLECTION_SUCCEEDED_IMPORT_COMPLETE
  );
}

function freshnessHealthTone(snapshot: ConnectionHealthSnapshot): VerdictTone {
  if (freshnessNotApplicable(snapshot)) {
    return "green";
  }
  switch (snapshot.axes.freshness) {
    case "fresh":
      return "green";
    case "stale":
      return "amber";
    case "unknown":
      return "grey";
    default: {
      const _never: never = snapshot.axes.freshness;
      return _never;
    }
  }
}

function coverageTone(axis: CoverageAxis): VerdictTone {
  switch (axis) {
    case "complete":
    case "deferred":
    case "inventory_only":
      return "green";
    case "partial":
    case "gaps":
    case "retryable_gap":
      return "amber";
    case "terminal_gap":
    case "unsupported":
    case "unavailable":
      return "red";
    case "unknown":
      return "grey";
    default: {
      const _never: never = axis;
      return _never;
    }
  }
}

function dispositionTone(disposition: ForwardDisposition): VerdictTone {
  switch (disposition) {
    case "complete":
      return "green";
    case "checking":
    case "unmeasured":
      return "grey";
    case "resumable":
      return "amber";
    case "owner_refresh_due":
      return "amber";
    case "awaiting_owner":
      return "amber";
    case "terminal":
      return "red";
    default: {
      const _never: never = disposition;
      return _never;
    }
  }
}

function terminalAwareTone(
  tone: VerdictTone,
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  progress: ProgressEvidence | null
): VerdictTone {
  if (tone === "red" && softensTerminalCoverageToDegraded(snapshot, disposition, progress)) {
    return "amber";
  }
  return tone;
}

function attentionTone(snapshot: ConnectionHealthSnapshot): VerdictTone {
  switch (snapshot.axes.attention) {
    case "none":
      return "green";
    case "acknowledged":
    case "in_progress":
    case "open":
      return "amber";
    default: {
      const _never: never = snapshot.axes.attention;
      return _never;
    }
  }
}

function outboxTone(snapshot: ConnectionHealthSnapshot): VerdictTone {
  switch (snapshot.axes.outbox) {
    case "idle":
    case "active":
      return "green";
    case "stalled":
      if (hasTransientUploadFailure(snapshot)) {
        return "amber";
      }
      // A dead-letter backlog that is a strict minority of what the host
      // handled ambers rather than reds: the source demonstrably collected
      // the rest. The loss stays fully visible — same owner action, same
      // "N of M" summary, never green. See `deadLetterIsMinorityOfCorpus`.
      if (isMinorityDeadLetterStall(snapshot)) {
        return "amber";
      }
      return "red";
    case "unknown":
      // `unknown` is absence of local-device/outbox evidence for many normal
      // API/browser connectors, not proof that the connector is unhealthy.
      // Stalled outbox evidence is still red; unknown simply does not downgrade
      // an otherwise complete/fresh connection.
      return "green";
    default: {
      const _never: never = snapshot.axes.outbox;
      return _never;
    }
  }
}

/**
 * Whether a stream's terminal shortfall is fully backed by durable per-item
 * impossibility proof, so it owes nothing further. The one place this module
 * asks that question — tone, the terminal-action gate, and the affected-stream
 * list all read it, so they cannot drift apart. Meaningful only for
 * `terminal_gap`; the boolean itself is computed once by
 * `isStreamFullyUnfillableAccounted` (`server/connector-gap-classification.ts`)
 * and merely carried here.
 */
function streamCoverageIsFullyAccounted(stream: StreamRollup): boolean {
  return stream.coverage === "terminal_gap" && stream.unfillable_accounted === true;
}

/**
 * Whether an `optional` stream's shortfall is TERMINAL — permanently lost, with
 * no proof that losing it was acceptable.
 *
 * This is the discriminator the owner's 2026-08-23 policy turns on. Only
 * `terminal_gap` qualifies: a `retryable_gap`/`partial`/`gaps` axis is filled by
 * the next ordinary run, so downgrading the source for it would manufacture
 * exactly the alert fatigue the priority weighting exists to prevent. A
 * shortfall that is fully unfillable-accounted also does NOT qualify — durable
 * per-item proof of impossibility is the same claim an accepted-absence policy
 * makes, just proven rather than declared, and it already tones green for
 * required streams.
 *
 * `unsupported`/`unavailable` are deliberately excluded here: those axes are
 * themselves accepted-absence vocabulary, and a stream carrying them is
 * classified `accepted_absence` upstream by `streamPriority`.
 */
function isOptionalTerminalLoss(stream: StreamRollup): boolean {
  return (
    stream.priority === "optional" && stream.coverage === "terminal_gap" && !streamCoverageIsFullyAccounted(stream)
  );
}

/**
 * The worst per-stream coverage tone, weighted by manifest priority. THREE
 * cases, deliberately not two:
 *
 *   - `required`         : contributes its full tone (red terminal stays red).
 *   - `optional`         : a TERMINAL loss contributes amber and no worse; any
 *                          non-terminal shortfall annotates only.
 *   - `accepted_absence` : never contributes; annotates only.
 *
 * The `optional` case is the owner's 2026-08-23 decision. Previously `optional`
 * and `accepted_absence` were collapsed by a single `priority === "required"`
 * test, which overloaded `required: false` to mean both "not load-bearing" and
 * "we accept its absence". Those are different claims: a stream the connector
 * INTENDS to collect (`coverage_policy: collect`, or no policy) and has now
 * lost forever is a real loss to the owner, and a source sitting on one must
 * not read "Healthy" (iMessage participants/attachments on older macOS is the
 * live shape). It ambers rather than reds because it is still, genuinely, not
 * required — the source keeps working, it just cannot deliver everything.
 *
 * A `terminal_gap` whose ENTIRE shortfall is proven permanently uncollectable
 * tones GREEN, for the same reason it no longer derives a `terminal` disposition
 * (`isUnfillableAccountedTerminalGap`, `connection-health.ts`): the connector
 * collected everything collectible and can name exactly what it could not and
 * why, which is the coverage axis's own `SourceCoverageComplete: true /
 * coverage_complete_unfillable_accounted` verdict. Reading the raw axis here
 * while the condition set reads the proof would re-introduce the very
 * disagreement this pairing exists to remove — the pill would stay red under a
 * fully healthy condition set. Only `terminal_gap` is softened; `unsupported`
 * and `unavailable` keep their red.
 */
function worstStreamCoverageTone(streams: readonly StreamRollup[]): VerdictTone {
  let worstTone: VerdictTone = "green";
  for (const stream of streams) {
    const tone = streamCoverageIsFullyAccounted(stream) ? "green" : coverageTone(stream.coverage);
    if (stream.priority === "required") {
      worstTone = worse(worstTone, tone);
      continue;
    }
    if (isOptionalTerminalLoss(stream)) {
      // Capped at amber: a lost optional stream is a real loss, but it is not
      // the "this source cannot collect" claim a required loss makes.
      worstTone = worse(worstTone, "amber");
    }
    // accepted-absence, and any non-terminal optional coverage, annotate only.
  }
  return worstTone;
}

// ─── Forward disposition (sole oracle) ──────────────────────────────────────

/**
 * The connection-level disposition, re-derived through the SOLE oracle
 * (`deriveForwardDisposition`) over the rolled-up stream evidence. We never invent a
 * parallel terminality computation; this funnels the synthesizer's stream rollups
 * through the same function the projection uses.
 */
function connectionDisposition(
  snapshot: ConnectionHealthSnapshot,
  streams: readonly StreamRollup[],
  refresh: ConnectionRefreshEvidence | null,
  scheduleEvidence: ScheduleEvidence | null
): ForwardDisposition {
  if (streams.length === 0) {
    // No per-stream rollup supplied — trust the snapshot's own connection-level
    // disposition (already derived through the oracle by the projection).
    return snapshot.forward_disposition;
  }
  // Worst-wins over per-stream dispositions, each derived through the oracle.
  // ONLY `required` streams contribute, and that is deliberate even under the
  // 2026-08-23 optional-loss policy.
  //
  // The connection-level `forward_disposition` is a single claim about what
  // happens NEXT for the whole connection, and it is read by surfaces well
  // beyond the pill (owner state, fleet rollups, required actions, the
  // "resume" statement invariants). Letting a lost OPTIONAL stream promote it
  // to `terminal` would assert the whole connection is finished — which is
  // false, since the source keeps collecting everything load-bearing. The
  // optional loss is carried by the COVERAGE tone instead, capped at amber
  // (`worstStreamCoverageTone`), which is precisely the "annotate, do not
  // dominate" split the priority weighting exists to express.
  //
  // So the three-way distinction lives in the coverage rollup; disposition
  // stays required-only. `optional` and `accepted_absence` are still NOT
  // equivalent — they differ in tone, label, and stream rows.
  let worstRank = TONE_RANK[dispositionTone(snapshot.forward_disposition)];
  let worst: ForwardDisposition = snapshot.forward_disposition;
  for (const stream of streams) {
    const disposition = streamDisposition(stream, snapshot, refresh, scheduleEvidence);
    const counts = stream.priority === "required";
    if (!counts) {
      continue;
    }
    const rank = TONE_RANK[dispositionTone(disposition)];
    if (rank > worstRank) {
      worstRank = rank;
      worst = disposition;
    }
  }
  if (worst === "complete" && snapshot.forward_disposition === "owner_refresh_due") {
    // The connection-level projection has already run through the forward
    // disposition oracle. Do not let optional/checking stream rows erase a
    // stale-manual owner refresh due at the connection level.
    return "owner_refresh_due";
  }
  return worst;
}

function streamDisposition(
  stream: StreamRollup,
  snapshot: ConnectionHealthSnapshot,
  refresh: ConnectionRefreshEvidence | null,
  scheduleEvidence: ScheduleEvidence | null
): ForwardDisposition {
  const schedule = scheduleEvidenceToRecord(scheduleEvidence);
  return deriveForwardDisposition({
    attentionOpen: stream.attention_open,
    coverage: stream.coverage,
    freshness: snapshot.axes.freshness,
    gapRetryable: stream.gap_retryable,
    refresh,
    schedule,
    unfillableAccounted: stream.unfillable_accounted === true,
  });
}

function scheduleEvidenceToRecord(scheduleEvidence: ScheduleEvidence | null): { readonly enabled: boolean } | null {
  if (scheduleEvidence?.mode === "scheduled-active") {
    return { enabled: true };
  }
  if (scheduleEvidence?.mode === "scheduled-disabled") {
    return { enabled: false };
  }
  return null;
}

// ─── Required actions ───────────────────────────────────────────────────────

const URGENCY_RANK: Record<ActionUrgency, number> = { now: 0, overdue: 1, soon: 2, verifying: 3 };

/**
 * Credential failures are owner-sole-resolution, whether the source rejected an
 * existing credential or the reference lacks the credential needed to run.
 */
function hasCredentialFailure(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) => condition.type === "CredentialsValid" && condition.status === "false" && condition.current
  );
}

function latestCollectionSucceeded(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) => condition.type === "CollectionSucceeded" && condition.status === "true" && condition.current
  );
}

/**
 * The last successful run is the capability evidence for this source. A newer
 * failed run or an unrelated projection-read problem may change the health
 * state, but it cannot turn a source that collected today into one that cannot
 * collect at all.
 */
function collectionSucceededToday(snapshot: ConnectionHealthSnapshot, progress: ProgressEvidence | null): boolean {
  return (
    latestCollectionSucceeded(snapshot) ||
    relativeDayAge(snapshot.last_success_at, progress?.observed_at ?? null) === "today"
  );
}

function softensTerminalCoverageToDegraded(
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  progress: ProgressEvidence | null
): boolean {
  // Same-day success only softens a terminal disposition when the
  // CONNECTION's own coverage axis independently shows the gap. A required
  // stream's rollup can drive `disposition` to `terminal` on its own even
  // when the connection-level axis reads `complete` — that is a real,
  // irreversible loss on a load-bearing stream, and same-day success
  // elsewhere on the connection does not undo it.
  return (
    disposition === "terminal" &&
    snapshot.axes.coverage === "terminal_gap" &&
    collectionSucceededToday(snapshot, progress)
  );
}

/**
 * The softened maintainer `code_fix` status text: the latest collection
 * SUCCEEDED and left a known coverage gap behind.
 */
const SOFTENED_COVERAGE_CTA = "Coverage gap needs review";

/**
 * The hard maintainer `code_fix` status text: data that cannot be collected
 * at all.
 */
const TERMINAL_COVERAGE_CTA = "Missing data needs review";

/**
 * The status text for a maintainer `code_fix`. This slot is NOT a button: a
 * maintainer-audience action is not owner-satisfiable (`satisfied_when: {
 * kind: "none" }`), so the console renders it as inert status text
 * (`sources-view.tsx`, the `!ownerRunnable` branch). 428898c92 established the
 * register deliberately — for a defect the owner cannot act on, this slot
 * states a CONDITION rather than inviting an action he cannot take.
 *
 * It must not restate the sentence beside it. The console stacks the two:
 * `source-actionability.ts` sets the row's `what` from
 * `verdict.forward_statement` and its `actionLabel` from this `cta`. The hard
 * branch used to return the forward statement's own sentence verbatim, so
 * `HEB - gezalsatx@yahoo.com` rendered "Some data from this source can't be
 * collected." above "Some data from this source can't be collected" — one
 * fact, printed twice, in the slot reserved for what happens next.
 *
 * Both branches now read as the softened one always did: a short condition
 * label that names the source's state without re-spending the sentence below.
 *
 * The wording stays inside 428898c92's constraint. That commit removed
 * "Connector code needs a fix" because naming whose code is broken is
 * developer language, unhelpful on a surface where the owner is running the
 * software himself. "Missing data needs review" names the owner's data and
 * the disposition of the case — nothing about our code — and mirrors the
 * softened branch one line up. Severity still separates the two: the softened
 * case is a coverage GAP in an otherwise-succeeding run, this one is data that
 * cannot be collected at all, and the sentence beside it says so in full.
 */
function terminalCoverageCta(
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  progress: ProgressEvidence | null
): string {
  return softensTerminalCoverageToDegraded(snapshot, disposition, progress)
    ? SOFTENED_COVERAGE_CTA
    : TERMINAL_COVERAGE_CTA;
}

/** Open structured owner attention (the `needs_attention` driver). */
function hasOpenAttention(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.axes.attention !== "none";
}

function exactSyncTargetFromAttention(attention: ConnectionAttentionEvidence | null): RequiredActionTarget | null {
  if (attention === null || attention.runId === null) {
    return null;
  }
  return { kind: "sync", run_id: attention.runId };
}

function hasOwnerAction(actions: readonly RequiredAction[]): boolean {
  return actions.some((action) => action.audience === "owner" && action.satisfied_when.kind !== "none");
}

/** Typed owner-sole-resolution predicate shared by owner and fleet projections. */
export function hasOwnerBlockingAction(verdict: Pick<RenderedVerdict, "channel" | "required_actions">): boolean {
  // `channel` is the typed owner-interruption decision: advisory actions are
  // optional accelerants, while attention means the owner is the sole resolver.
  return verdict.channel === "attention" && hasOwnerAction(verdict.required_actions);
}

/** Typed maintainer repair predicate shared by owner and fleet projections. */
export function hasMaintainerCodeFix(verdict: Pick<RenderedVerdict, "required_actions">): boolean {
  return verdict.required_actions.some((action) => action.audience === "maintainer" && action.kind === "code_fix");
}

/**
 * Shared owner/fleet predicate for a passive scheduled retry. This is a narrow
 * projection predicate, not another health state: connection health must first
 * establish `cooling_off`, and affirmative collection, coverage, freshness,
 * schedule, and no-blocker evidence must agree. Independent degrading evidence,
 * owner action, and maintainer repair always win over scheduler timing.
 */
export function isPassiveScheduledRecovery(
  snapshot: ConnectionHealthSnapshot,
  verdict: Pick<RenderedVerdict, "channel" | "required_actions">
): boolean {
  return (
    snapshot.state === "cooling_off" &&
    hasAffirmativePassiveRecoveryEvidence(snapshot) &&
    !hasOwnerBlockingAction(verdict) &&
    !hasMaintainerCodeFix(verdict)
  );
}

/**
 * Whether a stalled outbox is eligible to add an action (`wait` or
 * `add_info`, chosen by the caller on `hasTransientUploadFailure`): durable
 * work is stuck outside the server, the disposition is not already terminal
 * (a terminal connection gets `code_fix` instead), and nothing
 * owner-actionable already covers the connection (a stalled outbox never
 * competes with a real defect already found above).
 */
function isStalledOutboxActionable(
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  actions: readonly RequiredAction[]
): boolean {
  return snapshot.axes.outbox === "stalled" && disposition !== "terminal" && !hasOwnerAction(actions);
}

/**
 * Whether a disabled schedule with a prior success should emit
 * `reattach_schedule`: the system cannot self-recover with no automatic
 * retry to fall back on, and no real defect found earlier in
 * `buildRequiredActions` (`actions.length === 0`) already outranks a
 * merely-paused schedule.
 */
function isOwnerPausedScheduleEligible(
  scheduleEvidence: ScheduleEvidence | null,
  actions: readonly RequiredAction[]
): boolean {
  return scheduleEvidence?.mode === "scheduled-disabled" && scheduleEvidence.hasPriorSuccess && actions.length === 0;
}

function hasTransientUploadFailure(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) =>
      condition.current &&
      (condition.reason === CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_TRANSIENT_UPLOAD_FAILURE ||
        condition.reason === CONNECTION_CONDITION_REASONS.OUTBOX_TRANSIENT_UPLOAD_FAILURE)
  );
}

function hasDeadLetterBacklog(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) =>
      condition.current &&
      (condition.reason === CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_DEAD_LETTER_BACKLOG ||
        condition.reason === CONNECTION_CONDITION_REASONS.OUTBOX_DEAD_LETTER_BACKLOG)
  );
}

/**
 * Whether a dead-letter backlog is a strict MINORITY of the records the
 * collector host handled — the discriminator between "this source is broken"
 * and "this source works and dropped some records on the floor".
 *
 * This is NOT a tolerance threshold, and deliberately so. There is no
 * percentage below which a loss is ignored: the count and the denominator are
 * rendered verbatim in the action summary on EVERY path
 * (`deadLetterSummary`), the owner action is emitted on every path, and the
 * verdict never reaches green while a dead letter exists. What the proportion
 * changes is SEVERITY ONLY — red ("Can't collect", a claim about capability)
 * versus amber ("Some records stuck", a claim about a subset). Hiding the loss
 * at any magnitude would be the false-green the owner fears most; calling a
 * 2.5M-record source that just uploaded 10,000 of 10,001 records "Can't
 * collect" is the false-red he actually hit.
 *
 * `dead_letter * 2 < total` is integer-exact — no float rounding, no
 * configurable knob to drift. Majority loss (>= half) keeps its red, because
 * at that point "Can't collect" is a fair description of the host. A total
 * loss (dead_letter === total) is the extreme of that same case and stays red.
 *
 * An ABSENT or non-integer count does not soften anything: unknown magnitude
 * classifies conservatively as red, exactly as it did before this carve-out
 * existed. A count the system did not measure may never buy a gentler label —
 * the same fail-closed rule `deadLetterMagnitude` already applies to the
 * sentence.
 */
function deadLetterIsMinorityOfCorpus(snapshot: ConnectionHealthSnapshot): boolean {
  const counts = snapshot.local_device_outbox_counts;
  if (!counts) {
    return false;
  }
  const { dead_letter: deadLetter, total } = counts;
  if (!(Number.isInteger(deadLetter) && Number.isInteger(total))) {
    return false;
  }
  if (!(typeof deadLetter === "number" && typeof total === "number" && deadLetter > 0 && total > 0)) {
    return false;
  }
  return deadLetter * 2 < total;
}

/**
 * Whether the outbox's stall is a minority dead-letter backlog AND nothing
 * else about the outbox is also wrong. A stall carrying any OTHER cause
 * (state-read failure, stale pending, stale heartbeat) describes a collector
 * that cannot run, which the proportion of one backlog says nothing about —
 * so it keeps its red.
 */
function isMinorityDeadLetterStall(snapshot: ConnectionHealthSnapshot): boolean {
  return (
    snapshot.axes.outbox === "stalled" &&
    hasDeadLetterBacklog(snapshot) &&
    !hasOtherStalledOutboxCause(snapshot) &&
    deadLetterIsMinorityOfCorpus(snapshot)
  );
}

/** Stalled-outbox reasons that describe a collector that cannot run at all. */
const NON_DEAD_LETTER_STALL_REASONS: ReadonlySet<string> = new Set([
  CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STATE_READ_FAILED,
  CONNECTION_CONDITION_REASONS.OUTBOX_STATE_READ_FAILED,
  CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STALE_PENDING,
  CONNECTION_CONDITION_REASONS.OUTBOX_STALE_PENDING,
  CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STALE_HEARTBEAT,
  CONNECTION_CONDITION_REASONS.OUTBOX_STALE_HEARTBEAT,
]);

function hasOtherStalledOutboxCause(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) => condition.current && NON_DEAD_LETTER_STALL_REASONS.has(condition.reason)
  );
}

function hasEffectiveActiveScheduleEvidence(
  refresh: ConnectionRefreshEvidence | null,
  scheduleEvidence: ScheduleEvidence | null
): boolean {
  if (scheduleEvidence?.mode !== "scheduled-active") {
    return false;
  }
  // "Normally schedulable" means the refresh policy is not manual-only.
  // The one manual-only exception we honor is the explicit Amazon-style
  // owner opt-in: recommended_mode=manual + backgroundSafe=true.
  return !isManualRefreshOnly(refresh) || (refresh?.recommendedMode === "manual" && refresh.backgroundSafe === true);
}

/**
 * Whether an `owner_refresh_due` connection should offer `refresh_now`.
 * Suppressed when a paused schedule (owned by `reattach_schedule` instead)
 * or an active run already covers the same "run it again" outcome; offered
 * only under a manual-only or assisted refresh policy.
 */
function shouldOfferRefreshNowAction(
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  refresh: ConnectionRefreshEvidence | null,
  scheduleEvidence: ScheduleEvidence | null
): boolean {
  return (
    disposition === "owner_refresh_due" &&
    scheduleEvidence?.mode !== "scheduled-disabled" &&
    !snapshot.badges.syncing &&
    (isManualRefreshOnly(refresh) || isAssistedRefresh(refresh))
  );
}

/**
 * Whether the streams behind this gap are ALL declared `retry_by_runtime` —
 * an ordinary future run already retries every one of them without owner
 * involvement, so an owner-facing "Retry now" would offer an action that adds
 * nothing. Fails open (`false`, i.e. keep offering the CTA) whenever a
 * contributing stream is missing from `streams`, or any contributing stream's
 * `recovery_action` is absent/unknown/anything other than `retry_by_runtime`
 * — a genuinely owner-actionable gap, or one this rollup can't yet speak to,
 * must never lose its action.
 */
function allContributingStreamsRetryByRuntime(streams: readonly StreamRollup[], streamIds: readonly string[]): boolean {
  if (streamIds.length === 0) {
    return false;
  }
  const streamById = new Map(streams.map((s) => [s.stream_id, s]));
  return streamIds.every((id) => streamById.get(id)?.recovery_action === "retry_by_runtime");
}

function shouldOfferRetryGapAction(
  snapshot: ConnectionHealthSnapshot,
  refresh: ConnectionRefreshEvidence | null,
  scheduleEvidence: ScheduleEvidence | null,
  progress: ProgressEvidence | null,
  streams: readonly StreamRollup[],
  retryGapStreamIds: readonly string[]
): boolean {
  if (isManualRefreshOnly(refresh) && !hasEffectiveActiveScheduleEvidence(refresh, scheduleEvidence)) {
    return true;
  }
  if (snapshot.badges.syncing || snapshot.reason_code === "source_pressure") {
    return false;
  }
  if (snapshot.state === "degraded" && progress?.mode === "deferred") {
    return true;
  }
  if (progress?.mode === "deferred" || progress?.mode === "scheduled") {
    return false;
  }
  if (snapshot.state === "cooling_off" || snapshot.next_attempt_at) {
    return false;
  }
  if (snapshot.axes.coverage === "retryable_gap") {
    return !(
      hasEffectiveActiveScheduleEvidence(refresh, scheduleEvidence) &&
      allContributingStreamsRetryByRuntime(streams, retryGapStreamIds)
    );
  }
  return snapshot.state === "degraded";
}

const LOCAL_COLLECTOR_RECOVER_COMMAND =
  "npx -y @pdpp/local-collector recover --source-instance-id <source-instance-id>";
const LOCAL_COLLECTOR_RECOVER_APPLY_COMMAND =
  "npx -y @pdpp/local-collector recover --source-instance-id <source-instance-id> --apply";
const LOCAL_COLLECTOR_DOCTOR_COMMAND = "npx -y @pdpp/local-collector doctor --source-instance-id <source-instance-id>";
const LOCAL_COLLECTOR_REMEDIATION_TARGET: ActionRemediationTarget = {
  identity_source: "source_instance_bindings",
  kind: "local_device",
};

function localCollectorRecoverPreviewCommand(): ActionRemediationCommand {
  return {
    command_template: LOCAL_COLLECTOR_RECOVER_COMMAND,
    kind: "local_collector_recover_preview",
    label: "Preview recovery",
  };
}

function localCollectorRecoverApplyCommand(): ActionRemediationCommand {
  return {
    command_template: LOCAL_COLLECTOR_RECOVER_APPLY_COMMAND,
    kind: "local_collector_recover_apply",
    label: "Recover and run the collector",
  };
}

function localCollectorDoctorCommand(): ActionRemediationCommand {
  return {
    command_template: LOCAL_COLLECTOR_DOCTOR_COMMAND,
    kind: "local_collector_doctor",
    label: "Check local collector health",
  };
}

/**
 * The uncounted dead-letter sentence. Says PERMANENT, not merely stalled:
 * these records will NOT drain on their own. This is the fail-closed fallback
 * whenever the magnitude is genuinely unavailable — a fabricated zero is as
 * bad as a fabricated green, so an absent count costs the owner the number,
 * never the warning.
 */
const DEAD_LETTER_SUMMARY_UNCOUNTED =
  "The local collector has records on its host that failed to upload and will not retry on their own. Recovering them is a manual step.";

/**
 * Bound the dead-letter backlog the system already counted. Returns `null`
 * — meaning "render the uncounted sentence" — unless BOTH a positive
 * dead-letter count and a positive total are present as real integers.
 *
 * Every rejected shape matters: a missing count, a zeroed count, a partial
 * pair, or a non-integer would each otherwise render a magnitude the evidence
 * does not support ("0 of 0", "undefined of 10,001"). The owner reads a number
 * as a measurement, so we only print one we actually measured.
 */
function deadLetterMagnitude(counts: ConnectionHealthSnapshot["local_device_outbox_counts"]): string | null {
  if (!counts) {
    return null;
  }
  const { dead_letter: deadLetter, total } = counts;
  if (!(Number.isInteger(deadLetter) && Number.isInteger(total))) {
    return null;
  }
  if (!(typeof deadLetter === "number" && typeof total === "number" && deadLetter > 0 && total > 0)) {
    return null;
  }
  // Plural agrees with the TOTAL, the noun it actually modifies: "1 of 1
  // record", "1 of 10,001 records". "1 of 1 records" is exactly the
  // sloppiness the owner notices.
  const noun = total === 1 ? "record" : "records";
  return `${deadLetter.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${noun}`;
}

/**
 * Owner-facing dead-letter summary. Names the state AND bounds the magnitude
 * when the count is known, because "1 of 10,001" and "8,432 of 10,001" demand
 * completely different reactions and the system holds the answer either way.
 * The permanence wording is identical on both paths — only the magnitude is
 * conditional.
 */
function deadLetterSummary(snapshot: ConnectionHealthSnapshot): string {
  const magnitude = deadLetterMagnitude(snapshot.local_device_outbox_counts);
  return magnitude === null
    ? DEAD_LETTER_SUMMARY_UNCOUNTED
    : `${magnitude} on the local collector's host failed to upload and will not retry on their own. Recovering them is a manual step.`;
}

function stalledOutboxCause(snapshot: ConnectionHealthSnapshot): ActionRemediationCause {
  const reasons = new Set(
    snapshot.conditions
      .filter(
        (condition) =>
          condition.current &&
          (condition.type === "LocalExporterAvailable" || condition.type === "BacklogClear") &&
          condition.status === "false"
      )
      .map((condition) => condition.reason)
  );

  if (
    reasons.has(CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_DEAD_LETTER_BACKLOG) ||
    reasons.has(CONNECTION_CONDITION_REASONS.OUTBOX_DEAD_LETTER_BACKLOG)
  ) {
    return "dead_letter_backlog";
  }
  if (
    reasons.has(CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_TRANSIENT_UPLOAD_FAILURE) ||
    reasons.has(CONNECTION_CONDITION_REASONS.OUTBOX_TRANSIENT_UPLOAD_FAILURE)
  ) {
    return "transient_upload_failure";
  }
  if (
    reasons.has(CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STATE_READ_FAILED) ||
    reasons.has(CONNECTION_CONDITION_REASONS.OUTBOX_STATE_READ_FAILED)
  ) {
    return "state_read_failed";
  }
  if (
    reasons.has(CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STALE_PENDING) ||
    reasons.has(CONNECTION_CONDITION_REASONS.OUTBOX_STALE_PENDING)
  ) {
    return "stale_pending";
  }
  if (
    reasons.has(CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STALE_HEARTBEAT) ||
    reasons.has(CONNECTION_CONDITION_REASONS.OUTBOX_STALE_HEARTBEAT)
  ) {
    return "stale_heartbeat";
  }
  return "stalled_unknown";
}

function stalledOutboxRemediation(snapshot: ConnectionHealthSnapshot): ActionRemediation {
  const cause = stalledOutboxCause(snapshot);
  switch (cause) {
    case "state_read_failed":
      return {
        cause,
        commands: [localCollectorRecoverApplyCommand()],
        kind: "local_collector_recovery",
        label: "Run the local collector again",
        summary:
          "The server cannot read the collector's last state from that host. Run the local collector again there.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
      };
    case "dead_letter_backlog":
      return {
        cause,
        commands: [localCollectorRecoverPreviewCommand(), localCollectorRecoverApplyCommand()],
        kind: "local_collector_recovery",
        // Owner-facing, so it must mean something to a non-engineer. "Recover
        // local collector uploads" failed twice over: "local collector" is
        // jargon for the program on the owner's own machine, and "recover
        // uploads" names an internal operation rather than what happened.
        // This label says the three things the owner needs before clicking:
        // records are STUCK (not lost, not uploaded), they are on a MACHINE
        // he owns, and only he can move them. The permanence lives in the
        // summary sentence, which says the records will not retry on their
        // own — the label must not contradict it by implying a retry.
        label: "Upload records stuck on your computer",
        // Says PERMANENT, not merely stalled. `dead_letter_backlog` means the
        // outbox exhausted its retries: these records will NOT drain on their
        // own, unlike `transient_upload_failure`. The prior wording read as a
        // temporary condition, so an owner could reasonably wait for a recovery
        // that was never coming. `deadLetterSummary` additionally bounds the
        // magnitude when the count is known, and falls back to exactly this
        // permanence wording when it is not.
        summary: deadLetterSummary(snapshot),
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
      };
    case "transient_upload_failure":
      return {
        cause,
        commands: [],
        kind: "local_collector_recovery",
        label: "Wait for upload retry",
        summary:
          "The local collector hit temporary server or network errors while uploading. It will retry without owner action.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
      };
    case "stale_pending":
      return {
        cause,
        commands: [localCollectorRecoverApplyCommand()],
        kind: "local_collector_recovery",
        label: "Run the local collector again",
        summary: "The local collector has queued work that stopped moving. Run it again on that host.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
      };
    case "stale_heartbeat":
      return {
        cause,
        commands: [localCollectorRecoverApplyCommand()],
        kind: "local_collector_recovery",
        label: "Run the local collector again",
        summary:
          "The local collector reported starting or retrying but stopped checking in. Run it again on that host.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
      };
    default:
      return {
        cause,
        commands: [localCollectorDoctorCommand()],
        kind: "local_collector_recovery",
        label: "Check the local collector",
        summary: "The local collector is not making progress. Check it on the host that holds the data.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
      };
  }
}

/**
 * CTA for the maintainer `code_fix` action naming resting-unmeasured required
 * streams. "isn't being measured YET" implies a future run will measure it —
 * B10 (owner ledger 2026-08-22): a one-time import that will never run again
 * (`freshnessNotApplicable`) has no future run to make that promise.
 */
function unmeasuredRequiredStreamsCta(snapshot: ConnectionHealthSnapshot): string {
  return freshnessNotApplicable(snapshot)
    ? "Some data from this source ended before it could be measured, and this one-time import will not run again"
    : "Some data from this source isn't being measured yet";
}

/**
 * Build the ordered `required_actions[]`. Zero-or-many (design D8): a connection may
 * need BOTH `refresh_now` AND `reauth`. Every action's `terminal` is DERIVED from the
 * connection disposition through the sole oracle. The `wait` kind is the single
 * representation of self-handled deferred work and is calm by construction.
 */
function buildRequiredActions(
  snapshot: ConnectionHealthSnapshot,
  streams: readonly StreamRollup[],
  refresh: ConnectionRefreshEvidence | null,
  disposition: ForwardDisposition,
  progress: ProgressEvidence | null,
  scheduleEvidence: ScheduleEvidence | null,
  attention: ConnectionAttentionEvidence | null
): RequiredAction[] {
  const terminal = disposition === "terminal";
  const actions: RequiredAction[] = [];

  // Terminal coverage on a stream with no owner recovery path: maintainer-status
  // code_fix. Credential failures add an owner action below, so do not make
  // "code fix" the primary story for a source the owner can repair by reconnecting.
  if (terminal && !hasCredentialFailure(snapshot)) {
    actions.push({
      affects: terminalStreamIds(streams),
      audience: "maintainer",
      cta: terminalCoverageCta(snapshot, disposition, progress),
      kind: "code_fix",
      satisfied_when: { kind: "none" },
      surface: { kind: "maintainer" },
      terminal: true,
      urgency: "soon",
    });
  }

  // Resting unmeasured required stream(s) beneath an otherwise-succeeded,
  // non-credential-failed connection (design.md "Required-Stream Coverage Rollup").
  // The rollup already refused to promote the connection axis to `complete`
  // for this shape (`rollupCollectionReportCoverageOverride`,
  // `server/ref-control.ts`), so `disposition` reads `unmeasured` here — this
  // is a maintainer-status action naming the specific streams that lack
  // resolved coverage evidence, so the owner state resolves to
  // `blocked_maintainer` instead of a fabricated owner CTA. Gated on
  // `collectionSucceededIsTrue` (`CollectionSucceeded` condition status
  // `true`) so a never-run connection — which has no collection to have
  // "succeeded with a gap" — stays a plain "Not measured" state with no
  // invented defect claim.
  if (disposition === "unmeasured" && latestCollectionSucceeded(snapshot) && !hasCredentialFailure(snapshot)) {
    actions.push({
      affects: unmeasuredRequiredStreamIds(streams),
      audience: "maintainer",
      cta: unmeasuredRequiredStreamsCta(snapshot),
      kind: "code_fix",
      satisfied_when: { kind: "none" },
      surface: { kind: "maintainer" },
      terminal: false,
      urgency: "soon",
    });
  }

  // Failed credential — owner is the sole resolution. Owner-satisfiable reauth.
  if (hasCredentialFailure(snapshot)) {
    const surface = credentialRepairSurface(snapshot);
    actions.push({
      affects: [],
      audience: "owner",
      cta: "Reconnect this account",
      kind: "reauth",
      // The satisfaction contract must match the repair mechanism. A
      // browser-session repair may have NO stored credential — the owner
      // re-establishes the live session — so it is satisfied by a confirming run
      // succeeding, not by a stored credential becoming present. Only a
      // stored-credential repair is satisfied by the credential itself.
      satisfied_when: reauthSatisfaction(surface),
      surface,
      terminal,
      urgency: "now",
    });
  }

  // Open structured attention (OTP / manual action / re-consent) — owner-satisfiable.
  if (hasOpenAttention(snapshot) && !hasCredentialFailure(snapshot)) {
    const target = exactSyncTargetFromAttention(attention);
    actions.push({
      affects: [],
      audience: "owner",
      cta: "Complete the requested action",
      kind: "add_info",
      surface: { kind: "provider_interaction" },
      terminal,
      urgency: "now",
      ...(target ? { target } : {}),
      satisfied_when: { kind: "attention_resolved" },
    });
  }

  // A stalled outbox means durable work is stuck outside the server. Coverage may
  // still be "complete" because the records already accepted are valid, but the
  // source cannot keep making progress until the owner checks the collector host.
  if (isStalledOutboxActionable(snapshot, disposition, actions) && hasTransientUploadFailure(snapshot)) {
    const remediation = stalledOutboxRemediation(snapshot);
    actions.push({
      affects: [],
      audience: "none",
      cta: "Retrying local uploads — no action needed",
      kind: "wait",
      remediation,
      satisfied_when: { kind: "none" },
      surface: { kind: "local_device" },
      terminal: false,
      urgency: "verifying",
    });
  }

  if (isStalledOutboxActionable(snapshot, disposition, actions) && !hasTransientUploadFailure(snapshot)) {
    const remediation = stalledOutboxRemediation(snapshot);
    actions.push({
      affects: [],
      audience: "owner",
      cta: remediation.label,
      kind: "add_info",
      remediation,
      satisfied_when: { kind: "attention_resolved" },
      surface: { kind: "local_device" },
      terminal: false,
      urgency: "now",
    });
  }

  // Owner-paused schedule (Wave 10a, owner review 2026-07-09). Emitted
  // BEFORE the refresh_now/retry_gap/wait branches below (which all assume
  // the system can still act on its own), so an otherwise
  // healthy/stale/resumable paused source gets "Resume schedule" as its
  // primary action rather than a one-off Retry/Refresh that leaves the
  // schedule disabled, or a calm "Collecting — no action needed" that is
  // false while the schedule is off. See `isOwnerPausedScheduleEligible`.
  if (isOwnerPausedScheduleEligible(scheduleEvidence, actions)) {
    actions.push({
      affects: [],
      audience: "owner",
      cta: "Resume schedule",
      kind: "reattach_schedule",
      satisfied_when: { kind: "schedule_attached_and_enabled" },
      // `{ kind: "schedule" }` (`OwnerActionSurfaceKind`, connection-health.ts)
      // — NOT `runtime_retry`, which means "run this once now." Resuming a
      // paused schedule is a distinct affordance from a one-off retry; a
      // generic client rendering by surface kind must route this to a
      // schedule-management control, not a run-now button.
      surface: { kind: "schedule" },
      terminal: false,
      urgency: "soon",
    });
  }

  // Manual/assisted-refresh stale: owner-refresh-due. See
  // `shouldOfferRefreshNowAction` for the full eligibility contract (paused
  // schedule, active run, and manual/assisted refresh policy).
  if (shouldOfferRefreshNowAction(snapshot, disposition, refresh, scheduleEvidence)) {
    actions.push({
      affects: [],
      audience: "owner",
      cta: "Refresh now",
      kind: "refresh_now",
      satisfied_when: { kind: "confirming_run_succeeded" },
      surface: { kind: "runtime_retry" },
      terminal: false,
      urgency: "soon",
    });
  }

  // Degraded or manual-refresh retryable gaps: the system can recover on a
  // future run, but the owner can explicitly ask for another attempt. Surface
  // that non-urgent accelerant instead of hiding degraded gaps as a calm wait.
  const retryGapAffects = resumableStreamIds(streams);
  if (
    disposition === "resumable" &&
    actions.length === 0 &&
    shouldOfferRetryGapAction(snapshot, refresh, scheduleEvidence, progress, streams, retryGapAffects)
  ) {
    const affects = retryGapAffects;
    actions.push({
      affects,
      audience: "owner",
      cta: "Retry now",
      kind: "retry_gap",
      satisfied_when: { kind: "gap_recovered" },
      surface: { kind: "runtime_retry" },
      terminal: false,
      urgency: "verifying",
    });
  }

  // A recoverable gap the system will fill on its own — the calm `wait` representation
  // of deferred drain / cooldown / syncing. Only emit when nothing owner-actionable
  // already covers the work, so a `wait` never competes with a real owner action.
  if (disposition === "resumable" && actions.length === 0) {
    actions.push({
      affects: resumableStreamIds(streams),
      audience: "none",
      cta: "Collecting — no action needed",
      kind: "wait",
      satisfied_when: { kind: "none" },
      surface: { kind: "none" },
      terminal: false,
      urgency: "verifying",
    });
  }

  actions.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);
  return actions;
}

function credentialRepairSurface(snapshot: ConnectionHealthSnapshot): OwnerActionSurface {
  const condition = snapshot.conditions.find(
    (item) => item.type === "CredentialsValid" && item.status === "false" && item.current
  );
  return condition?.remediation?.surface ?? { kind: "stored_credential" };
}

// The satisfaction contract for a `reauth` action, keyed to its repair surface.
// Only a `stored_credential` repair has an owner-supplied credential to check,
// so it alone is satisfied by that credential becoming present and unrejected.
// Every other reauth surface (browser_session today; any future non-stored-
// credential mechanism) has no stored credential to observe — the owner
// re-establishes access some other way — so it is proven by a confirming run
// succeeding instead.
function reauthSatisfaction(surface: OwnerActionSurface): SatisfactionContract {
  if (surface.kind === "stored_credential") {
    return { kind: "credential_present_and_unrejected" };
  }
  return { kind: "confirming_run_succeeded" };
}

/**
 * The streams a maintainer `code_fix` action actually speaks to. A stream whose
 * terminal shortfall is fully accounted for is excluded: naming it would tell
 * the maintainer to fix something already proven impossible and unbroken (a
 * 29MB attachment against a 25MB cap is not a defect), and would misreport the
 * blast radius of the streams that ARE stuck.
 */
function terminalStreamIds(streams: readonly StreamRollup[]): string[] {
  return streams
    .filter(
      (s) =>
        (s.coverage === "terminal_gap" || s.coverage === "unsupported" || s.coverage === "unavailable") &&
        !streamCoverageIsFullyAccounted(s)
    )
    .map((s) => s.stream_id);
}

/** Required streams resting at unresolved (`unknown`) coverage — the unmeasured-required set (design.md "Required-Stream Coverage Rollup"). */
function unmeasuredRequiredStreamIds(streams: readonly StreamRollup[]): string[] {
  return streams.filter((s) => s.priority === "required" && s.coverage === "unknown").map((s) => s.stream_id);
}

function resumableStreamIds(streams: readonly StreamRollup[]): string[] {
  return streams
    .filter((s) => s.coverage === "partial" || s.coverage === "gaps" || s.coverage === "retryable_gap")
    .map((s) => s.stream_id);
}

// ─── Channel (silence routing, after tone) ──────────────────────────────────

/**
 * Compute the channel AFTER tone in the same pass. Orthogonal to tone.
 *
 *   default `calm`
 *     → `advisory` for owner-actionable-but-non-urgent, owner-optional accelerants,
 *       or visible maintainer/status conditions (no dead owner button)
 *     → `attention` ONLY when an owner-audience, `satisfied_when.kind !== "none"`,
 *       owner-self-satisfiable action exists and the owner is the SOLE resolution.
 *
 * `runtime_ok === false` caps the channel at `calm` (invariant S4) — handled by the
 * caller after this returns.
 */
function computeChannel(actions: readonly RequiredAction[]): RenderedChannel {
  let channel: RenderedChannel = "calm";
  for (const action of actions) {
    // A `wait` (audience none) or maintainer-status action can never raise above
    // advisory and never to attention.
    if (action.audience === "none") {
      continue; // calm by construction
    }
    if (action.audience === "maintainer") {
      channel = raise(channel, "advisory");
      continue;
    }
    // audience === "owner"
    const ownerSatisfiable = action.satisfied_when.kind !== "none";
    if (!ownerSatisfiable) {
      channel = raise(channel, "advisory");
      continue;
    }
    // Non-urgent owner accelerant (refresh_now / backfill) → advisory.
    if (action.urgency === "soon" || action.urgency === "verifying") {
      channel = raise(channel, "advisory");
      continue;
    }
    // Urgent owner-sole-resolution (reauth / add_info, urgency now/overdue) → attention.
    channel = raise(channel, "attention");
  }
  return channel;
}

const CHANNEL_RANK: Record<RenderedChannel, number> = { advisory: 1, attention: 2, calm: 0 };

function raise(current: RenderedChannel, to: RenderedChannel): RenderedChannel {
  return CHANNEL_RANK[to] > CHANNEL_RANK[current] ? to : current;
}

// ─── Annotations ────────────────────────────────────────────────────────────

const CALM_ADVISORY_KINDS: ReadonlySet<AnnotationKind> = new Set<AnnotationKind>(["freshness", "schedule", "activity"]);

function buildAnnotations(
  snapshot: ConnectionHealthSnapshot,
  channel: RenderedChannel,
  tone: VerdictTone,
  refresh: ConnectionRefreshEvidence | null,
  scheduleEvidence: ScheduleEvidence | null,
  progress: ProgressEvidence | null,
  actions: readonly RequiredAction[]
): VerdictAnnotation[] {
  const annotations: VerdictAnnotation[] = [];

  // Co-required freshness annotation: ALWAYS present when freshness is not fresh
  // (honesty invariant 1). For fresh connections, include a quiet recency cue
  // when the caller supplied enough evidence. Text carries NO raw mechanistic counts.
  const freshnessText = freshnessAnnotationText(snapshot, tone, refresh, scheduleEvidence, progress, actions);
  if (freshnessText) {
    annotations.push({ kind: "freshness", text: freshnessText });
  }

  // On calm/advisory, strip any annotation kind outside freshness|schedule|activity
  // and cap calm at a single annotation (invariant S2 / spec scenario).
  if (channel === "calm" || channel === "advisory") {
    const filtered = annotations.filter((a) => CALM_ADVISORY_KINDS.has(a.kind));
    return channel === "calm" ? filtered.slice(0, 1) : filtered;
  }
  return annotations;
}

function freshnessAnnotationText(
  snapshot: ConnectionHealthSnapshot,
  tone: VerdictTone,
  refresh: ConnectionRefreshEvidence | null,
  scheduleEvidence: ScheduleEvidence | null,
  progress: ProgressEvidence | null,
  actions: readonly RequiredAction[]
): string | null {
  if (snapshot.axes.freshness === "fresh") {
    return freshRecencyText(tone, progress);
  }
  if (freshnessNotApplicable(snapshot)) {
    return "This is a one-time import. It finished and will not refresh.";
  }
  if (snapshot.axes.freshness === "unknown") {
    return unknownFreshnessText(progress);
  }
  const stuckSince = retryGapStuckSinceText(snapshot, actions);
  if (stuckSince) {
    return stuckSince;
  }
  // A run is actively advancing: stale-freshness copy that tells the owner
  // to run a refresh is contradicted by the run already in flight.
  if (snapshot.badges.syncing) {
    return "Refreshing now.";
  }
  return staleRefreshPolicyText(snapshot, refresh, scheduleEvidence, progress);
}

/**
 * Copy for `axes.freshness === "unknown"`. The generic "not been measured
 * yet" reading is honest for a connection that has genuinely never
 * collected anything, but a local-device connection can lose its freshness
 * anchor mid-stream — e.g. a stalled outbox blanks the heartbeat evidence
 * (honesty invariant: a stall must never read as `fresh`) even though the
 * device ingested real data before the stall began. When durable
 * last-ingest evidence is available for that case, name the last known
 * collection instead of implying zero collection history ever existed.
 */
function unknownFreshnessText(progress: ProgressEvidence | null): string {
  if (progress?.mode === "local_device") {
    const age = relativeDayAge(progress.last_refreshed_at ?? null, progress.observed_at ?? null);
    if (age) {
      return `Last known collection ${age}.`;
    }
  }
  return "Freshness has not been measured yet.";
}

/** Named per retry_gap action, e.g. "Messages stuck since Jul 3." */
function retryGapStuckSinceText(snapshot: ConnectionHealthSnapshot, actions: readonly RequiredAction[]): string | null {
  const retry = actions.find((action) => action.kind === "retry_gap");
  if (!retry) {
    return null;
  }
  const affected = retry.affects[0] ?? null;
  const since = shortMonthDay(snapshot.last_success_at);
  return affected && since ? `${humanizeStreamId(affected)} stuck since ${since}.` : null;
}

/**
 * Stale-freshness copy for a connection with no retry_gap and no active run,
 * keyed to the connection's refresh policy (manual / scheduled / assisted).
 */
function staleRefreshPolicyText(
  snapshot: ConnectionHealthSnapshot,
  refresh: ConnectionRefreshEvidence | null,
  scheduleEvidence: ScheduleEvidence | null,
  progress: ProgressEvidence | null
): string {
  // An enabled schedule is not an executable schedule while unresolved owner
  // attention suppresses automatic dispatch. Bind this copy to that cause,
  // rather than to the row's enabled bit: telling the owner to wait for the
  // schedule here would name a remedy the controller will not perform.
  if (snapshot.axes.attention !== "none") {
    return "Waiting on you before the next run can make progress.";
  }
  const refreshedAge = relativeDayAge(progress?.last_refreshed_at ?? null, progress?.observed_at ?? null);
  if (
    progress?.mode === "manual" ||
    (isManualRefreshOnly(refresh) && !hasEffectiveActiveScheduleEvidence(refresh, scheduleEvidence))
  ) {
    return refreshedAge ? `Last refreshed ${refreshedAge}.` : "Stale — this connector refreshes when you run it.";
  }
  if (hasEffectiveActiveScheduleEvidence(refresh, scheduleEvidence)) {
    return refreshedAge ? `Last refreshed ${refreshedAge}. Refreshes on schedule.` : "Stale — refreshes on schedule.";
  }
  if (isAssistedRefresh(refresh)) {
    return "Stale — refreshes on schedule; may ask for your help to catch up.";
  }
  return "Stale for this connection's freshness policy.";
}

function freshRecencyText(tone: VerdictTone, progress: ProgressEvidence | null): string | null {
  const age = relativeDayAge(progress?.last_refreshed_at ?? null, progress?.observed_at ?? null);
  const unhealthy = tone === "amber" || tone === "red";
  if (unhealthy && age) {
    return `Last successful refresh ${age}.`;
  }
  // Record recency says "today"/"yesterday", but the COVERAGE PROOF is a
  // separate anchor and can be materially older. Say so before claiming
  // freshness on the strength of the record anchor alone.
  const proofAge = staleCoverageProofAge(progress);
  if (age === "today") {
    return proofAge ? `Fresh today. Coverage last proven ${proofAge}.` : "Fresh today.";
  }
  if (age === "yesterday") {
    return proofAge ? `Fresh yesterday. Coverage last proven ${proofAge}.` : "Fresh yesterday.";
  }
  return null;
}

/**
 * The coverage proof's age, but ONLY when it is old enough that a reasonable
 * owner would want to know — otherwise `null` so a healthy row stays clean.
 *
 * Threshold: the proof is reported once it is neither today nor yesterday,
 * reusing {@link relativeDayAge}'s existing recency boundary rather than
 * introducing a new constant. That boundary is already this module's shipped
 * definition of "recent enough to state without a date" (it is exactly why
 * `Fresh today.` / `Fresh yesterday.` carry no date while anything older
 * renders `N days ago`). Applying the SAME rule to the proof anchor keeps one
 * notion of recency in the renderer.
 *
 * Fails closed: an absent, null, malformed, or future-stamped proof yields
 * `null`, never a fabricated or negative age — `relativeDayAge` already
 * rejects unparseable input and any `from > observed`.
 */
function staleCoverageProofAge(progress: ProgressEvidence | null): string | null {
  const provenAt = progress?.coverage_proven_at ?? null;
  if (!provenAt) {
    return null;
  }
  const proofAge = relativeDayAge(provenAt, progress?.observed_at ?? null);
  if (proofAge === null || proofAge === "today" || proofAge === "yesterday") {
    return null;
  }
  return proofAge;
}

function relativeDayAge(fromIso: string | null, observedIso: string | null): string | null {
  const from = utcDayStartMs(fromIso);
  const observed = utcDayStartMs(observedIso);
  if (from === null || observed === null || from > observed) {
    return null;
  }
  const days = Math.floor((observed - from) / DAY_MS);
  if (days === 0) {
    return "today";
  }
  if (days === 1) {
    return "yesterday";
  }
  return `${days} days ago`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function utcDayStartMs(iso: string | null): number | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function shortMonthDay(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const date = new Date(ms);
  return `${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function humanizeStreamId(streamId: string): string {
  const words = streamId.replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ─── Forward statement ──────────────────────────────────────────────────────

function terminalForwardStatement(
  primary: RequiredAction | null,
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  progress: ProgressEvidence | null
): string {
  if (primary?.kind === "reauth") {
    return "Reconnect this account before further collection.";
  }
  if (primary?.kind === "code_fix") {
    if (softensTerminalCoverageToDegraded(snapshot, disposition, progress)) {
      return "Latest collection completed with known coverage gaps.";
    }
    return "Some data from this source can't be collected.";
  }
  return "This data can't be recovered by a future run.";
}

/**
 * Forward statement for `checking`/`unmeasured` disposition. B10 (owner
 * ledger 2026-08-22): "not measured YET" implies a future run will resolve
 * it. A one-time import that will never run again (see
 * `freshnessNotApplicable`) has no future run to make that promise — the
 * same honest distinction `buildForwardStatement`'s `default` branch already
 * draws for the connection-level statement.
 *
 * A local-device connection whose collector build predates the
 * `coverage_diagnostics` evidence the server now requires (`SourceCoverageComplete`
 * condition, reason `coverage_unknown_stale_collector` —
 * `sourceCoverageCondition`, `connection-health.ts`) is a DIFFERENT claim from
 * "not measured yet": the generic copy implies the next scheduled run will
 * resolve it, but a stale collector binary will re-run and land in the exact
 * same unmeasured state forever. `design-notes/source-state-truth-2026-08-18.md`
 * named this exact gap — the specific, owner-actionable message the condition
 * already carries ("Update the local collector") was computed and then
 * discarded behind this generic sentence.
 */
function unmeasuredCoverageForwardStatement(snapshot: ConnectionHealthSnapshot): string {
  if (freshnessNotApplicable(snapshot)) {
    return "Coverage can't be measured — this one-time import ended before it finished a full pass, and it will not run again.";
  }
  const staleCollector = snapshot.conditions.find(
    (item) =>
      item.type === "SourceCoverageComplete" &&
      item.reason === CONNECTION_CONDITION_REASONS.COVERAGE_UNKNOWN_STALE_COLLECTOR
  );
  if (staleCollector) {
    return "This local collector build predates coverage evidence the server now requires. Update the collector.";
  }
  return "Coverage has not been measured yet.";
}

/**
 * Single sentence DERIVED from disposition + primary action. NEVER claims resumed
 * collection while the disposition is terminal (honesty invariant 3 / spec scenario).
 *
 * `streams` is read ONLY by the all-clear branch at the bottom, and only to stop
 * it claiming everything is normal when a stream has been permanently lost. The
 * connection-level disposition cannot see that fact on its own: an optional
 * terminal loss leaves the disposition `complete` (no run owes more data) while
 * the pill correctly reads "Missing optional data". Without this the two halves
 * contradicted — see inv 8.
 */
function buildForwardStatement(
  disposition: ForwardDisposition,
  actions: readonly RequiredAction[],
  snapshot: ConnectionHealthSnapshot,
  progress: ProgressEvidence | null,
  streams: readonly StreamRollup[] = []
): string {
  const primary = actions[0] ?? null;

  if (disposition === "terminal") {
    // A terminal disposition must never imply recovery.
    return terminalForwardStatement(primary, snapshot, disposition, progress);
  }

  if (primary && primary.audience === "owner") {
    switch (primary.kind) {
      case "reauth":
        return "Reconnect this account and collection resumes.";
      case "add_info":
        if (primary.remediation?.kind === "local_collector_recovery") {
          return primary.remediation.summary;
        }
        return "Complete the requested action and collection resumes.";
      case "refresh_now":
        return "Run a refresh to bring this up to date.";
      case "retry_gap":
        return "Retry now to give the recoverable gap another run.";
      case "backfill":
        return "Run a backfill to fill the missing window.";
      case "reattach_schedule":
        return "Resume the schedule to continue automatic collection.";
      default:
        return "Your action will bring this up to date.";
    }
  }
  if (primary?.kind === "wait" && primary.remediation?.cause === "transient_upload_failure") {
    return primary.remediation.summary;
  }

  switch (disposition) {
    case "checking":
    case "unmeasured":
      return unmeasuredCoverageForwardStatement(snapshot);
    case "resumable":
      return "The next run is expected to fill the remaining data.";
    case "owner_refresh_due":
      // An active run already answers "refresh"; do not ask for one while
      // it is in flight.
      return snapshot.badges.syncing ? "Refreshing now." : "Up to date once you refresh.";
    case "awaiting_owner":
      return "Waiting on you before the next run can make progress.";
    default:
      return noActionOwedForwardStatement(snapshot, streams);
  }
}

/**
 * What to say when the disposition owes no further run and no owner action is
 * outstanding — the `complete` case, plus any disposition that falls through.
 *
 * "No run owes more data" is NOT the same claim as "everything is fine", and
 * conflating the two is what produced the live 2026-08-25 contradiction. Each
 * guard below names a fact the `complete` disposition is blind to, in
 * descending order of how much it should dominate the sentence. Only when all
 * of them are clear is the unconditional all-clear honest.
 */
function noActionOwedForwardStatement(snapshot: ConnectionHealthSnapshot, streams: readonly StreamRollup[]): string {
  if (snapshot.axes.outbox === "active") {
    return "The local collector is uploading saved records.";
  }
  if (freshnessNotApplicable(snapshot)) {
    return "This one-time import finished. There is nothing left to run.";
  }
  if (snapshot.axes.freshness === "unknown") {
    return "Freshness has not been measured yet.";
  }
  // A `complete` disposition does not mean the data is current. A schedulable
  // connector that has aged past its staleness window keeps `complete` (the
  // disposition's Rule 4 fires only for manual/assisted refresh) while
  // `axes.freshness` reads `stale`, so without this guard the branch claimed
  // "Current" of a source that demonstrably was not — the sentence half of the
  // Jellyfin/Notion/Steam contradiction. The schedule is expected to catch it
  // up on its own, so this states the fact without asking the owner for an
  // action they do not owe.
  if (snapshot.axes.freshness === "stale") {
    return snapshot.badges.syncing
      ? "Refreshing now."
      : "Not current — the next scheduled run is expected to catch it up.";
  }
  // Nor does `complete` mean the last RUN went well. A failed run leaves
  // coverage complete (earlier runs still proved it) and the disposition
  // `complete` (no run owes more data), while the headline state is `degraded`
  // and the pill correctly reads "Missing data". Found by the combination
  // sweep in `verdict-pill-statement-agreement.test.ts`, not in production.
  //
  // Gated on the FAILED-RUN condition rather than on `state === "degraded"`
  // alone: `degraded` has several causes, and a bare state check would silently
  // absorb all of them — making this one sentence the catch-all answer for
  // troubles it does not describe, and hiding any future cause from the very
  // sweep that is supposed to find it.
  if (snapshot.state === "degraded" && hasFailedCollectionCondition(snapshot)) {
    return "The last run did not finish cleanly. The next run will try again.";
  }
  // A permanently-lost optional stream leaves the connection-level disposition
  // `complete` — correctly, since no future run owes that data — while the pill
  // reads "Missing optional data". Saying "collecting normally" underneath
  // would deny the loss the pill just named.
  if (streams.some((stream) => isOptionalTerminalLoss(stream))) {
    return "Collecting normally, apart from optional data this source can no longer provide.";
  }
  return "Current and collecting normally.";
}

// ─── Progress ───────────────────────────────────────────────────────────────

/** NEVER surface a structurally-zero records_emitted; privilege drained + retained. */
function deferredHeadline(gapsDrained: number | null, retained: number | null): string {
  if (gapsDrained !== null && gapsDrained > 0) {
    return "Caught up in the background.";
  }
  if (retained !== null) {
    return "Collecting in the background.";
  }
  return "Collecting in the background.";
}

function manualHeadline(retained: number | null, refreshedAt: string | null): string {
  if (retained === null) {
    return "Refresh to update.";
  }
  return `Holding ${retained.toLocaleString()} records${refreshedAt ? "; refresh to update." : "."}`;
}

function terminalProgressHeadline(retained: number | null, actions: readonly RequiredAction[]): string {
  const held =
    retained === null ? "Retained-record count is unavailable" : `Holding ${retained.toLocaleString()} records`;
  if (actions.some((action) => action.kind === "reauth")) {
    return `${held}; reconnect this account before further collection.`;
  }
  if (actions.some((action) => action.kind === "code_fix")) {
    // Which of the two `terminalCoverageCta` branches produced this action.
    // 428898c92 flagged this string-equality coupling as pre-existing and
    // fragile and left it as found; it now compares against that function's
    // own constant instead of a third copy of the sentence, so the two cannot
    // silently disagree when the copy changes.
    if (actions.some((action) => action.kind === "code_fix" && action.cta === SOFTENED_COVERAGE_CTA)) {
      return `${held}; source coverage has known gaps.`;
    }
    return `${held}; some of this source's data can't be collected.`;
  }
  return `${held}; this source cannot collect more until the terminal issue is fixed.`;
}

// Idle scheduled eligibility is not active work: only claim "Collecting"
// while a run is actually in flight (badges.syncing). Otherwise use the same
// neutral eligibility phrase already used for manual-default schedules
// (staleRefreshPolicyText).
function scheduledProgressHeadline(committed: number | null, syncing: boolean): string {
  if (committed !== null) {
    return `Committed ${committed.toLocaleString()} records last run.`;
  }
  return syncing ? "Collecting on schedule." : "Refreshes on schedule.";
}

function progressHeadline(
  mode: ProgressMode,
  gapsDrained: number | null,
  committed: number | null,
  retained: number | null,
  refreshedAt: string | null,
  disposition: ForwardDisposition,
  actions: readonly RequiredAction[],
  syncing: boolean
): string {
  if (disposition === "terminal") {
    return terminalProgressHeadline(retained, actions);
  }
  if (actions.some((action) => action.kind === "retry_gap" && action.audience === "owner")) {
    return retained === null
      ? "Retry to continue collection."
      : `Holding ${retained.toLocaleString()} records; retry to continue.`;
  }
  switch (mode) {
    case "deferred":
      return deferredHeadline(gapsDrained, retained);
    case "scheduled":
      return scheduledProgressHeadline(committed, syncing);
    case "manual":
      return manualHeadline(retained, refreshedAt);
    case "local_device":
      return retained === null
        ? "Collecting from your device."
        : `Holding ${retained.toLocaleString()} records from your device.`;
    default: {
      const _never: never = mode;
      return _never;
    }
  }
}

function buildProgress(
  evidence: ProgressEvidence | null,
  disposition: ForwardDisposition,
  actions: readonly RequiredAction[],
  syncing: boolean
): RenderedProgress {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const mode: ProgressMode = evidence?.mode ?? "scheduled";
  const gapsDrained = evidence?.gaps_drained_last_run ?? null;
  const committed = evidence?.records_committed_last_run ?? null;
  const retained = evidence?.retained_records ?? null;
  const refreshedAt = evidence?.last_refreshed_at ?? null;

  return {
    gaps_drained_last_run: null,
    headline: progressHeadline(mode, gapsDrained, committed, retained, refreshedAt, disposition, actions, syncing),
    last_refreshed_at: refreshedAt,
    mode,
    records_committed_last_run: mode === "scheduled" ? committed : null,
    retained_records: retained,
  };
}

// ─── Stream rows ────────────────────────────────────────────────────────────

function buildStreamRows(
  streams: readonly StreamRollup[],
  snapshot: ConnectionHealthSnapshot,
  refresh: ConnectionRefreshEvidence | null,
  scheduleEvidence: ScheduleEvidence | null,
  actions: readonly RequiredAction[]
): VerdictStreamRow[] {
  return streams.map((stream) => {
    const disposition = streamDisposition(stream, snapshot, refresh, scheduleEvidence);
    // Clamp collected to considered (honesty invariant 2): no "3/2 collected".
    const collected =
      stream.collected !== null && stream.considered !== null
        ? Math.min(stream.collected, stream.considered)
        : stream.collected;
    return {
      action_ref: actionRefFor(stream, disposition, actions),
      collected,
      considered: stream.considered,
      coverage: stream.coverage,
      disposition,
      statement: streamStatement(disposition, snapshot.badges.syncing, freshnessNotApplicable(snapshot)),
      stream_id: stream.stream_id,
    };
  });
}

function actionRefFor(
  stream: StreamRollup,
  disposition: ForwardDisposition,
  actions: readonly RequiredAction[]
): number | null {
  // Prefer an action that explicitly names this stream.
  const named = actions.findIndex((a) => a.affects.includes(stream.stream_id));
  if (named >= 0) {
    return named;
  }
  // Otherwise, connection-level owner action covers a non-complete stream.
  if (disposition !== "complete") {
    const ownerLevel = actions.findIndex((a) => a.affects.length === 0 && a.audience === "owner");
    if (ownerLevel >= 0) {
      return ownerLevel;
    }
  }
  return null;
}

function streamStatement(
  disposition: ForwardDisposition,
  activeRunSyncing = false,
  oneTimeImportFinished = false
): string {
  switch (disposition) {
    case "complete":
      return "Complete.";
    case "checking":
    case "unmeasured":
      // B10: mirrors `buildForwardStatement`'s same distinction — a one-time
      // import that will never run again cannot resolve "yet".
      return oneTimeImportFinished
        ? "Can't be measured — this one-time import ended before a full pass finished."
        : "Coverage has not been measured yet.";
    case "resumable":
      return "The next run is expected to fill the rest.";
    case "owner_refresh_due":
      // An advancing run already answers the same nudge this stream would
      // otherwise ask the owner to trigger (mirrors labelForPill's amber
      // Syncing dominance) — never ask the owner to refresh what is already
      // in flight.
      return activeRunSyncing ? "Refreshing now." : "Up to date once you refresh.";
    case "awaiting_owner":
      return "Waiting on you.";
    case "terminal":
      // NEVER claim a retry/refresh recovers a terminal stream.
      return "Can't be collected by a future run.";
    default: {
      const _never: never = disposition;
      return _never;
    }
  }
}

// ─── Detail + suppressed routing ────────────────────────────────────────────

function buildSuppressed(
  snapshot: ConnectionHealthSnapshot,
  channel: RenderedChannel,
  runtimeOk: boolean
): SuppressedSignal[] {
  const suppressed: SuppressedSignal[] = [];

  // A drained/draining detail-gap backlog is self-handled; its counts are routed to
  // detail and never to the dashboard (the 2,532-gaps acid test).
  if (snapshot.detail_gap_backlog) {
    suppressed.push({
      detail_field: "detail_gap_backlog",
      kind: "drain",
      reason: "detail-gap backlog is system-handled; counts kept off the attention layer",
    });
  }

  // Cooling-off / next-attempt floor is a self-handled wait.
  if (snapshot.state === "cooling_off" || snapshot.next_attempt_at) {
    suppressed.push({
      detail_field: "next_attempt_at",
      kind: "cooldown",
      reason: "next-attempt floor is system-managed",
    });
  }

  // An in-flight run is self-handled syncing.
  if (snapshot.badges.syncing) {
    suppressed.push({
      detail_field: "state",
      kind: "syncing",
      reason: "a run is in flight; syncing is self-handled",
    });
  }

  // A runtime fault that capped this connection's channel is routed to a single global
  // indicator, never to a per-connection attention pull.
  if (!runtimeOk && channel === "calm") {
    suppressed.push({
      detail_field: "state",
      kind: "runtime_fault",
      reason: "runtime is the fault; per-connection attention capped to calm",
    });
  }

  return suppressed;
}

function buildDetail(
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  suppressed: readonly SuppressedSignal[],
  acknowledgedLoss: AcknowledgedLossRecord | null = null
): VerdictDetail {
  return {
    acknowledged_loss: acknowledgedLoss,
    collection_rate: snapshot.collection_rate,
    conditions: snapshot.conditions,
    coverage_horizons: snapshot.coverage_horizons,
    detail_gap_backlog: snapshot.detail_gap_backlog,
    dominant_condition_id: snapshot.dominant_condition_id,
    // The synthesizer's oracle-derived connection disposition (worst-wins over the
    // supplied per-stream rollups through `deriveForwardDisposition`, or the
    // snapshot's own oracle-derived value when no rollups are supplied). Using this —
    // not the raw snapshot field — keeps the WHOLE verdict internally consistent:
    // actions' terminality, the forward statement, and the invariant gate all read
    // the same single disposition.
    forward_disposition: disposition,
    next_attempt_at: snapshot.next_attempt_at,
    reason_code: snapshot.reason_code,
    state: snapshot.state,
    suppressed,
  };
}

// ─── Invariant gate ─────────────────────────────────────────────────────────

/**
 * Whether to throw on an invariant violation (dev) or fall back to a safe grey verdict
 * (prod). Throwing in tests/dev surfaces design gaps loudly; prod must never crash a
 * dashboard render over a verdict bug.
 */
function shouldThrowOnViolation(): boolean {
  const env = typeof process === "undefined" ? undefined : process.env?.NODE_ENV;
  return env !== "production";
}

export class VerdictInvariantError extends Error {
  constructor(message: string) {
    super(`RenderedVerdict invariant violation: ${message}`);
    this.name = "VerdictInvariantError";
  }
}

/** A claim of resumed collection — forbidden on a terminal disposition (inv 3 / inv 7). */
const RESUME_CLAIM_RE = /resum|refresh|next run|retry/i;
/** A digit, paired with a mechanistic noun, is a forbidden count on calm/advisory (inv S2). */
const DIGIT_RE = /\d/;
const MECHANISTIC_NOUN_RE = /(gap|retr|backlog|record)/i;

function isViolation(violation: string | null): violation is string {
  return violation !== null;
}

function missingFreshnessAnnotationViolation(
  verdict: RenderedVerdict,
  snapshot: ConnectionHealthSnapshot
): string | null {
  if (snapshot.axes.freshness !== "fresh" && !verdict.annotations.some((a) => a.kind === "freshness")) {
    return "off-fresh verdict is missing its co-required freshness annotation (inv 1)";
  }
  return null;
}

function streamCollectionCountViolation(row: VerdictStreamRow): string | null {
  if (row.collected !== null && row.considered !== null && row.collected > row.considered) {
    return `stream ${row.stream_id} collected > considered (inv 2)`;
  }
  return null;
}

function terminalForwardStatementResumeViolation(verdict: RenderedVerdict): string | null {
  if (verdict.detail.forward_disposition === "terminal" && RESUME_CLAIM_RE.test(verdict.forward_statement)) {
    return "forward_statement claims recovery on a terminal disposition (inv 3)";
  }
  return null;
}

function terminalProgressHeadlineResumeViolation(verdict: RenderedVerdict): string | null {
  if (verdict.detail.forward_disposition === "terminal" && RESUME_CLAIM_RE.test(verdict.progress.headline)) {
    return "progress.headline claims recovery on a terminal disposition (inv 3)";
  }
  return null;
}

function connectionActionTerminalViolation(action: RequiredAction, dispositionTerminal: boolean): string | null {
  if (action.affects.length === 0 && action.terminal !== dispositionTerminal) {
    return `action ${action.kind} terminal disagrees with disposition oracle (inv 4)`;
  }
  return null;
}

function toneBelowBaseStateViolation(verdict: RenderedVerdict, snapshot: ConnectionHealthSnapshot): string | null {
  if (TONE_RANK[verdict.pill.tone] < TONE_RANK[baseStateTone(snapshot.state, snapshot.last_success_at)]) {
    return "pill.tone is below the base state tone — not worst-wins (inv 5)";
  }
  return null;
}

function toneLabelViolation(
  verdict: RenderedVerdict,
  snapshot: ConnectionHealthSnapshot,
  streams: readonly StreamRollup[]
): string | null {
  if (
    verdict.pill.label !==
    labelForPill(verdict.pill.tone, snapshot, verdict.detail.forward_disposition, verdict.trace.tone_inputs, streams)
  ) {
    return "pill.label does not match tone plus active-work evidence (inv 6)";
  }
  return null;
}

/**
 * A forward statement asserting the source is CURRENT and untroubled. This is
 * the class of sentence that must never appear under a pill claiming trouble.
 */
const ALL_CLEAR_STATEMENT_RE = /^Current and collecting normally\.$/;

/**
 * Labels that assert something is WRONG with collection — as opposed to
 * "Needs refresh" (working, not current) or the terminal//neutral labels.
 * These are exactly the labels the module doc reserves for "real collection
 * trouble".
 */
const TROUBLE_LABELS: ReadonlySet<VerdictLabel> = new Set<VerdictLabel>([
  "Can't collect",
  "Missing data",
  "Missing optional data",
  "Some records stuck",
]);

/**
 * (inv 8) The pill and the forward statement are rendered from ONE verdict
 * object and read together, top to bottom, by the owner. They must not make
 * opposite claims.
 *
 * This gate exists because they are derived from DIFFERENT evidence and can
 * therefore drift apart silently: the pill comes from `labelForPill` (headline
 * state + per-axis tones + stream rollups) while the statement comes from
 * `buildForwardStatement` (forward disposition + primary action). Those two
 * inputs disagreed in production on 2026-08-25 — Jellyfin, Notion and Steam
 * each rendered an amber "Missing data" pill directly above "Current and
 * collecting normally." The individual producers were each self-consistent;
 * nothing compared them, so nothing caught it.
 *
 * `staleFreshnessIsSoleDegradation` and the stale branch of
 * `buildForwardStatement` fix that specific pair at the derivation. This
 * invariant is the general guard: any FUTURE pairing of a trouble label with
 * an all-clear sentence fails here rather than reaching an owner.
 */
function pillStatementContradictionViolation(verdict: RenderedVerdict): string | null {
  if (TROUBLE_LABELS.has(verdict.pill.label) && ALL_CLEAR_STATEMENT_RE.test(verdict.forward_statement)) {
    return `pill "${verdict.pill.label}" contradicts forward_statement "${verdict.forward_statement}" (inv 8)`;
  }
  return null;
}

const TRAILING_TERMINATOR_RE = /[.!]+$/;

/**
 * Reduce owner-facing copy to its claim, so two sentences that differ only in
 * punctuation or casing compare equal. Trailing periods and case are exactly
 * the difference between the CTA and the statement in the live defect below.
 */
function copyClaim(text: string): string {
  return text.trim().toLowerCase().replace(TRAILING_TERMINATOR_RE, "");
}

/**
 * (inv 9) An action's `cta` and the `forward_statement` beside it are rendered
 * TOGETHER, from one verdict object, in one row: `source-actionability.ts`
 * builds each source row's `what` from `verdict.forward_statement` and its
 * `actionLabel` from `required_actions[0].cta`. The `cta` slot is the row's
 * answer to "so what now?" — whether it renders as a button (owner-satisfiable)
 * or as inert status text (maintainer). A `cta` that merely repeats the
 * sentence next to it spends that slot saying nothing.
 *
 * THE LIVE DEFECT (2026-08-25). `HEB - gezalsatx@yahoo.com` rendered:
 *
 *     pill:              "Can't collect"
 *     forward_statement: "Some data from this source can't be collected."
 *     action cta:        "Some data from this source can't be collected"
 *
 * `terminalCoverageCta` and `terminalForwardStatement` are two functions that
 * independently chose the same sentence for the hard terminal branch. Each was
 * self-consistent; nothing compared them, so the duplication shipped — the
 * same structural failure as inv 8, one field over.
 *
 * This is a duplication gate, NOT a "must offer an owner action" gate. A
 * maintainer `code_fix` is legitimately not an owner task, and the honest
 * answer for it is a short condition label rather than an invented button.
 * What it may not be is the sentence below it, again.
 */
function ctaRestatesForwardStatementViolation(verdict: RenderedVerdict): string | null {
  const statement = copyClaim(verdict.forward_statement);
  const duplicate = verdict.required_actions.find((action) => copyClaim(action.cta) === statement);
  if (duplicate) {
    return `action ${duplicate.kind} cta restates forward_statement "${verdict.forward_statement}" (inv 9)`;
  }
  return null;
}

/**
 * (inv 8) The converse: a green/healthy pill must not sit above a sentence
 * that says the source is NOT current. Same object, same reading order, same
 * failure mode in the other direction.
 */
function healthyPillStaleStatementViolation(
  verdict: RenderedVerdict,
  snapshot: ConnectionHealthSnapshot
): string | null {
  if (verdict.pill.tone === "green" && snapshot.axes.freshness === "stale" && verdict.pill.label === "Healthy") {
    return 'pill "Healthy" contradicts stale freshness evidence (inv 8)';
  }
  return null;
}

function terminalStreamResumeStatementViolation(row: VerdictStreamRow): string | null {
  if (row.disposition === "terminal" && RESUME_CLAIM_RE.test(row.statement)) {
    return `stream ${row.stream_id} pairs terminal disposition with a resume statement (inv 7)`;
  }
  return null;
}

/** Honesty invariants 1–7 over the whole verdict. */
function honestyViolations(
  verdict: RenderedVerdict,
  snapshot: ConnectionHealthSnapshot,
  streams: readonly StreamRollup[]
): string[] {
  const dispositionTerminal = verdict.detail.forward_disposition === "terminal";
  return [
    missingFreshnessAnnotationViolation(verdict, snapshot),
    ...verdict.streams.map(streamCollectionCountViolation),
    terminalForwardStatementResumeViolation(verdict),
    terminalProgressHeadlineResumeViolation(verdict),
    ...verdict.required_actions.map((action) => connectionActionTerminalViolation(action, dispositionTerminal)),
    toneBelowBaseStateViolation(verdict, snapshot),
    toneLabelViolation(verdict, snapshot, streams),
    ...verdict.streams.map(terminalStreamResumeStatementViolation),
    pillStatementContradictionViolation(verdict),
    healthyPillStaleStatementViolation(verdict, snapshot),
    ctaRestatesForwardStatementViolation(verdict),
  ].filter(isViolation);
}

/** Checks one calm/advisory annotation for disallowed kind or mechanistic count (inv S2). */
function calmAdvisoryAnnotationViolations(annotation: VerdictAnnotation): string[] {
  const violations: string[] = [];
  if (!CALM_ADVISORY_KINDS.has(annotation.kind)) {
    violations.push(`calm/advisory annotation has disallowed kind ${annotation.kind} (inv S2)`);
  }
  if (DIGIT_RE.test(annotation.text) && MECHANISTIC_NOUN_RE.test(annotation.text)) {
    violations.push("calm/advisory annotation carries a mechanistic count (inv S2)");
  }
  return violations;
}

/** Silence invariants S1–S4 over the whole verdict. */
function silenceViolations(verdict: RenderedVerdict, runtimeOk: boolean): string[] {
  const violations: string[] = [];

  // (S1) channel === "attention" ⇒ an owner-audience, satisfied_when.kind !== "none" action.
  if (verdict.channel === "attention") {
    const hasOwnerSatisfiable = verdict.required_actions.some(
      (a) => a.audience === "owner" && a.satisfied_when.kind !== "none"
    );
    if (!hasOwnerSatisfiable) {
      violations.push("channel is attention but no owner-self-satisfiable action exists (inv S1)");
    }
  }

  // (S2) no mechanistic counts on calm/advisory annotations; calm carries ≤ 1.
  if (verdict.channel === "calm" || verdict.channel === "advisory") {
    for (const annotation of verdict.annotations) {
      violations.push(...calmAdvisoryAnnotationViolations(annotation));
    }
    if (verdict.channel === "calm" && verdict.annotations.length > 1) {
      violations.push("calm verdict carries more than one annotation (inv S2)");
    }
  }

  // (S3) every suppressed signal must name a detail destination.
  for (const signal of verdict.detail.suppressed) {
    if (!signal.detail_field) {
      violations.push("suppressed signal does not name its detail destination (inv S3)");
    }
  }

  // (S4) runtime_ok === false caps every channel at calm.
  if (!runtimeOk && verdict.channel !== "calm") {
    violations.push("runtime_ok is false but channel exceeds calm (inv S4)");
  }

  return violations;
}

/**
 * The twelve invariants (honesty 1–8, silence S1–S4) enforced on the WHOLE verdict —
 * one gate, not N scattered formatter checks.
 */
function assertInvariants(
  verdict: RenderedVerdict,
  snapshot: ConnectionHealthSnapshot,
  runtimeOk: boolean,
  streams: readonly StreamRollup[]
): string[] {
  return [...honestyViolations(verdict, snapshot, streams), ...silenceViolations(verdict, runtimeOk)];
}

/** A minimal, honest grey verdict used as the prod fallback on an invariant failure. */
function safeGreyVerdict(
  snapshot: ConnectionHealthSnapshot,
  acknowledgedLoss: AcknowledgedLossRecord | null = null
): RenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: buildDetail(snapshot, "complete", [], acknowledgedLoss),
    forward_statement: "Status could not be classified.",
    pill: { label: "Not measured", tone: "grey" },
    progress: buildProgress(null, "checking", [], snapshot.badges.syncing),
    required_actions: [],
    streams: [],
    trace: {
      channel_cause: "invariant_fallback",
      detail_destinations: [],
      primary_action_kind: null,
      runtime_capped: false,
      satisfied_when: null,
      suppressed_evidence: [],
      tone_cause: "grey",
      tone_inputs: [],
    },
  };
}

// ─── The synthesizer ────────────────────────────────────────────────────────

/**
 * Synthesize the one server-owned verdict. PURE: no I/O, no clock read; identical
 * inputs always produce an identical verdict.
 *
 * @param snapshot        the existing connection-health projection output
 * @param streams         per-stream rollups (synthesizer input; wire-forwarding is Dispatch C)
 * @param refresh         the manifest refresh evidence (`buildRefreshEvidence(...)` output)
 * @param runtime_ok      whether the runtime serving the connections is itself healthy
 * @param progress        optional collection-model progress evidence
 * @param scheduleEvidence optional instance-schedule evidence for `reattach_schedule`
 *                        (Wave 10a) — omitted callers get byte-identical prior behavior
 */
export function synthesizeRenderedVerdict(
  snapshot: ConnectionHealthSnapshot,
  streams: readonly StreamRollup[],
  refresh: ConnectionRefreshEvidence | null,
  runtime_ok: boolean,
  progress: ProgressEvidence | null = null,
  scheduleEvidence: ScheduleEvidence | null = null,
  attention: ConnectionAttentionEvidence | null = null,
  /**
   * A durable, owner-stamped acknowledgement that some data is permanently
   * gone for an external reason. Read verbatim, never inferred: `null` (the
   * default) preserves byte-identical prior behavior for every caller and
   * every connection that has no stamped record.
   */
  acknowledgedLoss: AcknowledgedLossRecord | null = null
): RenderedVerdict {
  // ── tone: worst-wins over base(state) + every axis ──
  const disposition = connectionDisposition(snapshot, streams, refresh, scheduleEvidence);
  const coverageHealthTone = terminalAwareTone(worstStreamCoverageTone(streams), snapshot, disposition, progress);
  const dispositionHealthTone = terminalAwareTone(dispositionTone(disposition), snapshot, disposition, progress);
  const toneInputs: { axis: string; tone: VerdictTone }[] = [
    { axis: "state", tone: baseStateTone(snapshot.state, snapshot.last_success_at) },
    { axis: "freshness", tone: freshnessHealthTone(snapshot) },
    { axis: "coverage", tone: coverageHealthTone },
    { axis: "disposition", tone: dispositionHealthTone },
    { axis: "attention", tone: attentionTone(snapshot) },
    { axis: "outbox", tone: outboxTone(snapshot) },
  ];
  // An acknowledged permanent loss softens a red COVERAGE verdict to amber, the
  // same way `softensTerminalCoverageToDegraded` already softens a terminal gap
  // under a succeeded run. The reasoning is identical: red means "unexamined
  // breakage demanding escalation", and an owner-acknowledged external cause is
  // examined and settled. It stays amber — never green — because the data is
  // genuinely missing.
  //
  // The softening applies ONLY when coverage/disposition is what made it red. A
  // red arriving from any other axis (a rejected credential, a stalled outbox)
  // is a separate, still-fixable defect that an acknowledgement must not mask,
  // so it survives unchanged.
  const synthesizedTone = toneInputs.reduce<VerdictTone>((acc, input) => worse(acc, input.tone), "green");
  // Softening can never sink below the base state tone (honesty invariant 5,
  // `toneBelowBaseStateViolation`): a `blocked`/`broken` headline state outranks
  // any acknowledgement, so `worse()` re-floors the result.
  const tone =
    acknowledgedLoss && synthesizedTone === "red" && redIsOnlyFromCoverage(toneInputs)
      ? worse(acknowledgedLossTone(), baseStateTone(snapshot.state, snapshot.last_success_at))
      : synthesizedTone;
  const pill: VerdictPill = { label: labelForPill(tone, snapshot, disposition, toneInputs, streams), tone };

  // ── required actions (terminality derived from the sole oracle) ──
  const synthesizedActions = buildRequiredActions(
    snapshot,
    streams,
    refresh,
    disposition,
    progress,
    scheduleEvidence,
    attention
  );
  // The owner has already accepted this cause and no run can undo it, so every
  // action whose whole promise is "do this and the data comes back" is
  // withdrawn. Actions that remain meaningful — reconnecting a broken
  // credential, for instance — are untouched: an acknowledged purge does not
  // excuse a separate, still-fixable defect.
  const actions = acknowledgedLoss
    ? synthesizedActions.filter((action) => !RECOVERY_PROMISING_ACTION_KINDS.has(action.kind))
    : synthesizedActions;

  // ── channel: computed AFTER tone in the same pass; runtime fault caps at calm ──
  let channel = computeChannel(actions);
  const runtimeCapped = !runtime_ok && channel !== "calm";
  if (!runtime_ok) {
    channel = "calm"; // invariant S4: cap every per-connection channel at calm
  }

  // ── annotations, statement, streams, progress ──
  const annotations = buildAnnotations(snapshot, channel, tone, refresh, scheduleEvidence, progress, actions);
  // The stamped record is the most specific true thing known about this
  // connection's missing data, so it OUTRANKS every derived sentence. This is
  // the whole point of stamping it: the writer stated the truth, so the
  // renderer does not fall back to a generic guess.
  const forwardStatement = acknowledgedLoss
    ? acknowledgedLossStatement(acknowledgedLoss)
    : buildForwardStatement(disposition, actions, snapshot, progress, streams);
  const streamRows = buildStreamRows(streams, snapshot, refresh, scheduleEvidence, actions);
  const synthesizedProgress = buildProgress(progress, disposition, actions, snapshot.badges.syncing);
  const renderedProgress = acknowledgedLoss
    ? {
        ...synthesizedProgress,
        headline: acknowledgedLossProgressHeadline(acknowledgedLoss, synthesizedProgress.retained_records),
      }
    : synthesizedProgress;

  // ── inspection layer: suppressed signals routed to detail, never deleted ──
  const suppressed = buildSuppressed(snapshot, channel, runtime_ok);
  const detail = buildDetail(snapshot, disposition, suppressed, acknowledgedLoss);

  const primary = actions[0] ?? null;
  const trace: CalibrationTrace = {
    channel_cause: channelCause(channel, runtimeCapped, primary),
    detail_destinations: suppressed.map((s) => s.detail_field),
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    primary_action_kind: primary?.kind ?? null,
    runtime_capped: runtimeCapped,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    satisfied_when: primary?.satisfied_when ?? null,
    suppressed_evidence: suppressed,
    tone_cause: tone,
    tone_inputs: toneInputs,
  };

  const verdict: RenderedVerdict = {
    annotations,
    channel,
    detail,
    forward_statement: forwardStatement,
    pill,
    progress: renderedProgress,
    required_actions: actions,
    streams: streamRows,
    trace,
  };

  const violations = assertInvariants(verdict, snapshot, runtime_ok, streams);
  if (violations.length > 0) {
    if (shouldThrowOnViolation()) {
      throw new VerdictInvariantError(violations.join("; "));
    }
    return safeGreyVerdict(snapshot, acknowledgedLoss);
  }
  return verdict;
}

function channelCause(channel: RenderedChannel, runtimeCapped: boolean, primary: RequiredAction | null): string {
  if (runtimeCapped) {
    return "runtime_fault_capped_to_calm";
  }
  if (channel === "attention") {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    return `owner_sole_resolution:${primary?.kind ?? "unknown"}`;
  }
  if (channel === "advisory") {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    return `owner_optional_or_status:${primary?.kind ?? "unknown"}`;
  }
  return "self_handled_calm";
}

/**
 * An owner-audience `RequiredAction`. `audience` is narrowed to the literal `"owner"`
 * so a `maintainer` or `none` action is not assignable to a grant-scoped verdict — the
 * audience filter below is what produces this type, and the compiler holds the line.
 */
export type OwnerScopedRequiredAction = RequiredAction & { readonly audience: "owner" };

/**
 * Project the owner-only material OFF a verdict for a grant-scoped client:
 *
 * - the inspection-layer `detail` and calibration `trace` (gap backlog, raw
 *   disposition, conditions, next-attempt floor, collection rate);
 * - every non-owner-audience entry of `required_actions`. A `maintainer` action's
 *   `cta` is implementer-facing copy about a connector defect (`kind: "code_fix"`,
 *   `surface: { kind: "maintainer" }`), and an `audience: "none"` action is an
 *   internal wait marker. Neither is owner-facing material, so neither may reach a
 *   third-party app holding a scoped grant.
 *
 * `streams[].action_ref` is a POSITIONAL index into `required_actions[]`, so dropping
 * entries must renumber the survivors. A stream whose action was dropped gets
 * `action_ref: null` — it keeps its own `statement`/`coverage`, it just no longer
 * points at maintainer material.
 *
 * Dispatch C wires this at the wire seam; exported here so the grant-scope regression
 * can pin the contract at the type level.
 */
export type GrantScopedVerdict = Omit<RenderedVerdict, "detail" | "required_actions" | "trace"> & {
  readonly required_actions: readonly OwnerScopedRequiredAction[];
};

function isOwnerScopedAction(action: RequiredAction): action is OwnerScopedRequiredAction {
  return action.audience === "owner";
}

export function toGrantScopedVerdict(verdict: RenderedVerdict): GrantScopedVerdict {
  const { detail: _detail, trace: _trace, ...rest } = verdict;

  const scopedActions: OwnerScopedRequiredAction[] = [];
  // Old index -> new index for the surviving owner actions; absent = dropped.
  const remapped = new Map<number, number>();
  for (const [index, action] of rest.required_actions.entries()) {
    if (isOwnerScopedAction(action)) {
      remapped.set(index, scopedActions.length);
      scopedActions.push(action);
    }
  }

  return {
    ...rest,
    required_actions: scopedActions,
    streams: rest.streams.map((row) =>
      row.action_ref === null ? row : { ...row, action_ref: remapped.get(row.action_ref) ?? null }
    ),
  };
}
