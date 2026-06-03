## ADDED Requirements

### Requirement: Phantom-connection cleanup SHALL accept a legacy default-account id that proves provenance

The reference implementation's operator phantom-connection cleanup (the owner/operator-only, dry-run-default tool that revokes residual zero-record default-account `connector_instances` rows) SHALL NOT refuse to revoke a row solely because its `connector_instance_id` does not match the current deterministic `makeDefaultAccountConnectorInstanceId(owner, connector_id)` value, provided the row independently proves default-account provenance and carries no real evidence.

A row proves default-account provenance when its `source_kind` is `account`, its `source_binding_key` is `default`, its `source_binding_json` is exactly `{ "kind": "default_account" }`, and its `status` is `active`. A row whose `connector_instance_id` does not match the current deterministic value but that proves this provenance is a legacy default-account materialization (minted under an earlier id formula); the cleanup SHALL treat it as a revoke candidate and SHALL disclose the legacy id as an informational note distinct from a current deterministic id.

The cleanup SHALL continue to refuse a row whose source binding is not the default-account marker (a real owner-created connection), regardless of its id and regardless of whether it carries data. The cleanup SHALL continue to refuse any default-account row — current id or legacy id — that carries records, change history, blobs, derived state, version counters, grant connector state, attention records, detail gaps, a load-bearing grant scope, a schedule, an active run, a device source instance, or a stored credential, in both the dry-run plan and the apply-time re-evaluation, and a missing evidence table SHALL fail closed. The revoke SHALL remain the same `connector_instances` soft-flip, and a revoked legacy row SHALL survive subsequent reads without re-materializing.

#### Scenario: A zero-record legacy default-account row is a revoke candidate

- **WHEN** a connection has the default-account provenance markers and an active status, carries no records and no other instance-scoped evidence, is not scoped by any load-bearing grant, and has a `connector_instance_id` that does not match the current deterministic default-account id
- **THEN** the cleanup SHALL treat the connection as a revoke candidate
- **AND** the dry-run output SHALL disclose the legacy default-account id as an informational note distinct from a current deterministic id
- **AND** applying the cleanup SHALL revoke only that `connector_instances` row
- **AND** a subsequent read SHALL NOT resurrect the revoked row and SHALL NOT materialize a replacement row under the current deterministic id.

#### Scenario: A current deterministic-id candidate carries no legacy-id note

- **WHEN** a zero-record default-account connection whose `connector_instance_id` matches the current deterministic default-account id is a revoke candidate
- **THEN** the cleanup SHALL NOT attach the legacy-default-account-id note to that candidate.

#### Scenario: A non-default binding with a legacy id stays out of scope

- **WHEN** a connection has a `connector_instance_id` that does not match the current deterministic default-account id and a source binding that is not the default-account marker, even with zero records
- **THEN** the cleanup SHALL refuse to revoke the connection on default-account-provenance grounds.

#### Scenario: A legacy default-account row with real evidence is refused

- **WHEN** a connection proves default-account provenance and has a legacy `connector_instance_id` but carries any record, load-bearing grant scope, schedule, active run, device source instance, or stored credential
- **THEN** the cleanup SHALL refuse to revoke the connection
- **AND** the refusal SHALL cite the evidence, not the legacy id
- **AND** the refusal SHALL also hold at the apply-time re-evaluation when the evidence appears between the plan and the apply.
