## Context

The current evidence is strong that stored-credential injection made ChatGPT's credentialed login path visible. It is not definitive on whether repeated app approval is caused by a real ChatGPT session non-acceptance or an over-strict initial probe.

The missing evidence is the state immediately after navigating to ChatGPT and before opening the credential login route. Existing captures cannot answer that question:

- `session-establish:begin` is pre-navigation `about:blank`.
- `runtime-session-established` exists only after acceptance.
- `auth-push-approval-detected` and `auth-after-password-submit` occur after password submission.

## Design

Add a bounded diagnostic at the ChatGPT connector's initial session probe boundary. The diagnostic is emitted as a safe progress event so it lands in the existing run timeline.

The diagnostic contains:

- `object: "chatgpt_auth_probe"`
- `stage: "initial"`
- whether `/api/auth/session` returned a user
- whether the DOM contained logged-in navigation/user-menu indicators
- whether login/signup controls were visible
- a route class such as `home`, `auth`, `conversation`, `about_blank`, `other`, or `unparseable`
- the connector's unchanged decision (`accepted_by_api_session` or `credential_login_required`)

The diagnostic deliberately does not contain raw DOM, screenshots, cookies, bearer tokens, URLs with identifiers, page titles, account names, user ids, conversation ids, conversation text, or credentials.

## Non-Goals

- Do not change the initial auth decision.
- Do not accept DOM-login evidence as sufficient for collection.
- Do not suppress notifications or change push-approval timing.
- Do not add live-test requirements.

## Acceptance Checks

- Tests prove the diagnostic is emitted before credential login when the API session is absent.
- Tests prove a logged-in-looking DOM with no API session is recorded as a diagnostic while the run still follows the existing credential path.
- Tests prove the diagnostic payload is bounded and does not include page title, raw URL, DOM text, credentials, or record payload.
- Existing ChatGPT auth tests continue to pass.
