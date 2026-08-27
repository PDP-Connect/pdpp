## Decision

Store the latest credential-state transition as one additive structured JSON
field on `connector_instance_credentials`. It carries a closed `cause` token,
an optional actor, and optional request, trace, run, and interaction
correlation identifiers. The connection id is already the row primary key and
is therefore not duplicated inside the record.

This follows the existing mutable `source_binding_json.revocation_reason`
pattern for state-local cause, while using the same actor and correlation names
as the disclosure spine and run history. It avoids an append-only credential
event table because the immediate incident question is why the current
credential state changed, and the existing audit spine remains the append-only
record for request-driven actions.

The cause is a closed vocabulary validated by the credential store. Actor and
correlation fields are optional: a writer without durable provenance must leave
them absent rather than infer an owner or request. Existing rows are not
backfilled for the same reason.

## Alternatives

- Separate actor/cause/correlation columns: direct but expands a sparse,
  extensible correlation shape into many columns and diverges from the existing
  JSON state-local provenance field.
- Append-only credential events: preserves complete history but duplicates the
  spine and adds a new audit subsystem beyond the incident's current-state
  diagnostic need.

## Compatibility and safety

The new field is nullable and added with backward-compatible migrations. Older
readers ignore it. No credential value, sealed value, bearer, or provider secret
is stored in provenance or logs.

## Acceptance checks

- A real PostgreSQL connection-revoke cascade persists its closed cause and
  supplied actor/correlation record.
- The TTL retirement sweep persists system/TTL provenance and emits ids/counts
  without secrets.
- A writer without actor context leaves actor absent.
- Every production connection-revoke writer stamps a closed
  `revocation_reason` token.
