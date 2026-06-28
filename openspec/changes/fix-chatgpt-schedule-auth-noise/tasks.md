## 1. Runtime metadata

- [x] 1.1 Pass run trigger and automation mode to connector children as bounded env vars.
- [x] 1.2 Add runtime tests proving scheduled/manual metadata is forwarded without leaking secrets.

## 2. ChatGPT auth policy

- [x] 2.1 Add a ChatGPT auth-repair policy that allows interactive login only for owner-started/manual runs.
- [x] 2.2 Make non-manual ChatGPT runs fail before credential submission when the initial API session probe is not active.
- [x] 2.3 Preserve manual login, app approval, OTP, and manual browser fallback behavior.
- [x] 2.4 Update the ChatGPT manifest refresh-policy rationale to describe session-reuse-only automatic refresh.

## 3. Validation

- [x] 3.1 Add focused ChatGPT auto-login tests for scheduled no-prompt and manual auth repair.
- [x] 3.2 Run targeted polyfill connector tests.
- [x] 3.3 Run targeted reference runtime tests.
- [x] 3.4 Run `openspec validate fix-chatgpt-schedule-auth-noise --strict`.

## 4. Live closeout

- [ ] 4.1 Deploy only after local verification and no active connector runs.
- [ ] 4.2 Keep ChatGPT schedules disabled until live validation completes.
- [ ] 4.3 Run a controlled owner-attended manual auth-repair run if the session is invalid.
- [ ] 4.4 Run a scheduled-mode/no-owner-action trial and verify no assistance or interaction rows are emitted.
- [ ] 4.5 Re-enable schedule only if the no-prompt invariant holds.
