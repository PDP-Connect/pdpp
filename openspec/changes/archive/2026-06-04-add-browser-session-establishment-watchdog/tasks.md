# Tasks: add-browser-session-establishment-watchdog

## 1. OpenSpec artifacts

- [x] Write `proposal.md`
- [x] Write `design.md`
- [x] Write `tasks.md`
- [x] Write `specs/polyfill-runtime/spec.md` delta
- [x] `openspec validate add-browser-session-establishment-watchdog --strict` passes

## 2. Bounded manual-action metadata read

- [x] Add `withDeadline(promise, ms, onTimeout?)` helper to `browser-handoff.ts`
- [x] Race `page.title()` in `readManualActionPageMetadata` against a bounded deadline
- [x] Read `page.url()` first so the URL survives a metadata timeout
- [x] Emit a compact stderr diagnostic on metadata timeout; never throw

## 3. Session-establishment checkpoints

- [x] Add `SessionCheckpointFn` and `EnsureSessionArgs.checkpoint`
- [x] Runtime emits `session-establish:begin` / `session-establish:probe` framing checkpoints
- [x] Checkpoint records last-progress marker (timestamp) and triggers best-effort diagnostic capture
- [x] Wire Amazon `ensureAmazonSession` phases to the checkpoint hook

## 4. Session-establishment watchdog

- [x] Add a checkpoint-progress-keyed watchdog around `establishSession` in `connector-runtime.ts`
- [x] Deadline from `PDPP_SESSION_ESTABLISH_WATCHDOG_MS` (default 120000 ms)
- [x] Pause the watchdog while an interaction is open; resume (reset) on resolve
- [x] On expiry: finalize diagnostics, reject with `*_session_establish_timeout` TerminalError, release browser
- [x] Timer is `unref`-ed and cleared on success
- [x] Bound `captureBrowserPage`'s DOM snapshot so a teardown capture on a wedged page cannot re-hang teardown

## 5. Tests

- [x] `browser-handoff` metadata-timeout test: interaction still emits/registers with URL on `page.title()` hang
- [x] `withDeadline` unit tests (work wins; timeout wins)
- [x] runtime watchdog test: never-checkpointing `ensureSession` fails closed + finalizes diagnostics + releases
- [x] runtime watchdog test: steadily-checkpointing flow is NOT killed past the deadline
- [x] runtime watchdog test: watchdog paused while interaction open
- [x] runtime test: `captureBrowserPage` returns within its deadline when `captureDom` hangs
- [x] amazon test: `ensureAmazonSession` invokes checkpoint hook at each auth phase (fake page/sendInteraction)

## 6. Validation

- [x] `node --test` for new + affected files (browser-handoff, connector-runtime, amazon)
- [x] `pnpm --dir packages/polyfill-connectors run typecheck`
- [x] `pnpm --dir packages/polyfill-connectors run check`
- [x] `openspec validate add-browser-session-establishment-watchdog --strict`
- [x] `openspec validate --all --strict`
- [x] `git diff --check`

## Acceptance checks

1. Manual-action metadata read with a hung `page.title()` still emits/registers the interaction (URL preserved, stderr diagnostic written).
2. Never-checkpointing session establishment is failed closed by the watchdog with a `*_session_establish_timeout` terminal DONE, diagnostics finalized, browser released.
3. Steadily-checkpointing establishment is not killed even past the deadline.
4. Watchdog is paused while an interaction is open.
5. Amazon auto-login invokes the checkpoint hook at each auth phase.
6. Typecheck, lint, and `openspec validate --all --strict` pass.

## Owner-only residual

- [ ] Live Amazon re-run validation that a same-shape wedge now produces a terminal failure + retained establishment-phase diagnostics rather than an indefinitely-active run (owner-only; live deployment; out of this lane's scope).
