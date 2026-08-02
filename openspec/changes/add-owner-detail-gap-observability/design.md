# Design

## Route and authorization

The read is:

`GET /v1/owner/connections/{connectionId}/diagnostics/detail-gaps`

It reuses the existing owner diagnostics route adapter, bearer authentication,
owner-token guard, owner namespace resolver, audit event family, and exact
`connection_id` addressing. Connector-only addressing is intentionally not
added: a detail-gap page must never guess between sibling connections.

## Page semantics

The route accepts an optional positive `limit` with a default of 25 and a hard
maximum of 100. Invalid limits and cursors are typed 400 errors. The opaque
cursor binds the connection id and the `(created_at, gap_id)` boundary. The
store reads at most `limit + 1` rows and orders by the unique tuple
`created_at ASC, gap_id ASC`; the extra row determines `has_more`.

The existing detail-gap store remains the source of truth. Its new listing
method is scoped by both `connector_id` and `connector_instance_id`, includes
all statuses, and applies the keyset predicate in both SQLite and PostgreSQL.
No offset pagination, unbounded read, or alternate read model is introduced.

## Wire projection and redaction

Each item contains only:

- `gap_id`, `stream`, `record_key`, `status`, `reason`
- `last_error: { class }`
- `attempt_count`, `last_attempt_at`, `next_attempt_after`
- `lease: { state, expires_at }`
- `disposition: { state, policy_class }`

The projection deliberately omits `detail_locator`, `parent_stream`, `source`,
`scope`, grant/run identifiers, lease identifiers, filenames, provider
messages, tokens, and arbitrary diagnostic fields. `too_large` is treated as
the existing connector-neutral policy-skip class; informational recovery
reasons are also policy-dispositioned. Terminal and recovered statuses remain
authoritative over derived disposition.

The page envelope carries `connection_id`, `limit`, `has_more`, `next_cursor`,
and `data`. It is an owner-only observation; it performs no lease or status
mutation.

## Alternatives rejected

- Extending the aggregate diagnostics response: would mix incompatible page
  semantics into a response already consumed as a health document.
- Adding a Gmail endpoint: would duplicate the existing generic detail-gap
  store and make the observability contract connector-specific.
- Returning raw store rows or `last_error`: would expose locators, provider
  metadata, and arbitrary text beyond the diagnostic need.
- Offset pagination: would scan and skip an unbounded prefix and is less stable
  under insertions than the existing keyset pattern.
