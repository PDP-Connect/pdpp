/**
 * ProviderProfile — the single declared home for every provider-specific
 * safety- / pressure- / terminal-shaped quantity (SLVP-ideal spec §3, §9-C5).
 *
 * THE RULE (spec §3 rule 6): "lift every provider-specific quantity out of
 * shared defaults into a required `ProviderProfile` that each connector author
 * must declare from THEIR OWN provider's observed behavior. No shared default
 * for a safety- or pressure-shaped quantity — a missing field is a build error,
 * not a silent borrow of ChatGPT's number."
 *
 * This file is the ONE source of truth for that field set. The three control
 * loops that consume it each take their slice as a NON-OPTIONAL argument so a
 * connector wired onto a loop without a declared profile fails at the type
 * boundary (the governor's `pacingMinIntervalMs`) or at a loud startup assertion
 * (`maybeTerminateGap` throws; the cooldown escalation no-ops on an absent
 * value). See the per-field notes below for which mechanism pins which field.
 *
 * WHY THESE FIELDS (and not the cosmetic knobs): a field belongs here iff
 * getting it wrong off the wrong provider's numbers risks a ban, a stall, or a
 * dishonest health verdict — i.e. it is safety-, pressure-, or terminal-shaped.
 * Discovery seeds, burst-tolerance, and AIMD horizons are derived/cosmetic and
 * stay shared-defaulted in the loop primitives; they are NOT forced here.
 *
 * Audit status (§9-C5): the FIELD SET and ChatGPT's values are
 * observation-backed (live ChatGPT probes 2026-06). The other six governor-using
 * connectors carry CONSERVATIVE, UNAUDITED placeholder profiles — deliberate
 * declarations, slower than ChatGPT, that do NOT borrow ChatGPT's account-tuned
 * numbers. The per-connector behavioral audit (real 429 semantics, binding-quota
 * axis) is the open follow-up (task 1b, out of scope here).
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §3, §9-C5, §10
 */

/**
 * The pacing slice every governor-using (API) connector MUST declare. This is
 * the compile-time-enforced part of the profile: it is a required field on
 * {@link ConnectorHttpGovernorOptions}, so `createConnectorHttpGovernor({ name })`
 * with no profile is a `tsc` error — the spec's "missing field = build error".
 */
export interface ProviderPacingProfile {
  /**
   * THE ONE OWNER NUMBER: the rate ceiling — the fastest inter-request interval
   * (= maximum sustained rate) the AIMD additive-increase loop may ever reach.
   * Required, NO cross-provider default (spec §3): ChatGPT's account-tuned 250ms
   * is meaningless for a provider that sends Retry-After or rate-limits by
   * slowdown rather than 429. Each connector author authors this below their
   * provider's observed behavioral flagging threshold.
   */
  readonly pacingMinIntervalMs: number;
}

/**
 * The terminal-gap slice (spec §10-A). Consumed by the JS terminal-gap
 * classifier (`reference-implementation/server/stores/terminal-gap-classifier.js`),
 * which is enforced at runtime: `maybeTerminateGap` THROWS when this field is
 * absent (a JS seam, so the honest equivalent of a build error is a loud startup
 * throw + the conformance test). A connector with NO declared terminal profile
 * is simply never terminalized — its fillable gaps stay `pending`, never silently
 * borrowing ChatGPT's attempt budget.
 */
export interface ProviderTerminalGapProfile {
  /**
   * Bounded recovery-attempt budget: after this many `in_progress` attempts
   * against a NON-transient error (404/410/permanent-403/401), a gap transitions
   * `pending → terminal`. Per-provider — retrying a deleted resource is pure
   * waste, and the right budget depends on the provider's own error semantics.
   */
  readonly maxRecoveryAttempts: number;
}

/**
 * The cross-run cooldown slice (spec §10-B). Consumed by
 * `reference-implementation/runtime/scheduler-source-pressure-cooldown.ts`.
 * Enforced softly: an absent value disables the no-progress escalation
 * (`recommendedHealthState` never reaches `needs_attention`) rather than
 * borrowing ChatGPT's cycle budget.
 */
export interface ProviderCooldownProfile {
  /**
   * No-progress escalation ceiling: after this many consecutive cooldown cycles
   * with ZERO forward progress and ZERO gap recovery, the connection escalates
   * `cooling_off → needs_attention` (the dead-but-429ing provider). Per-provider —
   * it is derived from the provider's observed recovery-window length.
   */
  readonly maxCooldownCycles: number;
}

/**
 * The full declared ProviderProfile. A connector author declares ONE of these
 * from their own provider's observed behavior; the three control loops each pull
 * their slice. Fields beyond the three slices above (e.g. 429 pressure semantics,
 * quota unit) are named in spec §3 as future profile fields and tracked in the
 * `generalize-adaptive-collection-governor` change (task 1b) — they are NOT yet
 * consumed by a loop, so adding them here without a consumer would be dead
 * declaration. They are listed in the spec, not stubbed here.
 */
export interface ProviderProfile extends ProviderPacingProfile, ProviderTerminalGapProfile, ProviderCooldownProfile {}

// ─── Conservative, UNAUDITED profiles for the governor-using API connectors ──
//
// §9-C5: these are DELIBERATE conservative placeholders, NOT borrows of
// ChatGPT's numbers. The pacing ceiling is intentionally SLOWER than ChatGPT's
// account-tuned 250ms (a connector with an unknown quota should pace politely
// until its real behavior is audited). Terminal/cooldown values are NOT declared
// for these connectors — they opt OUT of those loops (terminalization skipped,
// cooldown escalation disabled) rather than inheriting ChatGPT's budgets, which
// is the honest default for an unaudited provider.
//
// TODO(1b — per-connector behavioral audit, OUT OF SCOPE here): replace each
// placeholder with the provider's REAL observed values (429 semantics, binding
// quota axis, recovery-window length). Until then these are conservative.

/**
 * Conservative shared pacing ceiling (ms) for an UNAUDITED API connector: 1s
 * inter-request interval (~60 req/min). Deliberately ~4× slower than ChatGPT's
 * audited 250ms so an unknown-quota provider paces politely until its real
 * behavioral threshold is observed (task 1b). This is NOT a cross-provider
 * default in the loop — it is an explicit value each connector's profile points
 * at, so the declaration is intentional and grep-able, never an omission.
 */
export const UNAUDITED_CONSERVATIVE_PACING_MIN_INTERVAL_MS = 1000;

/**
 * Build a conservative pacing profile for an unaudited API connector. Each
 * connector calls this EXPLICITLY (it does not inherit by omission), so the
 * value is a declared choice. Override `pacingMinIntervalMs` once the provider's
 * real flagging threshold is audited (1b).
 */
export function unauditedConservativePacingProfile(): ProviderPacingProfile {
  return { pacingMinIntervalMs: UNAUDITED_CONSERVATIVE_PACING_MIN_INTERVAL_MS };
}
