/**
 * The one server-derived, closed owner state per source (Wave 10a — 2026-07-09
 * studio review / state-model convergence).
 *
 * `deriveOwnerState` is a PURE projection over the existing `RenderedVerdict`
 * (`rendered-verdict.ts`) plus one explicit, typed evidence object
 * (`OwnerStateEvidence`) the caller assembles from real records — never from
 * copy strings, resolver names, or projection read time. It introduces NO
 * second state machine: `pill`/`channel`/`required_actions` already answer
 * "is this healthy" and "what needs doing;" this module adds ONE additional
 * server-owned field — `resolver` (closed enum), `evidence_as_of` (the
 * timestamp of the evidence that produced the state), and `posture`
 * (`observed` vs `frozen-since-last-run`) — so the console re-derivations it
 * is intended to replace (`deriveSourceStatus` off raw `state`,
 * `source-actionability.ts`'s parallel work-group taxonomy, and a legacy
 * client verdict fallback) can be deleted rather than reconciled as each
 * consumer migrates.
 *
 * `resolver` is a closed SERVER-SIDE contract, not an owner-facing
 * vocabulary: the console never prints the resolver name verbatim to the
 * owner. It exists so derivation is exhaustive (the cross-product test below)
 * and so console deletion is safe: every (lifecycle, schedule mode, active
 * progress, tone/channel) combination maps to exactly one resolver.
 *
 * `reattach_schedule` (the "Resume schedule" action for a paused connection)
 * is emitted by `buildRequiredActions` in `rendered-verdict.ts`'s SINGLE
 * synthesis pass — NOT by a post-pass mutator in this module. An earlier
 * revision of this module mutated `required_actions[]`/`channel` after
 * synthesis; that left `forward_statement`, `annotations`,
 * `streams[].action_ref`, and `trace` derived from the STALE pre-mutation
 * action set, making the verdict internally inconsistent (owner review,
 * 2026-07-09). `rendered-verdict.ts` is now the SOLE owner of action
 * derivation; this module only READS the resulting verdict.
 *
 * Design gate (2026-07-09 studio review) this module is bound by:
 *   1. Never derive semantic state from presentation copy (e.g. pill label
 *      text). Callers pass typed active-run/progress evidence instead.
 *   2. `retired` requires explicit lifecycle evidence (`lifecycle.status ===
 *      "revoked"`) passed by the caller — never inferred from a terminal
 *      code_fix action. When the caller has no lifecycle evidence, `retired`
 *      is unreachable and the resolver falls through to the health-driven
 *      resolvers below.
 *   3. Schedule mode is a typed tri-state (`manual | scheduled-active |
 *      scheduled-disabled`) derived from schedule-row presence plus the
 *      row's own `enabled` flag (NOT `ScheduleApi.effective_mode`, which
 *      conflates operator-disabled with system-ineligible-but-armed — see
 *      {@link OwnerStateScheduleMode}). Never-scheduled connections never
 *      resolve `owner_paused` and never receive a `reattach_schedule` action.
 *   4. `evidence_as_of` is the timestamp of the evidence that caused the
 *      state (active-run start, latest terminal run, or last
 *      successful freshness proof) — selected explicitly by the caller, who
 *      is closest to which evidence source fired. It is NEVER projection
 *      read time. A separate `generated_at` (if a caller wants one) is out
 *      of scope for this module.
 *   5. `posture` follows the evidence source / active-vs-terminal fact
 *      (`evidence.source`), not the resolver name.
 *   6. `reattach_schedule` points at `{ kind: "schedule" }` — a distinct
 *      surface from `runtime_retry` ("run this once now"), since resuming a
 *      paused schedule is a different affordance from a one-off retry. It
 *      is emitted through the same one-pass synthesizer as every other
 *      action, so `channel`/`forward_statement`/`trace` are ALWAYS
 *      consistent with it — proven by the invariant-consistency test in
 *      `rendered-verdict.test.js`, not just an array-membership assertion.
 */

import type { ConnectionHealthSnapshot } from "./connection-health.ts";
import type { RenderedVerdict, ScheduleEvidence } from "./rendered-verdict.ts";

/**
 * The closed internal resolver enum. Exhaustive: every reachable
 * `(lifecycle, schedule mode, active progress, verdict)` combination from
 * {@link deriveOwnerState} resolves to exactly one of these. This is a
 * server-side derivation aid, never owner-facing copy.
 */
export type OwnerStateResolver =
  | "blocked_maintainer"
  | "collecting"
  | "healthy"
  | "needs_owner"
  | "not_measured"
  | "owner_paused"
  | "refresh_due"
  | "retired"
  | "setup_in_progress"
  | "system_degraded";

/**
 * Who acts next for this owner state. Mirrors `RequiredAction.audience` but
 * collapses "no action" (`none`/absent) into an explicit resolver-only
 * value so the console never has to infer owner-of-state from an empty
 * `required_actions[]`.
 */
export type OwnerOfState = "maintainer" | "owner" | "system";

/**
 * Whether `evidence_as_of` reflects a live observation this pass, or a
 * terminal run result being read verbatim without re-verification.
 * `frozen-since-last-run` is the studio critique's "USAA read Degraded for
 * ~23 days" fix: the console must render frozen defect verdicts as "last run
 * found X (Nd ago)" with a re-check affordance, never as a bare current fact.
 */
export type OwnerStatePosture = "frozen-since-last-run" | "observed";

export interface OwnerState {
  /**
   * ISO-8601 instant of the EVIDENCE that produced this state — never
   * projection/read time. `null` when the caller has no evidence at all
   * (never-run source, no freshness proof) — see
   * {@link OwnerStateEvidence.as_of} and {@link OwnerStateEvidenceSource}'s
   * `"none"` member. A missing evidence timestamp must never be papered over
   * with the current read time.
   */
  readonly evidence_as_of: string | null;
  /** Who acts next, derived from the primary required action (or `system` when none). */
  readonly owner_of_state: OwnerOfState;
  /** Whether `evidence_as_of` is a live pass or a frozen terminal-run read. */
  readonly posture: OwnerStatePosture;
  /** The closed internal resolver. NOT owner-facing vocabulary. */
  readonly resolver: OwnerStateResolver;
}

/**
 * Real lifecycle evidence for `retired` and `setup_in_progress`. Omit (pass
 * `null`) when the caller has no instance-level lifecycle row in scope (e.g.
 * the connector-keyed detail path, which has no instance row) — both
 * `retired` and `setup_in_progress` are then unreachable rather than inferred
 * from health shape.
 */
export interface OwnerStateLifecycle {
  readonly status: "active" | "draft" | "revoked" | string;
}

/**
 * Typed schedule mode. Re-exported from `rendered-verdict.ts`'s
 * {@link ScheduleEvidence} — that module is now the SOLE owner of "what does
 * a disabled schedule mean," since it both classifies the mode AND emits
 * `reattach_schedule` in the single synthesis pass. This module reads the
 * same field rather than declaring a parallel type.
 *
 * Derived by the caller from the real `ScheduleApi` (`controller.ts`) —
 * never a bare `{ enabled: boolean }` heuristic in isolation, and NEVER from
 * `effective_mode`: `computeEffectiveMode` (`controller.ts:1685-1696`)
 * returns `"paused"` for BOTH `enabled === false` (operator intent) AND
 * `enabled === true` with `human_attention_needed` (a system-side
 * ineligibility), and never returns `"manual"` at all today — so
 * `effective_mode` cannot distinguish operator-paused from
 * system-ineligible-but-still-armed, and can never signal "no schedule
 * concept applies." The real, current authority is the row's OWN `enabled`
 * flag and its presence/absence.
 *
 *   - `manual`             : no schedule row exists for this connector.
 *                             `owner_paused` is unreachable.
 *   - `scheduled-active`   : a schedule row exists and `enabled === true`.
 *   - `scheduled-disabled` : a schedule row exists and `enabled === false` —
 *                             the ONLY mode `owner_paused` can resolve from.
 */
export type OwnerStateScheduleMode = ScheduleEvidence["mode"];

/**
 * Derive the typed schedule mode from the real `ScheduleApi` shape. See
 * {@link OwnerStateScheduleMode} for why `enabled` (not `effective_mode`) is
 * the authority.
 */
export function scheduleModeFrom(schedule: { readonly enabled: boolean } | null): OwnerStateScheduleMode {
  if (schedule === null) {
    return "manual";
  }
  return schedule.enabled ? "scheduled-active" : "scheduled-disabled";
}

/**
 * Active-run progress evidence, typed — never inferred from pill label text.
 * `active` means a nonterminal run (queued/starting/in_progress) is
 * currently the latest run for this connection; the caller derives this from
 * run lifecycle state, not from the rendered `Checking` copy.
 */
export interface OwnerStateProgress {
  readonly active: boolean;
}

/**
 * The CAUSAL source of `OwnerStateEvidence.as_of` — which real record
 * actually produced this state pass. `derivePosture` reads this directly
 * (design gate #5): `active_progress` is always `observed` (an active-run
 * record is live); `latest_terminal_run` is always `frozen-since-last-run` (a terminal
 * run result, read verbatim, ages the instant it lands); `last_successful_freshness`
 * is `observed` — a successful freshness proof is a positive current fact,
 * not a stale defect being re-shown. `none` means the caller has NO real
 * evidence to select from (no active run, no terminal run, no freshness
 * `captured_at`) — `as_of` MUST be `null` in that case; projection read time
 * (`nowIso`) is never a substitute (a never-run source with no evidence is
 * not "current as of now," it simply has no evidence yet).
 */
export type OwnerStateEvidenceSource = "active_progress" | "last_successful_freshness" | "latest_terminal_run" | "none";

/**
 * The single explicit evidence object a caller assembles to derive an owner
 * state. Every field is real, typed, and sourced by the caller from records
 * — never inferred here from presentation strings or resolver names.
 */
export interface OwnerStateEvidence {
  /**
   * The instant of the evidence that produced this state — the active run's
   * durable start instant, the latest terminal run's completion
   * instant, or the last successful freshness-proof instant, chosen by the
   * caller. NEVER projection/read time. `null` iff `source === "none"`.
   */
  readonly as_of: string | null;
  /** Real lifecycle evidence, or `null` when unavailable to the caller (retired is then unreachable). */
  readonly lifecycle: OwnerStateLifecycle | null;
  /** Typed active-run progress evidence. */
  readonly progress: OwnerStateProgress;
  /** Typed schedule mode, derived from the real `ScheduleApi` via {@link scheduleModeFrom}. */
  readonly schedule_mode: OwnerStateScheduleMode;
  /** Which real record `as_of` was read from — the causal input to {@link derivePosture}. `"none"` when there is no evidence at all. */
  readonly source: OwnerStateEvidenceSource;
}

/**
 * The minimal, already-classified terminal-run shape
 * {@link ownerStateCausalEvidenceFrom} needs. The caller (`ref-control.ts`)
 * owns run CLASSIFICATION — selecting which run (`lastRun`, or
 * `lastSuccessfulRun` when the latest is active/owner-cancelled with no
 * evidence of its own) is authoritative for coverage/health — since that
 * depends on that module's local `ConnectorRunSummary`/run-status helpers.
 * This module owns the causal-evidence-selection CONCEPT: given the
 * classifying run's own `last_at`/`succeeded` facts (already resolved by
 * the caller), decide `as_of`/`source`.
 */
export interface ClassifiedRunForOwnerState {
  /** ISO-8601 instant the classifying run finished. */
  readonly last_at: string;
  /** Whether the classifying run succeeded — determines `observed` vs `frozen-since-last-run` posture. */
  readonly succeeded: boolean;
}

/**
 * The single causal-evidence selection `OwnerStateEvidence.as_of`/`source`
 * must use (owner review, 2026-07-09): a SUCCEEDED classifying run is
 * `last_successful_freshness`/observed — a positive current fact, not a
 * stale defect being re-shown. A non-succeeded classifying run (failed,
 * cancelled-not-by-owner, abandoned) is `latest_terminal_run`/frozen —
 * `frozen-since-last-run` posture is reserved for DEFECT evidence. When the
 * caller has no classifying run at all (`classifiedRun === null` — e.g. an
 * owner-cancelled latest run with no prior success), it falls back to a
 * freshness proof if one exists, or `"none"` with `as_of: null` — never
 * projection/read time (design gate #4).
 *
 * `activeRun`/`progress.active` is a SEPARATE signal the caller evaluates
 * BEFORE calling this selector — it is not folded in here, matching the
 * caller's own run-classification contract of "what proven evidence do we
 * have," not "is something running right now."
 */
export function ownerStateCausalEvidenceFrom(
  classifiedRun: ClassifiedRunForOwnerState | null,
  freshnessCapturedAt: string | null
): { readonly as_of: string | null; readonly source: OwnerStateEvidenceSource } {
  if (classifiedRun != null) {
    return {
      as_of: classifiedRun.last_at,
      source: classifiedRun.succeeded ? "last_successful_freshness" : "latest_terminal_run",
    };
  }
  if (freshnessCapturedAt != null) {
    return { as_of: freshnessCapturedAt, source: "last_successful_freshness" };
  }
  return { as_of: null, source: "none" };
}

/**
 * Resolver derivation table, evaluated top-to-bottom as a priority chain
 * (first match wins), so every input combination resolves deterministically
 * to exactly one resolver — the exhaustive cross-product test below proves
 * this holds for the fixture matrix.
 */
function resolveOwnerStateResolver(
  verdict: RenderedVerdict,
  snapshot: ConnectionHealthSnapshot,
  evidence: OwnerStateEvidence
): OwnerStateResolver {
  const primary = verdict.required_actions[0] ?? null;

  // Retired: ONLY from explicit lifecycle evidence. Never inferred from a
  // terminal code_fix action or any other health shape (design gate #2).
  // Highest priority — a revoked connection's schedule/health state is moot.
  if (evidence.lifecycle?.status === "revoked") {
    return "retired";
  }

  // Setup in progress: ONLY from explicit lifecycle evidence (the connector-
  // instance row's own `status`), same discipline as `retired` (design gate
  // #2's sibling). A `draft` connection has not completed its first
  // credential capture / browser enrollment and has never ingested, so its
  // health/schedule/coverage shape is not yet meaningful — checked before
  // every other resolver so a draft never reads as `needs_owner`,
  // `not_measured`, or (worse) `healthy`. See
  // fix-pending-connection-discovery design.
  if (evidence.lifecycle?.status === "draft") {
    return "setup_in_progress";
  }

  // A genuine defect (owner-attention, maintainer code_fix) always outranks
  // a merely-paused schedule: a disabled schedule must never mask a more
  // urgent credential failure or maintainer-blocked coverage gap underneath
  // it. Check these BEFORE `owner_paused` (owner review, 2026-07-09: "a
  // disabled schedule must not mask a more urgent credential or maintainer
  // failure").
  if (verdict.channel === "attention" && primary && primary.audience === "owner") {
    return "needs_owner";
  }
  if (primary?.audience === "maintainer") {
    return "blocked_maintainer";
  }

  // Owner-paused schedule: a schedule row exists, was disabled, and the
  // connection has a prior success — and (per the two checks above) no
  // higher-priority owner-attention or maintainer defect is already present.
  // Manual connectors (schedule_mode === "manual") can never resolve this —
  // there is no schedule to resume (design gate #3).
  if (evidence.schedule_mode === "scheduled-disabled" && snapshot.last_success_at !== null) {
    return "owner_paused";
  }

  // Active-run progress (typed evidence, never the `Checking` copy string or
  // `snapshot.badges.syncing`) resolves `collecting` regardless of pill
  // tone, right after lifecycle and current owner/maintainer-attention
  // priority (owner review, 2026-07-09: decouple this from `badges.syncing`
  // coupling and from the grey-tone branch — an active run over a prior
  // GREEN verdict must still read `collecting`, not fall through to
  // `healthy`). This is placed AFTER the `needs_owner`/`blocked_maintainer`
  // checks above so an active run that is ALSO currently blocked on owner
  // input (e.g. an in-progress run awaiting an OTP) still resolves
  // `needs_owner` — active progress does not mask a live owner-attention
  // requirement.
  if (evidence.progress.active) {
    return "collecting";
  }

  // No causal evidence at all (`source === "none"`: no active run, no
  // terminal run, no freshness proof) resolves `not_measured` — NEVER
  // `healthy` (owner review, 2026-07-09: absent instrumentation with no
  // active work is not green). `baseStateTone` reads a never-run `idle`
  // connection as tone `"green"`, not `"grey"` (`rendered-verdict.ts`), so
  // this check cannot rely on the grey-tone branch below; it must check the
  // evidence source directly. Lifecycle (`retired`) and higher-priority
  // owner/maintainer actions above still take precedence — this is the
  // fallback for a genuinely unmeasured connection with nothing further to
  // say about it. (Active progress is handled above and always short-
  // circuits before this check.)
  if (evidence.source === "none") {
    return "not_measured";
  }

  if (verdict.pill.tone === "grey") {
    // Active progress is already handled above; a grey tone reaching here
    // with no active work is a genuinely unmeasured connection.
    return "not_measured";
  }

  // A non-urgent owner accelerant (refresh_now / stale manual-refresh) — the
  // owner CAN act but nothing is actually broken.
  if (primary?.kind === "refresh_now" || verdict.detail.forward_disposition === "owner_refresh_due") {
    return "refresh_due";
  }

  // Any remaining amber/red tone is real system-side trouble the owner did
  // not cause and (per the actions above) cannot single-handedly resolve.
  if (verdict.pill.tone === "amber" || verdict.pill.tone === "red") {
    return "system_degraded";
  }

  // Green tone, no owner-paused override, no pending action: genuinely healthy.
  if (snapshot.badges.syncing || snapshot.axes.outbox === "active") {
    return "collecting";
  }
  return "healthy";
}

const RESOLVER_OWNER: Record<OwnerStateResolver, OwnerOfState> = {
  blocked_maintainer: "maintainer",
  collecting: "system",
  healthy: "system",
  needs_owner: "owner",
  not_measured: "system",
  owner_paused: "owner",
  refresh_due: "owner",
  retired: "maintainer",
  setup_in_progress: "owner",
  system_degraded: "system",
};

/**
 * Posture follows `evidence.source` (design gate #5) — the CAUSAL record the
 * caller read `as_of` from — never the resolver name. `latest_terminal_run`
 * is always `frozen-since-last-run`: a terminal run result, read verbatim,
 * is a defect frozen at the instant that run finished, however long ago.
 * `active_progress` and `last_successful_freshness` are always `observed`:
 * both are positive current facts (a live pass, or a successful proof), not
 * a stale defect being re-shown. `none` (no evidence at all) is `observed`
 * too — an absence of evidence is not a frozen defect being re-shown; it
 * pairs with `resolver: "not_measured"`/`"healthy"` (never-run) and
 * `"setup_in_progress"` (draft, not yet ingested), all of which are honest
 * "nothing to freeze" cases.
 */
function derivePosture(evidence: OwnerStateEvidence): OwnerStatePosture {
  return evidence.source === "latest_terminal_run" ? "frozen-since-last-run" : "observed";
}

/**
 * Derive the one closed owner state for a source. Pure: no I/O, no clock
 * read, no copy-string matching — every input is explicit, typed evidence
 * the caller assembled from real records.
 *
 * @param verdict  the rendered verdict from `synthesizeRenderedVerdict`/
 *                 `synthesizeConnectorVerdict`, called with the SAME
 *                 `scheduleEvidence` the caller passes as `evidence.schedule_mode`
 *                 below — `reattach_schedule` is emitted inside that single
 *                 synthesis pass (`buildRequiredActions`, `rendered-verdict.ts`),
 *                 never as a post-pass mutation here (owner review,
 *                 2026-07-09: a post-pass mutator leaves `forward_statement`,
 *                 `channel`, `annotations`, `streams[].action_ref`, and
 *                 `trace` derived from the stale action set — action
 *                 derivation must have ONE owner).
 * @param snapshot the connection-health snapshot the verdict was built from
 * @param evidence explicit typed evidence (lifecycle, schedule mode, active
 *                 progress, evidence timestamp) — see {@link OwnerStateEvidence}
 */
export function deriveOwnerState(
  verdict: RenderedVerdict,
  snapshot: ConnectionHealthSnapshot,
  evidence: OwnerStateEvidence
): OwnerState {
  const resolver = resolveOwnerStateResolver(verdict, snapshot, evidence);
  return {
    resolver,
    owner_of_state: RESOLVER_OWNER[resolver],
    evidence_as_of: evidence.as_of,
    posture: derivePosture(evidence),
  };
}
