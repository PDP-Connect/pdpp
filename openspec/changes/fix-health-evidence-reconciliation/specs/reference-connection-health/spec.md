## MODIFIED Requirements

### Requirement: A durable detail gap SHALL reopen when a later run proves its recovery did not durably hold

`connector_detail_gaps` status transitions SHALL preserve the following
invariants:

- `terminal` SHALL remain sticky unconditionally: a terminalized gap SHALL
  NEVER be resurrected into the fillable-pending set by any re-upsert.
- `recovered` SHALL remain sticky against a re-upsert whose `last_run_id`
  equals the row's own `recovered_run_id` — an ordinary-forward-pass
  re-defer within the SAME run that recovered the identity SHALL NOT
  regress the row or surface a phantom known_gap. This comparison SHALL
  use exact (non-NULL) equality: a `recovered_run_id` of `NULL` (a
  run-id-less recovery, e.g. the local-collector policy-budget drain,
  which has no spine run to name) SHALL NEVER be treated as matching any
  `last_run_id`, including another `NULL`. `NULL` SHALL NOT be special-cased
  as a stickiness wildcard.
- `recovered` SHALL reopen to `pending` when a re-upsert's `last_run_id`
  differs from the row's own `recovered_run_id`, OR when the row's own
  `recovered_run_id` is `NULL` — a LATER run reporting a fresh
  `DETAIL_GAP` for a previously-`recovered` identity, or ANY re-upsert of
  a run-id-less recovery, is durable evidence that the recovery did not
  hold (or carries no same-attempt context to protect), and the row SHALL
  become fillable-pending again so it is eligible for retry and (if it
  keeps failing) quarantine escalation. A `recovered` gap SHALL NOT be
  permanently excluded from both the pending-retry queue and the
  quarantine escalation path merely because it was recovered once, and a
  run-id-less recovery path SHALL NOT be exempt from this rule.

#### Scenario: A gap recovered by a prior run and re-reported by a later run reopens to pending

- **WHEN** a `connector_detail_gaps` row is `recovered` with
  `recovered_run_id = R1`
- **AND** a LATER run `R2` (`R2 != R1`) emits a fresh `DETAIL_GAP` for the
  same identity
- **THEN** the row's status SHALL become `pending`
- **AND** `recovered_run_id` SHALL remain `R1` (audit trail of the original
  recovery preserved)
- **AND** the run's owner-facing `known_gaps` SHALL contain a `detail_gap`
  entry for the identity (it is once again genuinely outstanding work)

#### Scenario: A gap recovered and re-deferred within the SAME run stays recovered

- **WHEN** a `connector_detail_gaps` row is `recovered` with
  `recovered_run_id = R1`
- **AND** the SAME run `R1`'s ordinary forward pass re-emits a `DETAIL_GAP`
  for the same identity after its own recovery pass already closed it
- **THEN** the row's status SHALL remain `recovered`
- **AND** no phantom `detail_gap` entry SHALL appear in that run's
  `known_gaps`

#### Scenario: A gap recovered with no run id reopens to pending on any later re-upsert

- **WHEN** a `connector_detail_gaps` row is marked `recovered` with no
  `runId` supplied (`recovered_run_id` stays `NULL` — the local-collector
  policy-budget drain shape)
- **AND** ANY later re-upsert reports the same identity again, whether or
  not that re-upsert itself carries a run id
- **THEN** the row's status SHALL become `pending`
- **AND** the row SHALL NOT remain `recovered` indefinitely merely because
  `recovered_run_id` is `NULL`

### Requirement: A generic run failure SHALL NOT manufacture a credential-reconnect reason when a more specific owner-interaction gap already classifies the same failure

`credentialReasonFromGenericFailure` (§10-C) SHALL NOT synthesize a
`credentials_required`/`session_required` reason from a known_gap's bare
`refresh_credentials` recovery_hint or a `session_failed`/`session_required`/
`session_expired`-shaped message alone when BOTH of the following hold:

- another known_gap in the SAME run's `known_gaps` array carries kind
  `interaction_required` or `recovery_hint.action === "manual_action_required"`
  (a more specific, connector-emitted classification of the same failure), AND
- the candidate credential-shaped gap's message contains no DEFINITIVE
  auth-rejection marker (an explicit `401`, `403`, `authentication_error`,
  `credential_rejected`, `invalid_token`, `unauthorized`, or `forbidden`).

A DEFINITIVE auth-rejection marker SHALL always drive a credential-reconnect
reason, even alongside a competing owner-interaction gap — this requirement
SHALL NEVER suppress a genuinely rejected credential.

#### Scenario: A login-flow stall with a competing manual_action gap does not manufacture a credential prompt

- **WHEN** a failed run's `known_gaps` contains an `interaction_required`
  gap with `recovery_hint.action: "manual_action_required"`
- **AND** the SAME run's `known_gaps` also contains a generic `run_failed`
  gap whose message contains "session_failed" (no definitive 401/403/
  rejection marker) and `recovery_hint.action: "refresh_credentials"`
- **AND** the connection's stored credential is `present` and not
  `rejected`
- **THEN** the projected connection health SHALL NOT include a
  `CredentialsValid: false` condition
- **AND** the owner-facing verdict SHALL NOT offer a "Reconnect this
  account" action for this failure

#### Scenario: A genuine 401/403 still drives a credential prompt alongside a competing manual_action gap

- **WHEN** a failed run's `known_gaps` contains BOTH an
  `interaction_required`/`manual_action_required` gap AND a `run_failed`
  gap whose message contains an explicit `401` or `403`
- **THEN** the projected connection health SHALL include a
  `CredentialsValid: false` condition with `remediation.action ===
  "refresh_credentials"`
