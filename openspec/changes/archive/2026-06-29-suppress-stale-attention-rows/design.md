## Context

The structured attention store persists owner-action rows independently from run history. A row can remain non-terminal if an older run fails before the writer transitions it, but the row may also carry an `expires_at` timestamp. The current open-row list only filters lifecycle, so an expired `manual_action_required` row can be returned after a later successful run and appear current.

## Decision

The reference attention read model treats expired non-terminal rows as stale at read time. Store reads for open attention shall return only rows whose lifecycle is open-like and whose `expires_at` is either absent or later than the read clock.

This is a read-model suppression. It does not rewrite historical rows, because the objective is to stop stale attention from surfacing as current without live database mutation.

## Alternatives

- Transition expired rows to `expired` during reads. Rejected for this bug-fix lane because it would mutate durable state from a projection helper.
- Suppress only after projection by calling `isHealthRelevant`. This already protects some health calculations, but it still lets stale rows travel through the current-attention read model and leaves multiple callers to remember the filter.

## Acceptance Checks

- Expired open `manual_action_required` rows are absent from `listOpenAttentionForConnection`.
- A later successful run remains healthy when only stale expired attention exists.
- Existing attention writer/store tests continue to pass.
