## ADDED Requirements

### Requirement: Consent and owner-device auth semantics SHALL be conformance-tested before storage extraction

Before introducing production `ConsentStore` or `OwnerDeviceAuthStore` abstractions, the reference implementation SHALL define reusable test-only conformance scenarios that pin the current pending-consent and owner-device-authorization lifecycle/security obligations.

#### Scenario: Pending consent conformance

- **WHEN** a candidate pending-consent storage driver is evaluated
- **THEN** it SHALL pass conformance scenarios for pending lookup, terminal approval/denial behavior, approval-id indirection, and expiry or unavailable-state behavior where feasible
- **AND** any behavior left to route-level tests SHALL be explicitly documented as deferred from the storage conformance harness

#### Scenario: Owner device authorization conformance

- **WHEN** a candidate owner-device-authorization storage driver is evaluated
- **THEN** it SHALL pass conformance scenarios for start, lookup, poll-before-approval, approval/exchange, denied/expired rejection, and polling interval behavior where feasible
- **AND** it SHALL preserve the current reference secret-handling boundary for `device_code`, `user_code`, and approval identifiers

#### Scenario: Harness boundary

- **WHEN** the conformance harness is implemented
- **THEN** it SHALL live under `reference-implementation/test/**`
- **AND** it SHALL expose semantic lifecycle operations rather than raw SQL, table names, generic repositories, or production store interfaces
- **AND** it SHALL include a falsifiability proof that fails on at least one deliberately broken lifecycle or security invariant
