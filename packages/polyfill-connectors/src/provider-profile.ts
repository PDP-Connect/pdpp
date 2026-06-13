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
 * connectors (github/notion/oura/spotify/strava/ynab) now each carry an AUDITED
 * pacing ceiling derived from THAT provider's documented rate limit — the WI-1b
 * per-connector behavioral audit. Each value traces to a provider doc URL in its
 * factory below; the derivation (documented sustained rate → chosen ceiling +
 * safety margin) is recorded in
 * docs/research/per-connector-rate-profiles-2026-06-13.md. None of the six emit
 * detail gaps, so none declares a terminal-gap (§10-A) or cooldown (§10-B)
 * profile — they legitimately use the safe shared defaults (see that doc).
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §3, §9-C5, §10
 *      docs/research/per-connector-rate-profiles-2026-06-13.md (WI-1b derivations)
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

// ─── Audited per-connector pacing profiles (WI-1b, §3 / §9-C5) ───────────────
//
// Each value below is a DECLARED ceiling derived from THAT provider's documented
// rate limit — never a borrow of ChatGPT's 250ms, never a shared default. The
// ceiling is the FASTEST inter-request interval the AIMD may reach; per spec §3
// it is set AT OR BELOW the provider's documented sustained rate (a safety prior:
// even a fully-accelerated controller stays under the provider's budget). The
// derivation (documented limit → chosen ceiling + margin) for every connector is
// recorded in docs/research/per-connector-rate-profiles-2026-06-13.md. All six
// connectors are single-threaded (concurrency 1) and read-only, so the read/
// primary limit — not upload/content-creation secondary limits — is the binding
// axis. None of the six emits detail gaps, so none declares a terminal-gap
// (§10-A) or cooldown (§10-B) profile; they use the safe shared defaults.

/**
 * GitHub — 1000ms (60 req/min). Documented primary limit: 5,000 requests/hour for
 * authenticated users (=720ms / ~83 req/min at the limit); 1000ms is ~72% of that
 * ceiling. Read-only, single-threaded, so the secondary content-creation /
 * concurrency limits do not bind.
 * Doc: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */
export function githubPacingProfile(): ProviderPacingProfile {
  return { pacingMinIntervalMs: 1000 };
}

/**
 * Notion — 500ms (120 req/min). Documented limit: an average of 3 requests/second
 * per integration, bursts allowed (=333ms / 180 req/min at the average); 500ms is
 * 2 req/s = ~67% of the documented average, sitting under the average (not just
 * the burst peak).
 * Doc: https://developers.notion.com/reference/request-limits
 */
export function notionPacingProfile(): ProviderPacingProfile {
  return { pacingMinIntervalMs: 500 };
}

/**
 * Oura — 250ms (240 req/min). Documented limit: 5,000 requests per 5-minute window
 * (=16.67 req/s, 60ms / ~1000 req/min at the limit); 250ms is 4 req/s = ~24% of
 * that ceiling — a deliberate 4× margin (we do not push to the 60ms hardware
 * ceiling: daily-grain wellness data does not need 1000 req/min and the wide
 * margin guards an undocumented per-account throttle).
 * Doc: https://cloud.ouraring.com/docs/error-handling
 */
export function ouraPacingProfile(): ProviderPacingProfile {
  return { pacingMinIntervalMs: 250 };
}

/**
 * Spotify — 500ms (120 req/min). Spotify computes its limit over a rolling 30s
 * window and does NOT publish the exact request count (it differs by app mode);
 * the commonly-observed development-mode figure is ~180 req/min (=333ms at the
 * cited rate). 500ms is ~67% of that — margin-heavy on purpose because the true
 * limit is undisclosed; the connector honors Retry-After on 429.
 * Doc: https://developer.spotify.com/documentation/web-api/concepts/rate-limits
 */
export function spotifyPacingProfile(): ProviderPacingProfile {
  return { pacingMinIntervalMs: 500 };
}

/**
 * Strava — 10000ms (6 req/min). The connector reads only NON-UPLOAD endpoints,
 * whose default limit is 100 requests / 15 min + 1,000 / day (=0.111 req/s,
 * 9000ms / ~6.67 req/min sustained on the binding 15-min window). 10000ms is set
 * BELOW that sustained rate so a fully-accelerated controller can never drain the
 * 100-req window faster than it refills — the most conservative of the six by
 * design (tightest window + explicit ban warning). A real owner sync is a handful
 * of paginated requests, so the slow ceiling costs nothing on the real workload.
 * Doc: https://developers.strava.com/docs/rate-limits/
 */
export function stravaPacingProfile(): ProviderPacingProfile {
  return { pacingMinIntervalMs: 10_000 };
}

/**
 * YNAB — 20000ms (3 req/min). Documented limit: 200 requests per hour per access
 * token over a rolling 1-hour window (=0.0556 req/s, 18000ms / ~3.33 req/min
 * sustained). 20000ms is set BELOW that sustained rate so even a long run stays
 * under the 200/hr budget at the ceiling. A typical YNAB run is only tens of
 * requests (~7×budgets + one per walked month), so it finishes in a minute or two
 * far under budget; the conservative ceiling only binds a pathological run.
 * Doc: https://api.ynab.com/ (Usage → Rate Limiting)
 */
export function ynabPacingProfile(): ProviderPacingProfile {
  return { pacingMinIntervalMs: 20_000 };
}
