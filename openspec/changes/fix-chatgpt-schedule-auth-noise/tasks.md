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

- [x] 4.1 Deploy only after local verification and no active connector runs.
- [x] 4.2 Verify invalid-session scheduled behavior without owner interaction.
- [x] 4.3 Run a controlled manual proof run to classify the stale stored credential.
- [x] 4.4 Run a scheduled-mode/no-owner-action trial and verify no assistance or interaction rows are emitted.
- [x] 4.5 Leave the schedule enabled only after the no-prompt invariant holds.

Live evidence, 2026-07-01:

- Deployed `c48887188` as `v0.18.12-29-gc48887188` after confirming no active connector runs.
- Manual proof run `run_1782883228302` failed with `chatgpt_stored_credential_rejected`, marked the stored credential rejected, and emitted no new open attention row.
- The next scheduled attempt at `2026-07-01T05:37:43.481Z` failed before browser launch/interaction with `static_secret_credential_unavailable` because the stored credential was already rejected.
- No ChatGPT `connector_attention_records` were created after `2026-07-01T05:20:00Z`; the scheduled trial emitted no `ASSISTANCE`, no `INTERACTION`, and no browser action prompt.
