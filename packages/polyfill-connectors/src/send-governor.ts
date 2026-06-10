/**
 * The single pre-flight send-governor seam.
 *
 * Doctrine (design-notes/provider-rate-governance-convergence-2026-06-10.md,
 * docs/research/client-rate-governance-prior-art-2026-06-10.md): a request path
 * to one provider has exactly ONE pre-flight send governor. Rate OR concurrency
 * is the primary governing dimension — never both as independent gates. Two
 * independent pre-flight waiters over the same upstream is the Temporal /
 * "Option C" anti-pattern: their delays compound and produce non-obvious
 * combined behavior.
 *
 * A `SendGovernor` is the only object a request path is permitted to `await`
 * before transmitting. Everything else in the run-control stack — the run
 * budget, the retry budget, the circuit breaker — is a *decision* (synchronous
 * admit/deny) or a post-failure backoff, not a second pre-flight wait. GCRA
 * pacing, when present, contributes a delay *signal* the single governor folds
 * into its own wait; it does not run its own `await`.
 *
 * Making incorrect composition hard to express: a request path takes a single
 * `SendGovernor`. There is deliberately no combinator that sequences two
 * governors into one — composing two pre-flight waits is not expressible
 * through this interface. The {@link PreflightWaitProbe} test seam pins that the
 * runtime performs exactly one pre-flight wait per admitted request.
 */
export interface SendGovernor {
  /**
   * The single pre-flight wait. Resolves when the request may be transmitted.
   * This is the ONLY sanctioned `await`-before-send in a request path.
   */
  acquire(): Promise<void>;
}

/**
 * A pre-flight wait signal a decision layer (e.g. the provider-budget
 * controller, holding a GCRA pacing bucket) can hand to the single
 * {@link SendGovernor} instead of sleeping itself. The governor folds the hint
 * into its own single wait, so pacing influences velocity without becoming a
 * second gate.
 */
export interface SendDelayHint {
  /**
   * Compute the pre-flight delay (ms) this signal would impose and advance any
   * internal state (e.g. a GCRA Theoretical Arrival Time) as if a request were
   * admitted now. Pure of any sleep: the caller — the single governor — owns
   * the wait. Returns 0 when no delay is owed.
   */
  nextDelayMs(): number;
}

/**
 * Test/observability seam that counts pre-flight wait sources on a request path.
 *
 * A correctly-converged path increments this exactly once per admitted request
 * (the single {@link SendGovernor}). Two increments on one request mean two
 * pre-flight gates are stacked — the spec violation the convergence forbids.
 * Wrap each sleep call site with {@link wrap}; the stacking regression test
 * asserts `count === 1` over a single admitted request.
 */
export class PreflightWaitProbe {
  private _count = 0;
  private _totalMs = 0;

  /** Number of pre-flight wait sources that fired since the last reset. */
  get count(): number {
    return this._count;
  }

  /** Total pre-flight wait time (ms) observed since the last reset. */
  get totalMs(): number {
    return this._totalMs;
  }

  reset(): void {
    this._count = 0;
    this._totalMs = 0;
  }

  /**
   * Wrap a sleep so a non-zero wait is counted as one pre-flight wait source.
   * Zero-or-negative waits are no-ops and are not counted: a governor that
   * computes a 0ms delay did not actually gate the request.
   */
  wrap(sleep: (ms: number) => void | Promise<void>): (ms: number) => Promise<void> {
    return async (ms: number): Promise<void> => {
      if (ms > 0) {
        this._count += 1;
        this._totalMs += ms;
      }
      await sleep(ms);
    };
  }
}
