## ADDED Requirements

### Requirement: Phantom-connection cleanup SHALL distinguish load-bearing grant scope from a display reference

The reference implementation's operator phantom-connection cleanup (the owner/operator-only, dry-run-default tool that revokes residual zero-record default-account `connector_instances` rows) SHALL refuse to revoke a row whose `connector_instance_id` is load-bearing for any active grant's read scope, and SHALL NOT refuse solely because a grant-package member's display reference names the row.

A connection's `connector_instance_id` is load-bearing for grant scope when an active grant pins it through `grant.streams[].connection_id` in the grant body, or names it in the grant's `storage_binding_json`. A `grant_package_members.source_json` reference is NOT load-bearing for grant scope: read fan-in resolves over the connector's currently-active connections and the grant body's pins, never over the member's stored display source.

Cleanup SHALL revoke only the `connector_instances` row (the same soft-flip used by the owner-agent connection revoke). It SHALL NOT revoke, narrow, or rewrite any grant, grant-package member, child grant, or token. All other zero-evidence safety checks — records, change history, blobs, derived state, version counters, attention records, detail gaps, schedules, active runs, device source instances, stored credentials, default-account provenance, deterministic-id self-consistency, and active-only status — SHALL continue to fail closed, in both the dry-run plan and the apply-time re-evaluation, and a missing evidence table SHALL fail closed rather than pass silently.

#### Scenario: A member display reference alone does not block cleanup

- **WHEN** a zero-record default-account connection is referenced only by a grant-package member's `source_json` display reference, with no `grant.streams[].connection_id` pin and no grant `storage_binding_json` naming it
- **THEN** the cleanup SHALL treat the connection as a revoke candidate
- **AND** the dry-run output SHALL disclose the grant-package member reference as an informational note on the candidate
- **AND** applying the cleanup SHALL revoke only that `connector_instances` row
- **AND** the grant package, its member rows, the member's child grant, and the member's token SHALL remain unchanged.

#### Scenario: A load-bearing grant-scope pin blocks cleanup

- **WHEN** an active grant pins a stream to a connection through `grant.streams[].connection_id`, or names the connection in the grant's `storage_binding_json`
- **THEN** the cleanup SHALL refuse to revoke that connection
- **AND** the refusal reason SHALL identify the load-bearing grant scope distinctly from a display reference.

#### Scenario: A stale duplicate connection is cleaned without affecting its data-bearing sibling

- **WHEN** one connector has a stale zero-record default-account connection referenced only by a member display reference and a separate data-bearing connection with its own `connector_instance_id` and non-zero records
- **THEN** the cleanup SHALL revoke the stale zero-record connection
- **AND** the data-bearing connection SHALL be skipped because it has records
- **AND** the data-bearing connection SHALL remain active and SHALL continue to resolve under grant fan-in.
