## 1. Contract And Prior Art

- [x] 1.1 Finalize common condition types, reason-code naming, severity values, and remediation shape.
- [x] 1.2 Add a compact reason-code registry or typed constants for shared reasons.
- [x] 1.3 Confirm owner-only diagnostic boundaries for dashboard and reference API.

## 2. Evidence Normalization

- [x] 2.1 Add pure types and derivation helpers for raw facts, conditions, and connection health projections.
- [x] 2.2 Normalize existing run outcomes, source gaps, schedule records, attention requests, local outbox reports, and read-model freshness into conditions.
- [x] 2.3 Add currentness and expiry handling so stale policy/runtime evidence cannot override newer success.

## 3. Readiness And Diagnostics

- [x] 3.1 Convert known credential failures into `CredentialsValid` conditions with safe remediation.
- [x] 3.2 Convert browser surface, local exporter, and external tool availability failures into readiness conditions where evidence already exists.
- [x] 3.3 Add redaction checks for owner-safe diagnostics.

## 4. Shared Projection Consumers

- [x] 4.1 Update the reference connectors API to return the shared projection and condition summary.
- [x] 4.2 Update the CLI connector views to consume the shared projection.
- [x] 4.3 Update the dashboard records/connections view to consume the shared projection and render remediation without ad hoc health inference.

## 5. Migration And Cleanup

- [x] 5.1 Backfill or lazily derive conditions for existing connections without destructive migration.
- [x] 5.2 Remove legacy ad hoc health derivation paths after parity tests pass.
- [x] 5.3 Grep old health-state names and verify remaining occurrences are compatibility-only or intentional.

## 6. Acceptance Checks

- [x] 6.1 Add regression tests for invalid credentials, successful rerun clearing stale scheduler backoff, manual attention, partial coverage, local exporter backlog, and projection unreliability.
- [x] 6.2 Verify dashboard and CLI agree on dominant state and reason for representative fixtures.
- [x] 6.3 Run `openspec validate define-connection-health-evidence-model --strict`.
- [x] 6.4 Run relevant reference server and dashboard tests before reporting implementation complete.
