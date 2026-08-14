# reference-implementation-architecture Specification Delta

## ADDED Requirements

### Requirement: Console consent approval review SHALL bind to the immutable server artifact

The operator console SHALL render consent approval facts from the server-owned `/consent/review` response for the pending approval. The final single-consent approval form SHALL carry the exact returned `request_uri` and `approval_review_revision`, and its approval mutation SHALL submit only those two fields. It SHALL NOT call `/consent/review` during final approval.

#### Scenario: Owner reviews a pending single consent

- **WHEN** an owner opens the console review page for a pending single consent approval
- **THEN** the console SHALL materialize `/consent/review` for that approval and render the returned `reference.approval-review.v1` artifact directly
- **AND** it SHALL render artifact version, subject, AI-training decision, client, purpose, access mode, retention, expiry, source, source declaration version/digest, selection preset, and every `resolved_streams[]` name, `instance_ids`, fields, resources, and time constraint
- **AND** final approval SHALL submit the exact reviewed `request_uri` and `approval_review_revision`.

#### Scenario: Review revision is stale or unavailable

- **WHEN** final approval fails because the review artifact is missing, stale, malformed, terminal, or conflicted
- **THEN** the console SHALL return to the read-only review state, not the confirmation state
- **AND** the next owner action SHALL require a newly materialized `/consent/review` artifact before approval can be attempted again.

### Requirement: Console approval SHALL require review and final confirmation

The operator console SHALL not render an approval submit in the pending-approvals queue. It SHALL provide a stable review route and render the approval submit only in a final confirmation state for single consent and owner-device approvals. Batch consent SHALL either use the hosted source-review ceremony or render the exact `reference.batch-approval-review.v1` artifact with the batch confirmation protocol; until implemented in console, batch consent SHALL be explicitly non-actionable.

#### Scenario: Batch consent reaches console review

- **WHEN** the materialized review artifact has version `reference.batch-approval-review.v1`
- **THEN** the console SHALL render the exact artifact facts
- **AND** it SHALL NOT render a one-click approval submit unless it also submits `confirm_reviewed_decision` with the exact reviewed `request_uri` and `approval_review_revision`.

#### Scenario: Owner-device review

- **WHEN** the review projection is for an owner-device authorization
- **THEN** the console SHALL identify it as owner control and SHALL not present data-grant scope or purpose.
