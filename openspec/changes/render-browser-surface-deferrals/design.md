## Context

`run_1783394334851` never launched the USAA connector. Its durable timeline recorded `run.browser_surface_requested`, `run.browser_surface_queued`, then `run.browser_surface_deferred` with `wait_reason=lease_wait_timeout`. The runtime behaved correctly by not starting connector work without a secure browser slot, but the owner run UI mapped the run-status handle value `deferred` into the same display class as `failed`.

## Decision

Add `deferred` as a terminal display class for run surfaces. It is inactive for polling and cancellation, but neutral in tone and copy:

- `deferred` means secure-browser capacity/backpressure prevented connector startup.
- `failed` remains reserved for connector/runtime failures and `surface_failed` browser setup failures.
- `cancelled` remains owner/system cancellation.

## Alternatives Considered

- Keep `deferred` mapped to `failed` and rely on timeline details. Rejected: the primary state label is the owner's first read, and the timeline already has enough structured evidence to avoid the false failure label.
- Treat `deferred` as active. Rejected: the runtime already emitted a terminal browser-surface deferral; the attempt is over and should not keep polling or show cancel controls.
- Add connector-specific USAA copy. Rejected: the cause is browser-surface capacity, not source-specific behavior.

## Acceptance Checks

- A run-status handle with `status=deferred` maps to terminal display state `deferred`.
- Browser stream no-assistance fallback renders a browser-slot deferral message instead of run-failed copy.
- `surface_failed` still maps to `failed`.
- Existing active browser states still render as active.
