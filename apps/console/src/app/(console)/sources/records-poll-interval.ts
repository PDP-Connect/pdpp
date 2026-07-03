/**
 * Poll cadence for the records dashboard, factored out of the React effect so
 * the load-bearing decision ("how often does a quiet page reconcile with the
 * live API?") is unit-testable without a JSX render harness — the same pattern
 * `connector-row.test.ts` uses for `formatNextAction`.
 *
 * The dashboard route is `force-dynamic` + `no-store`, so every soft refresh is
 * as live as the API. The only question is *cadence*:
 *
 * - While a scheduler run is active, poll fast so the operator watches progress
 *   land in near-real-time.
 * - While quiet, still poll — slowly — so background state that changes with no
 *   active run (health re-derivation, version-stats projection rebuilds, and
 *   push-mode local-device ingest, which by construction never has an active
 *   run) reconciles itself instead of silently lagging until a manual reload.
 *
 * Intentional load tradeoff: an always-on idle heartbeat means one soft
 * `router.refresh()` every {@link IDLE_POLL_MS} per open dashboard tab. That is
 * the deliberate price of a self-reconciling quiet page; a soft refresh of a
 * single `no-store` route is cheap and React reconciles unchanged DOM with no
 * visible flash. This is a freshness/load trade, stated rather than silent.
 */

/** Fast cadence while a scheduler run is active — watch progress land live. */
export const RUNNING_POLL_MS = 3000;

/**
 * Slow idle heartbeat so a quiet page still reconciles with the live API
 * (background health re-derivation, version-stats dirty/rebuild, push-mode
 * local-device ingest). Deliberately an order of magnitude slower than the
 * active cadence to keep idle load negligible.
 */
export const IDLE_POLL_MS = 30_000;

/** Poll interval (ms) for the records page given whether a run is active. */
export function recordsPollIntervalMs(running: boolean): number {
  return running ? RUNNING_POLL_MS : IDLE_POLL_MS;
}
