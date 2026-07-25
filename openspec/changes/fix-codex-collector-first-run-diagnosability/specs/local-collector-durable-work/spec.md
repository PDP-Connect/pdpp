## ADDED Requirements

### Requirement: A connector child's own terminal failure message is authoritative evidence

When a connector child process exits non-zero after having already emitted
a terminal `DONE {status: "failed", error: {message}}` message, the local
collector runner SHALL treat that message as the authoritative failure
detail for the resulting run failure and any recorded
`connector_child_failure` gap unit — it SHALL NOT be discarded in favor of
a generic exit-code-and-stderr-derived message when the connector's own
message is available.

A connector's own DONE error message reflects the connector's structured
diagnosis of why it could not complete (e.g. a missing precondition,
credential state, or upstream failure it can name precisely) and is
reached via the connector protocol's stdout channel, not stderr — a runner
that inspects only `stderr` when deciding the failure detail can silently
discard this diagnosis for any well-behaved connector that reports its own
failure via DONE rather than writing to stderr. This SHALL NOT change when
a non-zero exit is treated as a run failure — only what detail is reported
for that failure.

This requirement applies to the case where the child protocol was well-formed enough to reach a terminal DONE before exiting. A child that crashes without ever emitting a terminal DONE (no structured self-diagnosis available) SHALL continue to have its failure detail derived from the exit code and any captured stderr, unchanged.

#### Scenario: A connector reports its own failure reason via terminal DONE, then exits non-zero with no stderr output

- **WHEN** a connector child emits `{"type": "DONE", "status": "failed", "error": {"message": "<reason>"}}` on stdout and subsequently exits with a non-zero status
- **AND** the child wrote nothing (or nothing useful) to stderr
- **THEN** the runner SHALL raise the run failure using `<reason>` as the failure detail
- **AND** the durably queued `connector_child_failure` gap unit's own stored detail field SHALL contain `<reason>`, not a generic "unknown error" or an empty stderr-derived string — this SHALL be verified by inspecting the queued gap unit's metadata directly, not only the thrown run-failure error, since the two are populated by separate code paths that could regress independently

#### Scenario: A connector's own DONE error message is sanitized before reaching durable storage

- **WHEN** a connector child's terminal `DONE` error message contains secret-shaped text (e.g. a keyed credential, a one-time code, or a long opaque token) as part of its own diagnostic message
- **THEN** the runner SHALL apply the same detail-sanitization the existing exit-code/stderr-derived path already applies before persisting the message
- **AND** the durably queued `connector_child_failure` gap unit's detail SHALL NOT contain the raw secret-shaped substring
- **AND** this requirement concerns connector-authored diagnostic text only — it does NOT authorize including record payload or credential content in a DONE error message in the first place

#### Scenario: A connector crashes without emitting a terminal DONE

- **WHEN** a connector child exits non-zero without ever having emitted a terminal `DONE` message (e.g. an unhandled exception before the protocol starts, or a supervisor kill)
- **THEN** the runner SHALL derive the failure detail from the exit code and any captured stderr, exactly as before this requirement
- **AND** existing stderr redaction/sanitization of secrets in that derived detail SHALL be unaffected

#### Scenario: A connector exits non-zero after a successful terminal DONE

- **WHEN** a connector child emits `{"type": "DONE", "status": "succeeded"}` and then exits with a non-zero status (e.g. an unrelated post-completion crash)
- **THEN** the runner SHALL NOT fabricate or attribute a `DONE` error message that was never sent
- **AND** the failure detail SHALL fall back to the exit-code/stderr-derived message, since no authoritative failure reason exists to prefer
