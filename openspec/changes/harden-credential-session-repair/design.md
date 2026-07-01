## Context

The earlier schedule-auth change correctly separated automatic session reuse from owner-attended auth repair. It did not model the lifecycle of stored connection-scoped credentials after a provider definitively rejects them.

The current failure is a different layer:

- The credential table can represent only `active` and `revoked`.
- A provider-rejected username/password remains `active`.
- ChatGPT's password-submit flow can observe an incorrect-password page but currently falls through to app/browser assistance rather than emitting a stored-credential rejection.
- The runtime accepts only `message` and `retryable` in `DONE.error`, so a connector cannot send a stable credential-rejection code.
- Browser-session repair copy says "no credentials are stored," which is only true for the browser repair step, not necessarily for the connection's optional stored login secret.

## Decisions

### 1. Stored credential state owns provider rejection

The credential store adds `status = 'rejected'` plus `rejected_at` and `rejection_reason` metadata. `revoked` remains owner/operator intent. `rejected` means the provider rejected the configured credential and the reference SHALL NOT recover it for run injection until explicit owner capture/rotation writes a new active credential.

This keeps the durable truth in the credential lifecycle instead of inferring from stale attention rows or dashboard copy.

### 2. Runtime error codes carry bounded cause

Failed connector `DONE.error` may include a bounded non-secret `code`. The runtime validates and persists it as runtime-owned terminal evidence. The initial code needed here is `credential_rejected`.

The connector message remains a safe human diagnostic. The code is the actionability signal.

### 3. Mark rejected only after actual stored-secret use

The controller marks a stored credential rejected only when:

- the run was supplied a non-empty connection-scoped static-secret env fragment; and
- the terminal connector error has code `credential_rejected`.

This prevents owner-typed one-time interaction failures from mutating stored credential state.

### 4. Browser-session repair does not silently store passwords

If a browser-session connector has no active stored login secret, an owner-attended manual repair may still open the secure browser and let the owner log in. The reference captures the browser session state, not the password typed into the provider page.

For browser-session connectors, a rejected optional stored login secret is ignored for run-env injection. A repaired browser session can make later scheduled runs quiet again without requiring password storage.

### 5. Automatic ChatGPT remains session-reuse-only

Automatic ChatGPT runs still probe the existing session and stop before interactive auth repair when the session is inactive. This change does not re-enable background password submission or app-approval prompting.

### 6. Scheduled stored-credential repair is a deferred state

When scheduled run assembly cannot recover a connection-scoped stored credential because it is missing, revoked, or provider-rejected, the scheduler marks that connection as needs-human and records a skipped repair state instead of a failed connector run. This preserves the fail-closed guarantee: no connector child is spawned and no deployment-wide credential fallback is possible. It also prevents the scheduler from deepening failure/backoff history every hour for an already-known owner-repair condition.

Other resolver errors remain failed run records. A helper wiring bug, unsupported connector classification, or credential-store outage is not owner repair evidence and should not be silently suppressed.

## Alternatives

### Age out owner-action rows

Rejected. Attention lifecycle is a projection/action surface; age cannot distinguish "stale UI artifact" from "credential still invalid." Credential state must own credential validity.

### Revoke rejected credentials

Rejected. `revoked` is owner/operator intent. Provider rejection is not a revoke; it should be repairable by explicit capture/rotation and auditable as provider evidence.

### Treat ChatGPT as a special case only

Rejected. ChatGPT is the proof case, but the defect is in shared static-secret/session lifecycle and runtime error propagation.

### Silently capture passwords typed into the browser stream

Rejected. It would surprise the owner and blur browser-session repair with stored-secret rotation. Explicit static-secret capture remains the only way to store or rotate provider secrets.

## Acceptance checks

- A provider-rejected stored credential becomes `status='rejected'` with non-secret rejection metadata.
- Rejected credentials are not recovered for static-secret run injection.
- Browser-session connections ignore absent/revoked/rejected optional stored login secrets and can still use a repaired browser session.
- ChatGPT incorrect-password UI emits a typed `credential_rejected` failed `DONE.error`.
- Runtime accepts and persists the bounded error code, and controller marking rejects only credentials actually injected into the run.
- Owner repair copy says browser repair captures session state and does not store passwords typed into the browser.
- Scheduled static-secret recovery errors with owner-repair credential codes emit skipped needs-human records, do not spawn the connector, and do not repeat credential recovery on later automatic ticks.
- OpenSpec strict validation and targeted tests pass.
