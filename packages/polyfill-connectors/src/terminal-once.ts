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
 * dangerous ones: `flushAndExitAfterRuntimeAck` (connector-exit.ts) does not
 * exit the process synchronously after a terminal DONE — it waits (up to 30
 * minutes) for the runtime to close stdin, and the process stays fully
 * alive and able to run more code during that wait. A late
 * rejection/exception from that window (stray IMAP socket teardown noise,
 * an unawaited timer, anything) used to reach one of those handlers AFTER a
 * real DONE had already been written, and each site wrote its own second
 * DONE straight to stdout — the connector_protocol_violation
 * "Connector emitted DONE after DONE".
 *
 * Coordinating each call site individually (e.g. a marker exception one
 * fail()-style helper throws, checked only by the one catch that helper
 * feeds) is exactly the kind of per-call-site discipline that misses a
 * path — the marker only protects the path that throws it, not every other
 * independent terminal-decision site in the module.
 *
 * `createTerminalOnceGate()` fixes this at the source: build ONE gate per
 * process, route EVERY terminal-DONE candidate — success or failure, from
 * any call site — through its `attempt()`, and make it the only thing
 * allowed to call the real emit/exit. The first call wins unconditionally;
 * every later call (from any other path, at any time while the process is
 * alive) is a no-op on the wire, but the caller can still be told whether
 * its attempt won or was dropped, so failure information is never silently
 * discarded before the real terminal happened.
 */
export interface TerminalOnceGate<TDonePayload> {
  /**
   * Attempt to emit the terminal DONE. Returns `true` if this call is the
   * one that wins (and `onEmit` was invoked), `false` if a terminal was
   * already emitted (and `onEmit` was NOT invoked — no second DONE reaches
   * the wire). Callers MUST NOT build their own fallback emission when this
   * returns `false`; the run is already over.
   */
  attempt: (payload: TDonePayload) => boolean;
  /** True once any attempt() call has won. */
  readonly emitted: boolean;
}

/**
 * @param onEmit Called exactly once, with the payload from whichever
 *   `attempt()` call wins the race. Do the real `emit()` + process-exit work
 *   here — this is the only place in the connector that should ever write a
 *   terminal DONE line.
 */
export function createTerminalOnceGate<TDonePayload>(
  onEmit: (payload: TDonePayload) => void
): TerminalOnceGate<TDonePayload> {
  let emitted = false;
  return {
    attempt(payload: TDonePayload): boolean {
      if (emitted) {
        return false;
      }
      emitted = true;
      onEmit(payload);
      return true;
    },
    get emitted() {
      return emitted;
    },
  };
}
