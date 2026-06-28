# Tasks: gate-scheduled-auth-required-runs

## 1. Terminal classification

- [x] 1.1 Fix ChatGPT auth-failure normalization so `chatgpt_session_required` and `chatgpt_session_failed` classify as `refresh_credentials`.
- [x] 1.2 Add regression coverage for provider-prefixed session-required/session-failed messages.

## 2. Scheduled managed-run gating

- [x] 2.1 Preserve managed-run terminal failure evidence from the controller spine event into the scheduled run result.
- [x] 2.2 Mark the existing needs-human scheduler gate when a non-manual managed run terminates with credential/auth repair evidence.
- [x] 2.3 Prove a follow-up scheduled tick skips instead of relaunching while the gate is set.
- [x] 2.4 Prove a manual run clears the gate.

## 3. Validation

- [x] 3.1 Run `openspec validate gate-scheduled-auth-required-runs --strict`.
- [x] 3.2 Run ChatGPT connector tests covering terminal normalization.
- [x] 3.3 Run scheduler/controller tests covering managed-run auth-required gating.
