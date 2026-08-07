## Decision

Use the existing `(owner, connector, source_kind, source_binding_key)` unique
constraint as the identity claim, rather than adding a second identity table or
partial index. Static-secret binding keys have explicit phases:

- `static_secret_draft_identity_<hash>` is derived from the owner-supplied
  non-secret identity field when one is declared; connectors without one keep
  a random draft key so distinct accounts are never collapsed on insufficient
  evidence.
- `static_secret_verified_identity_<hash>` is derived from the non-secret
  identity returned by a successful synchronous probe. The binding also keeps
  that provider identity as non-secret metadata for future status/retry
  decisions. The connector-instance id does not change when its binding key is
  re-keyed.

The capture route accepts optional `setup_fields`. It validates them against
the manifest, rejects secret/unknown/required-field violations, updates only
the existing draft's non-secret binding, then probes. A rejected probe does
not mutate the draft status. On a successful probe the route claims the
verified binding key before credential capture. If the database unique binding
constraint reports a collision, the route resolves the winner under the same
owner and connector: a draft target may converge onto the winner, but an active
target refuses an identity conflict. This leaves at most one newly-managed
draft/active instance for a verified identity without merging distinct
accounts.

For an active row already created before this change, the draft route performs
a bounded owner+connector identity comparison against its stored non-secret
setup fields for synchronous-identity connectors. A single matching active
connection is reused; more than one is an ambiguity and fails closed. A later
successful probe claims the verified key, so future requests use the same
authoritative binding. Existing duplicate active rows are not auto-merged.

Credential replacement remains connection-id scoped and uses the same capture
route. A replacement may claim the same verified identity on that connection;
attempting to retarget an already verified active connection to a different
identity fails closed and directs the owner to create a distinct account.

## Alternatives rejected

- **Client-side submit disabling:** does not converge retries after a timeout,
  reload, second tab, or direct API request.
- **A new idempotency table:** duplicates an identity axis already enforced by
  the connector-instance binding constraint and would require a new lifecycle
  and cleanup policy.
- **Active-only post-hoc duplicate cleanup:** allows both rows to promote and
  leaves a window where both can collect; the identity claim happens before
  credential persistence instead.
- **Hashing the submitted secret as an account key:** secrets are not provider
  identity, can rotate, and would risk collapsing distinct accounts. The secret
  is never used for binding or round-tripped.
- **Guessing identity for first-sync-only connectors:** without a verified
  provider identity, collapsing submissions is unsafe. Those connectors retain
  random draft keys and fail closed until a provider identity exists.

## Compatibility and migration

No database migration is required. The change reuses the existing binding key
and JSON binding columns. Existing rows without a verified-identity key remain
valid and are not rewritten at startup. On a future synchronous capture, a
single matching legacy active row can claim the new key; ambiguous legacy rows
fail closed and require explicit owner/operator cleanup outside this change.

## Acceptance checks

- A synchronous typo rejection leaves one draft, preserves its id through the
  Console redirect, and a corrected retry updates the draft's non-secret setup
  fields before a successful probe/capture.
- Repeated draft creation and concurrent/same-identity capture converge to one
  connector instance and one active identity; repeated capture does not create
  a second credential row or active connection.
- Distinct identity fields create distinct connection ids and both can promote
  independently.
- Existing connection-id credential replacement keeps id, schedule, records,
  and history; no secret appears in bindings, responses, audits, or query
  parameters.
- SQLite focused tests, Console invariant/type checks, OpenSpec strict
  validation, and the repository's relevant final checks pass.
