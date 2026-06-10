## Why

A browser-backed connector run can wedge during session establishment — after the browser surface is leased and `run.started` is recorded, but before any RECORD, INTERACTION, or terminal event is emitted. In the observed case an Amazon run sat in `controller_active_runs` indefinitely: the connector child was blocked inside `ensureSession` on a Playwright call (page metadata read or navigation) against a wedged renderer, so no INTERACTION ever reached the controller and no terminal DONE was ever written.

The existing mid-wait surface-loss detector (`detect-midwait-browser-surface-loss`) only engages once an interaction is open. It cannot cover this earlier window, because the connector never gets far enough to emit an interaction. Fixture capture was enabled but only retained `runtime-new-page` / `about:blank`, because the run hung before the next capture checkpoint. The run was unobservable, unbounded, and unrecoverable from the runtime's side.

## What Changes

- Bound the manual-action page-metadata read in `browser-handoff.ts` so a wedged `page.title()` cannot prevent the INTERACTION from being emitted. On timeout the interaction still registers/emits with whatever metadata is available, and the timeout is surfaced as a compact diagnostic rather than swallowed.
- Add a session-establishment checkpoint hook to the connector runtime so the runtime and connector authors can mark auth/session phases (probe, sign-in loaded, email submit, password submit, 2FA decision, final verify). Each checkpoint produces a durable diagnostic capture so a hang no longer leaves only `about:blank`.
- Wire Amazon's auto-login phases to the checkpoint hook as the first consumer.
- Add a bounded session-establishment watchdog to the connector runtime. If session establishment makes no checkpoint progress within a bounded deadline, the runtime finalizes trace/capture artifacts, fails the run fail-closed with a terminal DONE, and releases the browser so the run cannot sit active indefinitely.
- Bound the runtime's per-checkpoint DOM capture so a diagnostic snapshot taken during teardown of a wedged run cannot itself re-hang teardown (the CDP-backed reads inside `captureDom` have no per-call timeout).

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `polyfill-runtime`: add requirements that the browser runtime SHALL bound manual-action metadata reads, SHALL checkpoint session-establishment phases with durable diagnostics, and SHALL bound session establishment with a watchdog that fails closed.

## Impact

- Affects `packages/polyfill-connectors/src/browser-handoff.ts` (bounded `readManualActionPageMetadata`; new `withDeadline` helper export for tests).
- Affects `packages/polyfill-connectors/src/connector-runtime.ts` (session-establishment checkpoint plumbing + watchdog around `establishSession`; `EnsureSessionArgs.checkpoint`; bounded `captureBrowserPage` DOM snapshot).
- Affects `packages/polyfill-connectors/src/auto-login/amazon.ts` (emit checkpoints at each auth phase).
- Adds tests under `packages/polyfill-connectors/src/` and `packages/polyfill-connectors/connectors/amazon/`.
- Does not change PDPP Core, resource-server public APIs, grant semantics, connector manifests, the controller spine event set, the Patchright/n.eko stealth posture, connector scraping logic, `packages/remote-surface`, Docker compose, or deployment scripts.
- Does not touch the live wedged run, the live deployment, or any container lifecycle.

## Residual Risks

- Live Amazon re-run validation is owner-only and out of this lane's scope. The
  watchdog, checkpoints, bounded metadata read, and bounded teardown capture are
  proven offline by `connector-runtime-session-watchdog.test.js`,
  `browser-handoff.test.js`, and the Amazon checkpoint test (a never-checkpointing
  `ensureSession` fails closed with `*_session_establish_timeout`, a
  steadily-checkpointing flow survives past the deadline, the watchdog pauses on
  an open interaction, `captureBrowserPage` returns within its deadline when
  `captureDom` hangs, and `ensureAmazonSession` checkpoints each auth phase). What
  remains unproven is the deployment-side behavior: that a same-shape live wedge
  now yields a terminal failure with retained establishment-phase diagnostics
  instead of an indefinitely-active run. This requires an owner-attended live
  Amazon run against the deployment and is tracked as the lone open box in
  `tasks.md`.
