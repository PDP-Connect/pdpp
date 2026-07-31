// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single terminal-emission authority for a connector process.
 *
 * A connector's protocol contract allows exactly one terminal `DONE` per
 * run. In practice a connector has several independent code paths that can
 * each decide the run is over: its own success tail, an explicit
 * fail()-style helper (often called from multiple, sometimes deeply nested,
 * call sites), a top-level `main().catch(...)`, and the process-level
 * `unhandledRejection`/`uncaughtException` handlers. The last two are the
 * dangerous ones: the connector's exit handshake does not exit the process
 * synchronously after a terminal DONE — it waits (up to 30 minutes) for the
 * runtime to close stdin, and the process stays fully alive and able to run
 * more code during that wait. A late rejection/exception from that window
 * used to reach one of those handlers AFTER a real DONE had already been
 * written, and each site wrote its own second DONE straight to stdout — the
 * connector_protocol_violation "Connector emitted DONE after DONE".
 *
 * `createTerminalOnceGate()` fixes this at the source: build ONE gate per
 * process, route EVERY terminal-DONE candidate through its `attempt()`, and
 * make it the only thing allowed to call the real emit/exit. Exactly one
 * `attempt()` call is ever allowed to run `onEmit`; every other call —
 * whether concurrent (reentrant, from inside the winning `onEmit`) or later
 * (from an independent path, any time while the process is alive) — is
 * rejected immediately and never touches `onEmit`.
 *
 * ONE BOUNDED ATTEMPT, not retry-until-success. `onEmit` may itself fail —
 * throw synchronously, or return a Promise that rejects (a stdout write
 * that never drains, a broken pipe, anything). This gate does NOT retry a
 * failed `onEmit` with a different payload, because there is no payload
 * that's provably safe against every possible I/O failure — a "plain,
 * minimal" fallback payload can still hit the exact same broken stdout. A
 * failed `onEmit` still permanently closes the gate (state -> "failed"):
 * the caller is told the write did not commit, so it can log visibly and
 * force process exit with a nonzero code through its own means (NOT by
 * calling `attempt()` again — that WILL be rejected). This trades "maybe
 * the retry payload gets through" for a bounded, deterministic outcome:
 * every path through the gate either commits exactly one DONE, or ends in
 * an explicit, visible failure-to-terminate that the caller must act on
 * directly. That is a strictly better failure mode than either the
 * original double-DONE bug or a naive rollback-and-hope-a-retry-differs
 * design (which the independent checker flagged: rolling back on
 * synchronous failure only, leaving async rejection outside the gate's
 * model, does not prevent the very same failure recurring on retry, and
 * does not cover a rejected write Promise at all).
 */

/** Resolution of exactly one `attempt()` call across the gate's lifetime. */
export type TerminalOnceOutcome =
  | { kind: "won"; result: "committed" }
  | { kind: "won"; result: "failed"; error: unknown }
  | { kind: "lost" };

export interface TerminalOnceGate<TDonePayload> {
  /**
   * Attempt to become the run's one terminal emission.
   *
   * Returns synchronously with `{ kind: "lost" }` if any other `attempt()`
   * call — earlier, or currently in flight (including a reentrant call
   * made from inside the winning call's own `onEmit`) — already holds or
   * has held the slot. A losing call never invokes `onEmit` and never
   * throws.
   *
   * If this call wins the slot, it invokes `onEmit(payload)` and returns a
   * Promise that resolves once `onEmit` settles (whether it threw
   * synchronously, returned synchronously, or returned a Promise that
   * settled asynchronously):
   *   - `{ kind: "won", result: "committed" }` — `onEmit` completed
   *     without error. The terminal DONE is on record; no other
   *     `attempt()` call will ever win.
   *   - `{ kind: "won", result: "failed", error }` — `onEmit` threw or its
   *     returned Promise rejected. The gate is STILL permanently closed
   *     (no more attempts can win — see the module doc for why this
   *     primitive does not retry). The caller MUST treat this as "the run
   *     did not terminate cleanly" and take its own deterministic action
   *     (log + force a nonzero exit); it must not call `attempt()` again.
   */
  attempt: (payload: TDonePayload) => Promise<TerminalOnceOutcome>;
  /** True once a call has won the slot (`committed` OR `failed` — either
   *  way, no further attempt can ever win). */
  readonly settled: boolean;
}

/**
 * @param onEmit Called for whichever `attempt()` call wins the slot. May
 *   throw synchronously or return a Promise; either failure mode is
 *   captured as `result: "failed"` on the returned outcome. Do the real
 *   emit-then-exit-handshake work here — this is the only place that
 *   should ever write a terminal DONE line or start process exit.
 */
export function createTerminalOnceGate<TDonePayload>(
  onEmit: (payload: TDonePayload) => void | Promise<void>
): TerminalOnceGate<TDonePayload> {
  // Claimed synchronously on the winning call, before onEmit runs at all —
  // this is what makes a reentrant call (made synchronously from inside
  // onEmit) lose: by the time such a call reaches this check, `claimed` is
  // already true.
  let claimed = false;
  let settled = false;

  return {
    async attempt(payload: TDonePayload): Promise<TerminalOnceOutcome> {
      if (claimed) {
        return { kind: "lost" };
      }
      claimed = true;
      try {
        await onEmit(payload);
        settled = true;
        return { kind: "won", result: "committed" };
      } catch (error) {
        settled = true;
        return { kind: "won", result: "failed", error };
      }
    },
    get settled() {
      return settled;
    },
  };
}
