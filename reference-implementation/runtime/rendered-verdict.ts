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
  CONNECTION_CONDITION_REASONS,
  type ConnectionHealthSnapshot,
  type ConnectionRefreshEvidence,
  type CoverageAxis,
  deriveForwardDisposition,
  type ForwardDisposition,
  isAssistedRefresh,
  isManualRefreshOnly,
} from "./connection-health.ts";

// ─── Public verdict types ──────────────────────────────────────────────────

/**
 * Worst-wins collection-health tone. Orthogonal to {@link RenderedChannel}: it
 * answers "is collection healthy?", never "whether to interrupt". `grey` is the
 * unknown/checking tone.
 */
export type VerdictTone = "amber" | "green" | "grey" | "red";

/**
 * Fixed health-label bijection. Action-demand language ("Needs you") is reserved
 * for `channel === "attention"` and owner-satisfiable required actions, not for
 * stale freshness or other advisory states.
 */
export type VerdictLabel = "Can't collect" | "Checking" | "Degraded" | "Healthy";

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
  readonly collection_rate: ConnectionHealthSnapshot["collection_rate"];
  readonly conditions: ConnectionHealthSnapshot["conditions"];
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
  readonly stream_id: string;
}

/**
 * Optional progress evidence. Collection-model facts the synthesizer privileges by
 * `mode`. All fields are nullable; the synthesizer never fabricates a number.
 */
export interface ProgressEvidence {
  readonly gaps_drained_last_run?: number | null;
  readonly last_refreshed_at?: string | null;
  readonly mode: ProgressMode;
  /** Observation instant supplied by the caller; keeps this module pure. */
  readonly observed_at?: string | null;
  readonly records_committed_last_run?: number | null;
  readonly retained_records?: number | null;
}

// ─── Tone (worst-wins) ──────────────────────────────────────────────────────

const TONE_RANK: Record<VerdictTone, number> = { green: 0, grey: 1, amber: 2, red: 3 };

const TONE_TO_LABEL: Record<VerdictTone, VerdictLabel> = {
  green: "Healthy",
  grey: "Checking",
  amber: "Degraded",
  red: "Can't collect",
};

function worse(a: VerdictTone, b: VerdictTone): VerdictTone {
  return TONE_RANK[a] >= TONE_RANK[b] ? a : b;
}

/** Base tone implied by the headline state — NEVER read straight as the pill tone. */
function baseStateTone(state: ConnectionHealthSnapshot["state"]): VerdictTone {
  switch (state) {
    case "healthy":
      return "green";
    case "idle":
      return "green";
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

function freshnessHealthTone(snapshot: ConnectionHealthSnapshot): VerdictTone {
  switch (snapshot.axes.freshness) {
    case "fresh":
      return "green";
    case "stale":
      return "green";
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
      return "grey";
    case "resumable":
      return "amber";
    case "owner_refresh_due":
      return "green";
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
  disposition: ForwardDisposition
): VerdictTone {
  if (tone === "red" && softensTerminalCoverageToDegraded(snapshot, disposition)) {
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
 * The worst per-stream coverage tone, weighted by manifest priority: an
 * `accepted_absence`/`optional` stream that is merely stale or partial annotates but
 * does NOT downgrade the pill below the required-stream tone (mitigates "worst-wins
 * over-ambers on a trivial optional stream", design Risks). A required stream always
 * contributes its full tone. A terminal/unsupported coverage on ANY stream is a real
 * red regardless of priority — a lost stream is a lost stream.
 */
function worstStreamCoverageTone(streams: readonly StreamRollup[]): VerdictTone {
  let worstTone: VerdictTone = "green";
  for (const stream of streams) {
    const tone = coverageTone(stream.coverage);
    const isHardRed = tone === "red"; // terminal/unsupported/unavailable
    if (stream.priority === "required" || isHardRed) {
      worstTone = worse(worstTone, tone);
    }
    // optional/accepted-absence non-red coverage annotates only; does not downgrade.
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
  refresh: ConnectionRefreshEvidence | null
): ForwardDisposition {
  if (streams.length === 0) {
    // No per-stream rollup supplied — trust the snapshot's own connection-level
    // disposition (already derived through the oracle by the projection).
    return snapshot.forward_disposition;
  }
  // Worst-wins over per-stream dispositions, each derived through the oracle —
  // weighted by manifest priority exactly as the coverage rollup is. A required
  // stream always contributes its disposition; an optional / accepted-absence
  // stream contributes only when its disposition is `terminal` (a lost stream is
  // lost regardless of priority). This keeps disposition and coverage consistent so
  // a trivially-stale optional stream does not amber the whole connection.
  let worstRank = TONE_RANK[dispositionTone(snapshot.forward_disposition)];
  let worst: ForwardDisposition = snapshot.forward_disposition;
  for (const stream of streams) {
    const disposition = streamDisposition(stream, snapshot, refresh);
    const counts = stream.priority === "required" || disposition === "terminal";
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
  refresh: ConnectionRefreshEvidence | null
): ForwardDisposition {
  return deriveForwardDisposition({
    coverage: stream.coverage,
    gapRetryable: stream.gap_retryable,
    attentionOpen: stream.attention_open,
    freshness: snapshot.axes.freshness,
    refresh,
  });
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

function softensTerminalCoverageToDegraded(
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition
): boolean {
  return disposition === "terminal" && snapshot.state === "degraded" && latestCollectionSucceeded(snapshot);
}

function terminalCoverageCta(snapshot: ConnectionHealthSnapshot, disposition: ForwardDisposition): string {
  if (softensTerminalCoverageToDegraded(snapshot, disposition)) {
    return "Coverage gap needs review";
  }
  return "Connector code needs a fix";
}

/** Open structured owner attention (the `needs_attention` driver). */
function hasOpenAttention(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.axes.attention !== "none";
}

function hasOwnerAction(actions: readonly RequiredAction[]): boolean {
  return actions.some((action) => action.audience === "owner" && action.satisfied_when.kind !== "none");
}

function hasTransientUploadFailure(snapshot: ConnectionHealthSnapshot): boolean {
  return snapshot.conditions.some(
    (condition) =>
      condition.current &&
      (condition.reason === CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_TRANSIENT_UPLOAD_FAILURE ||
        condition.reason === CONNECTION_CONDITION_REASONS.OUTBOX_TRANSIENT_UPLOAD_FAILURE)
  );
}

function shouldOfferRetryGapAction(
  snapshot: ConnectionHealthSnapshot,
  refresh: ConnectionRefreshEvidence | null
): boolean {
  return snapshot.state === "degraded" || isManualRefreshOnly(refresh);
}

const LOCAL_COLLECTOR_RECOVER_COMMAND =
  "npx -y @pdpp/local-collector recover --source-instance-id <source-instance-id>";
const LOCAL_COLLECTOR_RECOVER_APPLY_COMMAND =
  "npx -y @pdpp/local-collector recover --source-instance-id <source-instance-id> --apply";
const LOCAL_COLLECTOR_DOCTOR_COMMAND = "npx -y @pdpp/local-collector doctor --source-instance-id <source-instance-id>";
const LOCAL_COLLECTOR_REMEDIATION_TARGET: ActionRemediationTarget = {
  kind: "local_device",
  identity_source: "source_instance_bindings",
};

function localCollectorRecoverPreviewCommand(): ActionRemediationCommand {
  return {
    kind: "local_collector_recover_preview",
    label: "Preview recovery",
    command_template: LOCAL_COLLECTOR_RECOVER_COMMAND,
  };
}

function localCollectorRecoverApplyCommand(): ActionRemediationCommand {
  return {
    kind: "local_collector_recover_apply",
    label: "Recover and run the collector",
    command_template: LOCAL_COLLECTOR_RECOVER_APPLY_COMMAND,
  };
}

function localCollectorDoctorCommand(): ActionRemediationCommand {
  return {
    kind: "local_collector_doctor",
    label: "Check local collector health",
    command_template: LOCAL_COLLECTOR_DOCTOR_COMMAND,
  };
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
  return "stalled_unknown";
}

function stalledOutboxRemediation(snapshot: ConnectionHealthSnapshot): ActionRemediation {
  const cause = stalledOutboxCause(snapshot);
  switch (cause) {
    case "state_read_failed":
      return {
        kind: "local_collector_recovery",
        cause,
        label: "Run the local collector again",
        summary:
          "The server cannot read the collector's last state from that host. Run the local collector again there.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
        commands: [localCollectorRecoverApplyCommand()],
      };
    case "dead_letter_backlog":
      return {
        kind: "local_collector_recovery",
        cause,
        label: "Recover local collector uploads",
        summary: "The local collector has saved records on its host that did not upload to this server.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
        commands: [localCollectorRecoverPreviewCommand(), localCollectorRecoverApplyCommand()],
      };
    case "transient_upload_failure":
      return {
        kind: "local_collector_recovery",
        cause,
        label: "Wait for upload retry",
        summary:
          "The local collector hit temporary server or network errors while uploading. It will retry without owner action.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
        commands: [],
      };
    case "stale_pending":
      return {
        kind: "local_collector_recovery",
        cause,
        label: "Run the local collector again",
        summary: "The local collector has queued work that stopped moving. Run it again on that host.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
        commands: [localCollectorRecoverApplyCommand()],
      };
    default:
      return {
        kind: "local_collector_recovery",
        cause,
        label: "Check the local collector",
        summary: "The local collector is not making progress. Check it on the host that holds the data.",
        target: LOCAL_COLLECTOR_REMEDIATION_TARGET,
        commands: [localCollectorDoctorCommand()],
      };
  }
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
  disposition: ForwardDisposition
): RequiredAction[] {
  const terminal = disposition === "terminal";
  const actions: RequiredAction[] = [];

  // Terminal coverage on a stream with no owner recovery path: maintainer-status
  // code_fix. Credential failures add an owner action below, so do not make
  // "code fix" the primary story for a source the owner can repair by reconnecting.
  if (terminal && !hasCredentialFailure(snapshot)) {
    actions.push({
      kind: "code_fix",
      audience: "maintainer",
      urgency: "soon",
      affects: terminalStreamIds(streams),
      cta: terminalCoverageCta(snapshot, disposition),
      terminal: true,
      satisfied_when: { kind: "none" },
    });
  }

  // Failed credential — owner is the sole resolution. Owner-satisfiable reauth.
  if (hasCredentialFailure(snapshot)) {
    actions.push({
      kind: "reauth",
      audience: "owner",
      urgency: "now",
      affects: [],
      cta: "Reconnect this account",
      terminal,
      satisfied_when: { kind: "credential_present_and_unrejected" },
    });
  }

  // Open structured attention (OTP / manual action / re-consent) — owner-satisfiable.
  if (hasOpenAttention(snapshot) && !hasCredentialFailure(snapshot)) {
    actions.push({
      kind: "add_info",
      audience: "owner",
      urgency: "now",
      affects: [],
      cta: "Finish the prompt to keep collecting",
      terminal,
      satisfied_when: { kind: "attention_resolved" },
    });
  }

  // A stalled outbox means durable work is stuck outside the server. Coverage may
  // still be "complete" because the records already accepted are valid, but the
  // source cannot keep making progress until the owner checks the collector host.
  if (
    snapshot.axes.outbox === "stalled" &&
    disposition !== "terminal" &&
    !hasOwnerAction(actions) &&
    hasTransientUploadFailure(snapshot)
  ) {
    const remediation = stalledOutboxRemediation(snapshot);
    actions.push({
      kind: "wait",
      audience: "none",
      urgency: "verifying",
      affects: [],
      cta: "Retrying local uploads — no action needed",
      remediation,
      terminal: false,
      satisfied_when: { kind: "none" },
    });
  }

  if (
    snapshot.axes.outbox === "stalled" &&
    disposition !== "terminal" &&
    !hasOwnerAction(actions) &&
    !hasTransientUploadFailure(snapshot)
  ) {
    const remediation = stalledOutboxRemediation(snapshot);
    actions.push({
      kind: "add_info",
      audience: "owner",
      urgency: "now",
      affects: [],
      cta: remediation.label,
      remediation,
      terminal: false,
      satisfied_when: { kind: "attention_resolved" },
    });
  }

  // Manual/assisted-refresh stale: owner-refresh-due. Owner-actionable but NON-urgent
  // (the data is simply aging; the owner can accelerate but inaction is not a failure).
  if (disposition === "owner_refresh_due" && (isManualRefreshOnly(refresh) || isAssistedRefresh(refresh))) {
    actions.push({
      kind: "refresh_now",
      audience: "owner",
      urgency: "soon",
      affects: [],
      cta: "Refresh now",
      terminal: false,
      satisfied_when: { kind: "confirming_run_succeeded" },
    });
  }

  // Degraded or manual-refresh retryable gaps: the system can recover on a
  // future run, but the owner can explicitly ask for another attempt. Surface
  // that non-urgent accelerant instead of hiding degraded gaps as a calm wait.
  if (disposition === "resumable" && actions.length === 0 && shouldOfferRetryGapAction(snapshot, refresh)) {
    const affects = resumableStreamIds(streams);
    actions.push({
      kind: "retry_gap",
      audience: "owner",
      urgency: "verifying",
      affects,
      cta: "Retry now",
      terminal: false,
      satisfied_when: { kind: "gap_recovered" },
    });
  }

  // A recoverable gap the system will fill on its own — the calm `wait` representation
  // of deferred drain / cooldown / syncing. Only emit when nothing owner-actionable
  // already covers the work, so a `wait` never competes with a real owner action.
  if (disposition === "resumable" && actions.length === 0) {
    actions.push({
      kind: "wait",
      audience: "none",
      urgency: "verifying",
      affects: resumableStreamIds(streams),
      cta: "Collecting — no action needed",
      terminal: false,
      satisfied_when: { kind: "none" },
    });
  }

  actions.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);
  return actions;
}

function terminalStreamIds(streams: readonly StreamRollup[]): string[] {
  return streams
    .filter((s) => s.coverage === "terminal_gap" || s.coverage === "unsupported" || s.coverage === "unavailable")
    .map((s) => s.stream_id);
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

const CHANNEL_RANK: Record<RenderedChannel, number> = { calm: 0, advisory: 1, attention: 2 };

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
  progress: ProgressEvidence | null,
  actions: readonly RequiredAction[]
): VerdictAnnotation[] {
  const annotations: VerdictAnnotation[] = [];

  // Co-required freshness annotation: ALWAYS present when freshness is not fresh
  // (honesty invariant 1). For fresh connections, include a quiet recency cue
  // when the caller supplied enough evidence. Text carries NO raw mechanistic counts.
  const freshnessText = freshnessAnnotationText(snapshot, tone, refresh, progress, actions);
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
  progress: ProgressEvidence | null,
  actions: readonly RequiredAction[]
): string | null {
  if (snapshot.axes.freshness === "fresh") {
    return freshRecencyText(tone, progress);
  }
  if (snapshot.axes.freshness === "unknown") {
    return "Freshness is unknown — checking.";
  }
  const retry = actions.find((action) => action.kind === "retry_gap");
  if (retry) {
    const affected = retry.affects[0] ?? null;
    const since = shortMonthDay(snapshot.last_success_at);
    if (affected && since) {
      return `${humanizeStreamId(affected)} stuck since ${since}.`;
    }
  }
  const refreshedAge = relativeDayAge(progress?.last_refreshed_at ?? null, progress?.observed_at ?? null);
  if (progress?.mode === "manual" || isManualRefreshOnly(refresh)) {
    if (refreshedAge) {
      return `Last refreshed ${refreshedAge}.`;
    }
    return "Stale — this connector refreshes when you run it.";
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
  if (age === "today") {
    return "Fresh today.";
  }
  if (age === "yesterday") {
    return "Fresh yesterday.";
  }
  return null;
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
  disposition: ForwardDisposition
): string {
  if (primary?.kind === "reauth") {
    return "Reconnect this account before further collection.";
  }
  if (primary?.kind === "code_fix") {
    if (softensTerminalCoverageToDegraded(snapshot, disposition)) {
      return "Latest collection completed with known coverage gaps.";
    }
    return "This connector needs a code fix before it can collect again.";
  }
  return "This data can't be recovered by a future run.";
}

/**
 * Single sentence DERIVED from disposition + primary action. NEVER claims resumed
 * collection while the disposition is terminal (honesty invariant 3 / spec scenario).
 */
function buildForwardStatement(
  disposition: ForwardDisposition,
  actions: readonly RequiredAction[],
  snapshot: ConnectionHealthSnapshot
): string {
  const primary = actions[0] ?? null;

  if (disposition === "terminal") {
    // A terminal disposition must never imply recovery.
    return terminalForwardStatement(primary, snapshot, disposition);
  }

  if (primary && primary.audience === "owner") {
    switch (primary.kind) {
      case "reauth":
        return "Reconnect this account and collection resumes.";
      case "add_info":
        if (primary.remediation?.kind === "local_collector_recovery") {
          return primary.remediation.summary;
        }
        return "Finish the prompt and collection resumes.";
      case "refresh_now":
        return "Run a refresh to bring this up to date.";
      case "retry_gap":
        return "Retry now to give the recoverable gap another run.";
      case "backfill":
        return "Run a backfill to fill the missing window.";
      default:
        return "Your action will bring this up to date.";
    }
  }
  if (primary?.kind === "wait" && primary.remediation?.cause === "transient_upload_failure") {
    return primary.remediation.summary;
  }

  switch (disposition) {
    case "checking":
      return "Checking coverage before deciding what the next run should do.";
    case "resumable":
      return "The next run is expected to fill the remaining data.";
    case "owner_refresh_due":
      return "Up to date once you refresh.";
    case "awaiting_owner":
      return "Waiting on you before the next run can make progress.";
    default:
      if (snapshot.axes.freshness === "unknown") {
        return "Checking freshness before calling this current.";
      }
      return "Current and collecting normally.";
  }
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
    if (actions.some((action) => action.kind === "code_fix" && action.cta !== "Connector code needs a fix")) {
      return `${held}; source coverage has known gaps.`;
    }
    return `${held}; connector code needs a fix before new collection.`;
  }
  return `${held}; this source cannot collect more until the terminal issue is fixed.`;
}

function progressHeadline(
  mode: ProgressMode,
  gapsDrained: number | null,
  committed: number | null,
  retained: number | null,
  refreshedAt: string | null,
  disposition: ForwardDisposition,
  actions: readonly RequiredAction[]
): string {
  if (disposition === "terminal") {
    return terminalProgressHeadline(retained, actions);
  }
  switch (mode) {
    case "deferred":
      return deferredHeadline(gapsDrained, retained);
    case "scheduled":
      return committed === null
        ? "Collecting on schedule."
        : `Committed ${committed.toLocaleString()} records last run.`;
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
  actions: readonly RequiredAction[]
): RenderedProgress {
  const mode: ProgressMode = evidence?.mode ?? "scheduled";
  const gapsDrained = evidence?.gaps_drained_last_run ?? null;
  const committed = evidence?.records_committed_last_run ?? null;
  const retained = evidence?.retained_records ?? null;
  const refreshedAt = evidence?.last_refreshed_at ?? null;

  return {
    mode,
    gaps_drained_last_run: null,
    records_committed_last_run: mode === "scheduled" ? committed : null,
    retained_records: retained,
    last_refreshed_at: refreshedAt,
    headline: progressHeadline(mode, gapsDrained, committed, retained, refreshedAt, disposition, actions),
  };
}

// ─── Stream rows ────────────────────────────────────────────────────────────

function buildStreamRows(
  streams: readonly StreamRollup[],
  snapshot: ConnectionHealthSnapshot,
  refresh: ConnectionRefreshEvidence | null,
  actions: readonly RequiredAction[]
): VerdictStreamRow[] {
  return streams.map((stream) => {
    const disposition = streamDisposition(stream, snapshot, refresh);
    // Clamp collected to considered (honesty invariant 2): no "3/2 collected".
    const collected =
      stream.collected !== null && stream.considered !== null
        ? Math.min(stream.collected, stream.considered)
        : stream.collected;
    return {
      stream_id: stream.stream_id,
      coverage: stream.coverage,
      disposition,
      collected,
      considered: stream.considered,
      action_ref: actionRefFor(stream, disposition, actions),
      statement: streamStatement(disposition),
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

function streamStatement(disposition: ForwardDisposition): string {
  switch (disposition) {
    case "complete":
      return "Complete.";
    case "checking":
      return "Checking coverage.";
    case "resumable":
      return "The next run is expected to fill the rest.";
    case "owner_refresh_due":
      return "Up to date once you refresh.";
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
      kind: "drain",
      reason: "detail-gap backlog is system-handled; counts kept off the attention layer",
      detail_field: "detail_gap_backlog",
    });
  }

  // Cooling-off / next-attempt floor is a self-handled wait.
  if (snapshot.state === "cooling_off" || snapshot.next_attempt_at) {
    suppressed.push({
      kind: "cooldown",
      reason: "next-attempt floor is system-managed",
      detail_field: "next_attempt_at",
    });
  }

  // An in-flight run is self-handled syncing.
  if (snapshot.badges.syncing) {
    suppressed.push({
      kind: "syncing",
      reason: "a run is in flight; syncing is self-handled",
      detail_field: "state",
    });
  }

  // A runtime fault that capped this connection's channel is routed to a single global
  // indicator, never to a per-connection attention pull.
  if (!runtimeOk && channel === "calm") {
    suppressed.push({
      kind: "runtime_fault",
      reason: "runtime is the fault; per-connection attention capped to calm",
      detail_field: "state",
    });
  }

  return suppressed;
}

function buildDetail(
  snapshot: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  suppressed: readonly SuppressedSignal[]
): VerdictDetail {
  return {
    state: snapshot.state,
    reason_code: snapshot.reason_code,
    dominant_condition_id: snapshot.dominant_condition_id,
    // The synthesizer's oracle-derived connection disposition (worst-wins over the
    // supplied per-stream rollups through `deriveForwardDisposition`, or the
    // snapshot's own oracle-derived value when no rollups are supplied). Using this —
    // not the raw snapshot field — keeps the WHOLE verdict internally consistent:
    // actions' terminality, the forward statement, and the invariant gate all read
    // the same single disposition.
    forward_disposition: disposition,
    conditions: snapshot.conditions,
    detail_gap_backlog: snapshot.detail_gap_backlog,
    next_attempt_at: snapshot.next_attempt_at,
    collection_rate: snapshot.collection_rate,
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

/** Honesty invariants 1–7 over the whole verdict. */
function honestyViolations(verdict: RenderedVerdict, snapshot: ConnectionHealthSnapshot): string[] {
  const violations: string[] = [];

  // (1) freshness-mandatory-off-fresh.
  if (snapshot.axes.freshness !== "fresh" && !verdict.annotations.some((a) => a.kind === "freshness")) {
    violations.push("off-fresh verdict is missing its co-required freshness annotation (inv 1)");
  }

  // (2) collected <= considered on every stream row.
  for (const row of verdict.streams) {
    if (row.collected !== null && row.considered !== null && row.collected > row.considered) {
      violations.push(`stream ${row.stream_id} collected > considered (inv 2)`);
    }
  }

  // (3) terminal disposition must not claim resumed collection.
  if (verdict.detail.forward_disposition === "terminal" && RESUME_CLAIM_RE.test(verdict.forward_statement)) {
    violations.push("forward_statement claims recovery on a terminal disposition (inv 3)");
  }
  if (verdict.detail.forward_disposition === "terminal" && RESUME_CLAIM_RE.test(verdict.progress.headline)) {
    violations.push("progress.headline claims recovery on a terminal disposition (inv 3)");
  }

  // (4) terminal === (forward_disposition === "terminal") for every connection-level action.
  const dispositionTerminal = verdict.detail.forward_disposition === "terminal";
  for (const action of verdict.required_actions) {
    if (action.affects.length === 0 && action.terminal !== dispositionTerminal) {
      violations.push(`action ${action.kind} terminal disagrees with disposition oracle (inv 4)`);
    }
  }

  // (5) tone is worst-wins — never below the base state tone.
  if (TONE_RANK[verdict.pill.tone] < TONE_RANK[baseStateTone(snapshot.state)]) {
    violations.push("pill.tone is below the base state tone — not worst-wins (inv 5)");
  }

  // (6) label ↔ tone bijection.
  if (verdict.pill.label !== TONE_TO_LABEL[verdict.pill.tone]) {
    violations.push("pill.label does not match the fixed tone bijection (inv 6)");
  }

  // (7) no contradictory chip pair: a terminal stream row must not carry a resume statement.
  for (const row of verdict.streams) {
    if (row.disposition === "terminal" && RESUME_CLAIM_RE.test(row.statement)) {
      violations.push(`stream ${row.stream_id} pairs terminal disposition with a resume statement (inv 7)`);
    }
  }

  return violations;
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
 * The eleven invariants (honesty 1–7, silence S1–S4) enforced on the WHOLE verdict —
 * one gate, not N scattered formatter checks.
 */
function assertInvariants(verdict: RenderedVerdict, snapshot: ConnectionHealthSnapshot, runtimeOk: boolean): string[] {
  return [...honestyViolations(verdict, snapshot), ...silenceViolations(verdict, runtimeOk)];
}

/** A minimal, honest grey verdict used as the prod fallback on an invariant failure. */
function safeGreyVerdict(snapshot: ConnectionHealthSnapshot): RenderedVerdict {
  return {
    pill: { tone: "grey", label: "Checking" },
    channel: "calm",
    annotations: [],
    forward_statement: "Checking this connection.",
    required_actions: [],
    streams: [],
    progress: buildProgress(null, "checking", []),
    detail: buildDetail(snapshot, "complete", []),
    trace: {
      tone_cause: "grey",
      tone_inputs: [],
      channel_cause: "invariant_fallback",
      suppressed_evidence: [],
      detail_destinations: [],
      primary_action_kind: null,
      satisfied_when: null,
      runtime_capped: false,
    },
  };
}

// ─── The synthesizer ────────────────────────────────────────────────────────

/**
 * Synthesize the one server-owned verdict. PURE: no I/O, no clock read; identical
 * inputs always produce an identical verdict.
 *
 * @param snapshot   the existing connection-health projection output
 * @param streams    per-stream rollups (synthesizer input; wire-forwarding is Dispatch C)
 * @param refresh    the manifest refresh evidence (`buildRefreshEvidence(...)` output)
 * @param runtime_ok whether the runtime serving the connections is itself healthy
 * @param progress   optional collection-model progress evidence
 */
export function synthesizeRenderedVerdict(
  snapshot: ConnectionHealthSnapshot,
  streams: readonly StreamRollup[],
  refresh: ConnectionRefreshEvidence | null,
  runtime_ok: boolean,
  progress: ProgressEvidence | null = null
): RenderedVerdict {
  // ── tone: worst-wins over base(state) + every axis ──
  const disposition = connectionDisposition(snapshot, streams, refresh);
  const coverageHealthTone = terminalAwareTone(worstStreamCoverageTone(streams), snapshot, disposition);
  const dispositionHealthTone = terminalAwareTone(dispositionTone(disposition), snapshot, disposition);
  const toneInputs: { axis: string; tone: VerdictTone }[] = [
    { axis: "state", tone: baseStateTone(snapshot.state) },
    { axis: "freshness", tone: freshnessHealthTone(snapshot) },
    { axis: "coverage", tone: coverageHealthTone },
    { axis: "disposition", tone: dispositionHealthTone },
    { axis: "attention", tone: attentionTone(snapshot) },
    { axis: "outbox", tone: outboxTone(snapshot) },
  ];
  const tone = toneInputs.reduce<VerdictTone>((acc, input) => worse(acc, input.tone), "green");
  const pill: VerdictPill = { tone, label: TONE_TO_LABEL[tone] };

  // ── required actions (terminality derived from the sole oracle) ──
  const actions = buildRequiredActions(snapshot, streams, refresh, disposition);

  // ── channel: computed AFTER tone in the same pass; runtime fault caps at calm ──
  let channel = computeChannel(actions);
  const runtimeCapped = !runtime_ok && channel !== "calm";
  if (!runtime_ok) {
    channel = "calm"; // invariant S4: cap every per-connection channel at calm
  }

  // ── annotations, statement, streams, progress ──
  const annotations = buildAnnotations(snapshot, channel, tone, refresh, progress, actions);
  const forwardStatement = buildForwardStatement(disposition, actions, snapshot);
  const streamRows = buildStreamRows(streams, snapshot, refresh, actions);
  const renderedProgress = buildProgress(progress, disposition, actions);

  // ── inspection layer: suppressed signals routed to detail, never deleted ──
  const suppressed = buildSuppressed(snapshot, channel, runtime_ok);
  const detail = buildDetail(snapshot, disposition, suppressed);

  const primary = actions[0] ?? null;
  const trace: CalibrationTrace = {
    tone_cause: tone,
    tone_inputs: toneInputs,
    channel_cause: channelCause(channel, runtimeCapped, primary),
    suppressed_evidence: suppressed,
    detail_destinations: suppressed.map((s) => s.detail_field),
    primary_action_kind: primary?.kind ?? null,
    satisfied_when: primary?.satisfied_when ?? null,
    runtime_capped: runtimeCapped,
  };

  const verdict: RenderedVerdict = {
    pill,
    channel,
    annotations,
    forward_statement: forwardStatement,
    required_actions: actions,
    streams: streamRows,
    progress: renderedProgress,
    detail,
    trace,
  };

  const violations = assertInvariants(verdict, snapshot, runtime_ok);
  if (violations.length > 0) {
    if (shouldThrowOnViolation()) {
      throw new VerdictInvariantError(violations.join("; "));
    }
    return safeGreyVerdict(snapshot);
  }
  return verdict;
}

function channelCause(channel: RenderedChannel, runtimeCapped: boolean, primary: RequiredAction | null): string {
  if (runtimeCapped) {
    return "runtime_fault_capped_to_calm";
  }
  if (channel === "attention") {
    return `owner_sole_resolution:${primary?.kind ?? "unknown"}`;
  }
  if (channel === "advisory") {
    return `owner_optional_or_status:${primary?.kind ?? "unknown"}`;
  }
  return "self_handled_calm";
}

/**
 * Project the inspection-layer `detail` and calibration `trace` OFF a verdict for a
 * grant-scoped client. The owner-only diagnostics (`detail`, `trace`) are stripped so a
 * grant-scoped REST/MCP read can never see them. Dispatch C wires this at the wire seam;
 * exported here so the grant-scope regression can pin the contract at the type level.
 */
export type GrantScopedVerdict = Omit<RenderedVerdict, "detail" | "trace">;

export function toGrantScopedVerdict(verdict: RenderedVerdict): GrantScopedVerdict {
  const { detail: _detail, trace: _trace, ...rest } = verdict;
  return rest;
}
