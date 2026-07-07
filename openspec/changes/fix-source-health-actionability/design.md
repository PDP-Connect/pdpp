## Design

The server owns source health semantics. The console may choose layout, but it must not recover from contradictory server verdicts by inventing independent state. This change keeps the fix in the verdict/actionability layer:

- A non-owner `wait` action is valid only when the system is actually handling the work: active run, source-pressure cooldown, or queued recovery with a retry floor.
- A failed/backed-off owner-runnable source is not “collecting”; it should surface a retry action or the true blocker.
- Historical recovered detail gaps are useful progress evidence, but they are not current activity. They must not force `deferred` progress mode after a later failed run.
- Active-run evidence must be derived from durable active-run/read-model evidence, not only from schedule metadata that can be stale or absent.

## Acceptance Checks

- ChatGPT-like state: latest run failed, scheduler backoff/gave-up, no active run, recovered historical detail gaps. The verdict offers `Retry now` and does not say `Collecting — no action needed`.
- Chase-like state: active run row exists. The source renders as active/syncing or owner-attention if an interaction is open, never idle/not measured.
- Source-pressure cooldown still waits instead of encouraging unsafe repeated syncs.
- Stream coverage with no denominator remains `unmeasured`; the fix does not fabricate per-stream completeness.
