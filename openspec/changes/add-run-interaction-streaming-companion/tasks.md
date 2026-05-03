## 1. OpenSpec And Prior-Art Review

- [x] 1.1 Validate this change with `openspec validate add-run-interaction-streaming-companion --strict`.
- [x] 1.2 Inspect `remote-browser-service`, `remote-browser-sandbox`, and `remote-browser` before choosing the implementation source.
- [x] 1.3 Record the final reuse/fork decision and why n.eko remains out of MVP.

## 2. Streaming Session Security

- [x] 2.1 Add a streaming session store or helper scoped to run id, interaction id, browser/session id, expiry, and token hash.
- [x] 2.2 Reuse existing owner/dashboard auth to mint links where possible.
- [x] 2.3 Add short TTL, single-use or interaction-bound invalidation, and cancellation on interaction resolution.
- [x] 2.4 Add tests for expired, wrong-run, wrong-interaction, resolved-interaction, and unauthenticated access.

## 3. CDP Companion Runtime

- [x] 3.1 Add a streaming companion abstraction around CDP screencast frames.
- [x] 3.2 Add CDP input event mapping for mouse, keyboard, and touch.
- [x] 3.3 Add viewport sizing from viewer dimensions and document supported resize behavior.
- [x] 3.4 Add a fake/mock CDP harness for deterministic tests.

## 4. Dashboard UX

- [x] 4.1 Add owner-facing notification or run interaction affordance when `manual_action` needs browser control.
- [x] 4.2 Add a stream viewer page that maps device-sized input to browser coordinates.
- [x] 4.3 Avoid generic “remote browser” copy; frame the page as satisfying the current connector step.
- [x] 4.4 Ensure resolved/cancelled/expired sessions show clear next steps.

## 5. Integration

- [x] 5.1 Wire manual-action interactions to mint streaming sessions without changing credential/OTP interaction semantics.
- [x] 5.2 Keep streaming companion separate from collector pairing and collector device credentials.
- [x] 5.3 Add run timeline/diagnostic events that show streaming session requested/opened/resolved without leaking sensitive input.

## 6. Validation

- [x] 6.1 Run `pnpm --dir reference-implementation test`.
- [x] 6.2 Run `pnpm --dir reference-implementation run typecheck`.
- [x] 6.3 Run `pnpm --dir apps/web run types:check`.
- [x] 6.4 Run `pnpm --dir apps/web run check`.
- [x] 6.5 Run `pnpm --dir apps/web run build`.
- [x] 6.6 Run `pnpm spec:check`.
