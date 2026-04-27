// Pure helper that decides the terminal_reason for a connector run from
// the four inputs the close handler observes. Extracted so the
// run-terminal contract can be unit-tested without spawning a child.
//
// Contract (mirrors openspec/changes/harden-reference-runtime-reliability/
//   specs/reference-implementation-architecture/spec.md):
//
//   - If the connector emitted a DONE message, the terminal_reason
//     reflects the connector's reported status:
//       - 'failed'     → 'connector_reported_failed'
//       - 'cancelled'  → 'connector_reported_cancelled'
//       - 'succeeded'  → null (no terminal reason on a clean success)
//
//   - Otherwise, if the run is failed, the runtime SHALL prefer the
//     stdin-closed reason when one was recorded. This makes the
//     observed-EPIPE-on-write path observably distinct from a connector
//     that exited cleanly without DONE for some other reason.
//
//   - Otherwise, if the run failed without DONE and without an observed
//     stdin-close write, the existing generic reason
//     'connector_exit_without_done' applies.
//
// `phase` is the protocol phase the failed write was attempting
// ('start' | 'interaction_response') so the outcome carries enough
// context to debug a Docker/--watch crash mode without re-running.

export function deriveTerminalReason({
  doneMessage,
  finalStatus,
  childStdinClosedReason,
  childStdinClosedAtPhase,
} = {}) {
  if (doneMessage) {
    if (doneMessage.status === 'failed') {
      return { reason: 'connector_reported_failed', phase: null };
    }
    if (doneMessage.status === 'cancelled') {
      return { reason: 'connector_reported_cancelled', phase: null };
    }
    return { reason: null, phase: null };
  }

  if (finalStatus !== 'failed') {
    return { reason: null, phase: null };
  }

  if (childStdinClosedReason) {
    return {
      reason: childStdinClosedReason,
      phase: childStdinClosedAtPhase || 'unknown',
    };
  }

  return { reason: 'connector_exit_without_done', phase: null };
}
