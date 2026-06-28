# Design: gate scheduled auth-required runs

## Evidence

Run history shows scheduled ChatGPT runs completed without owner notifications through 2026-06-25 11:43Z by reusing an active session. The first later failures reported `CHATGPT_USERNAME/PASSWORD not set`, proving the browser/API session was no longer sufficient before stored credentials were injected into scheduled runs.

PR #76 (`90655ea87`) added ChatGPT to the static-secret injection registry. The live deploy note for that PR records that the first credentialed ChatGPT run progressed past `CHATGPT_USERNAME/PASSWORD not set` and emitted `run.assistance_requested`: ChatGPT sent an app approval notification.

PR #94 made scheduled runs session-reuse-only. The live validation run `run_1782620206401` emitted no assistance or interaction, but its known gap used `chatgpt_preprogress_failure: runtime_exception` with `retry_on_connector_upgrade`, even though the message was `chatgpt_session_required`. The root cause is a classifier regex using a word boundary before `session_required`; underscores are word characters, so `chatgpt_session_required` does not match.

## Design

The fix reuses existing machinery instead of adding a new auth-recovery subsystem.

1. ChatGPT terminal normalization recognizes provider-scoped auth tokens such as `chatgpt_session_required` and `chatgpt_session_failed`.
2. Managed scheduled runs preserve enough terminal evidence for the scheduler to distinguish owner-auth-required failures from generic failures.
3. When a non-manual managed run proves owner auth repair is required, the scheduler marks the existing needs-human gate for that connector instance. Later scheduled ticks skip through the existing gate until an owner manual run clears it.

## Alternatives

- Revert ChatGPT scheduled credential injection entirely. This would stop app-approval notifications, but it would also remove the manual/controller path that uses stored credentials to repair auth.
- Add a new ChatGPT-specific recovery table. This duplicates existing connection-health, structured-attention, and scheduler needs-human concepts.
- Leave PR #94 as-is. This stops notification spam but can leave a scheduled connection repeatedly failing quietly without a first-class repair state.

## Acceptance checks

- ChatGPT `chatgpt_session_required` terminal errors map to `refresh_credentials`.
- A scheduled managed run whose terminal event carries credential/auth-required evidence marks the connector instance as needing owner attention.
- The next scheduled tick skips through the existing needs-human gate instead of relaunching the connector.
- A manual owner run clears the needs-human gate and can repair the session.
