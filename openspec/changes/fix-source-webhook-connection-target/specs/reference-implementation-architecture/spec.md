## MODIFIED Requirements

### Requirement: Source Webhook Ingress Boundary

The reference implementation SHALL expose source webhook ingress only as reference-runtime behavior at `POST /_ref/source-webhooks/:sourceId` on the RS application only. It SHALL NOT register the ingress route on the AS application. It SHALL NOT advertise source webhooks as core PDPP support, SHALL NOT add event-driven grant semantics, and SHALL NOT accept source callbacks authenticated with owner bearer tokens, client grant tokens, or local collector device credentials.

Each source webhook event that passes HMAC authentication SHALL resolve to exactly one writable connection target before the reference claims the event or applies record mutations, run requests, or scheduler signals. The target SHALL include `ownerSubjectId`, `connectorId`, and `connectorInstanceId`. Missing, revoked, wrong-owner, wrong-connector, or ambiguous targets SHALL reject before idempotency claim and before mutation.

The legacy `PDPP_SOURCE_WEBHOOK_SECRETS` syntax `sourceId:secret[:connectorId]` SHALL remain supported only as connector shorthand for the configured owner. The shorthand SHALL fail closed unless it resolves to exactly one active writable connection and SHALL NOT materialize a default-account connection. Explicit multi-connection source webhook configuration SHALL use a structured form with `source_id`/`sourceId`, `secret`, `connector_id`/`connectorId`, `owner_subject_id`/`ownerSubjectId`, and `connector_instance_id`/`connectorInstanceId` fields.

#### Scenario: Reference-only route

- **WHEN** a caller posts a source webhook callback to `POST /_ref/source-webhooks/:sourceId`
- **THEN** the RS application SHALL evaluate the reference-only source webhook ingress route
- **AND** the AS application SHALL NOT expose that route
- **AND** the reference SHALL NOT advertise the reference source webhook endpoint as a public PDPP capability

#### Scenario: Authenticated target resolves before claim

- **WHEN** a source webhook callback has a valid HMAC signature
- **AND** its configured source target is missing, revoked, wrong-owner, wrong-connector, or ambiguous
- **THEN** the reference SHALL reject the callback before recording the idempotency claim
- **AND** the reference SHALL NOT write records, start a run, or signal scheduler last-run state

#### Scenario: Accepted webhook actions are connection scoped

- **WHEN** a source webhook callback is accepted
- **THEN** `ingest_records` SHALL write through the resolved `connectorInstanceId` with connection admission enabled
- **AND** `schedule_run` SHALL pass the resolved `ownerSubjectId` and `connectorInstanceId` to run admission
- **AND** scheduler fallback SHALL update last-run state for the resolved `connectorInstanceId`
