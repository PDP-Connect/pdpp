## Context

`cleanup-phantom-connections.mjs` (shipped under `separate-connector-catalog-from-connections`) revokes residual phantom default-account `connector_instances` rows with a deny-by-default P1–P7 predicate. On the owner's instance the live `/_ref/connectors` still lists legacy zero-record default-account rows (notion, oura, spotify, strava, reddit) and the script reports zero candidates because P5 fails closed on any `grant_package_members.source_json` reference. This change establishes whether that block is correct, and narrows it precisely if not.

### Proven facts this design rests on (read the code, not the comments)

1. **A grant member's `source_json.connection_id` is not grant scope.** `persistChildGrantForPackage` (`auth.js` ~3986) stores the child grant's `storage_binding_json` as `normalizeStorageBinding(storageBinding)` = `{connector_id}` only — never a `connector_instance_id`. The `connection_id` lives on the package member's `source_json` (`enrichSourceWithConnectionId`, `auth.js` ~1011) purely so package consumers can disambiguate display and so the operator detail page can show which connection a member was approved against.

2. **Read scope never consults `grant_package_members.source_json`.** Grant read fan-in (`resolveFanInBindings`, `connection-identity.js` ~170) resolves bindings from `listActiveByConnector(owner, connectorId)` — the connector's currently-`active` `connector_instances`. It narrows only by (a) `grant.streams[].connection_id` (the grant-scope pin, read from `grant_json` in `records.js` ~3917 and `search.js` ~775), (b) a request-time `connection_id`, or (c) a `storageBinding.connector_instance_id` hint. A grep of `reference-implementation/server` confirms the only readers of `grant_package_members.source_json` are `auth.js` display/normalization helpers and the member SQL queries — no read path scopes on it.

3. **Revoking the phantom connection is self-contained.** `listActiveByConnector` filters `status='active'`; flipping the phantom to `revoked` drops it from fan-in and from the dashboard projection (which already hides `revoked`). The grant package, members, child grants, and tokens are untouched. If the package member's `source_json` pointed at the now-revoked phantom, `normalizePersistedPackageMemberSource` already heals display by matching against active bindings and dropping a stale `display_name` — so the member simply renders without the stale pointer.

4. **Whole-package revoke is the wrong tool, and so is per-member revoke, for this class.** `revokeGrantPackage` (and the per-member primitives `markGrantPackageMemberRevoked` + `revokeGrant`) revoke real grant access — they kill the child grant + its tokens. For a *dead display pointer to a zero-record phantom*, no grant access needs to be removed: the package's access to that connector is governed by the connector's active connections, not by the phantom. Revoking the member would be an unnecessary, destructive over-reach.

### The one genuinely load-bearing case

A grant CAN pin a connection: `grant.streams[].connection_id` in `grant_json` is honored by `resolveFanInBindings` (`grantStreamConnectionId`), and a grant `storage_binding_json.connector_instance_id` is a binding hint. If a phantom `connector_instance_id` appears there, revoking it WOULD change what the grant reads (narrow a stream to empty, or void a pinned binding). That is real scope and MUST stay a hard block.

## Decision

Split P5 into two distinct sub-checks:

- **P5a — load-bearing grant scope (hard, non-relaxable block).** Refuse if any active grant's `grant_json` scopes a stream to this exact `connector_instance_id` (`streams[].connection_id`), or any grant's `storage_binding_json` names this `connector_instance_id`. Reason labels: `P5:grant-stream-pin=<n>`, `P5:grant-storage-binding=<n>`. Missing `grants` table still fails closed (`P5:grants-table-missing`).
- **P5b — non-load-bearing display pointer (does NOT block).** A `grant_package_members.source_json` reference, by itself, does not block. It is surfaced as an informational `note` on the candidate (`note: grant-package-member-display-ref=<n>`), so the dry-run still discloses the reference and the operator sees it before applying — but it is not a refusal.

The revoke action is unchanged: the same `connector_instances` soft-flip to `revoked` (the owner-agent revoke primitive), wrapped in the same apply-time full re-evaluation under a row lock (Postgres) / single-writer `writeTransaction` (SQLite). No grant-package code is called; nothing in `grants`, `grant_package_members`, or `tokens` is mutated.

Auditability and rollback: dry-run prints, for every row, either the candidate id + the informational member-display note, or the full skip reasons. `--apply` is transactional (one `writeTransaction` for SQLite; one `BEGIN`/`COMMIT` with `SELECT ... FOR UPDATE` row locks for Postgres). The revoke is a non-destructive SOFT-FLIP — it changes only `status`/`updated_at`/`revoked_at`, emits no cascade, and is reversible. The rollback handle is the apply output itself: the JSON `revoked[]` set lists every `connector_instance_id` and its `revoked_at`, so re-activating is `UPDATE connector_instances SET status='active', revoked_at=NULL WHERE connector_instance_id IN (<the revoked ids>)`. A separate `VACUUM INTO` backup file is deliberately NOT added: it would be redundant surface for a reversible flip, and there is no in-repo backup-file precedent on this branch base. (If a future deployment wants a full-file snapshot before any maintenance, that belongs in a shared operator-tool helper, not duplicated here.)

## Alternatives considered

- **Revoke the phantom AND its grant-package member (per-member revoke).** Rejected as the default: it revokes a real child grant + token to clean up a display pointer. It removes access the package legitimately holds to the *connector* (which may still have real connections). Only correct if the member is provably dead in its own right, which is a separate, narrower judgement than "the connection it once pointed at is now a zero-record phantom." Left out of scope; the operator can revoke a member explicitly through the existing grant-package revoke surface if they decide a member is dead.
- **Keep P5 as a hard block; report only.** Rejected: it leaves the owner's stated problem unsolved (the dashboard keeps showing unused connections) when the block is provably a false positive. The safety criteria are met by revoking only the connection and refusing only on real grant scope, so a report-only outcome would under-deliver.
- **Relax P5 entirely (any grant reference is just informational).** Rejected: a `grant.streams[].connection_id` pin and a `storage_binding_json.connector_instance_id` ARE load-bearing. Relaxing those would silently narrow a live grant. The split keeps them hard.
- **Heal/rewrite the stale `source_json` pointer during cleanup.** Rejected as out of scope and riskier: mutating `grant_package_members` rows touches grant-package state this tool deliberately does not own. Display already self-heals at read time (`normalizePersistedPackageMemberSource`), so no rewrite is needed.

## Acceptance checks

- A zero-record phantom default-account row referenced ONLY by `grant_package_members.source_json` (no grant-scope pin, no storage-binding ref) IS a candidate; the dry-run notes the member reference; apply revokes the connection and leaves the grant package, the member row, the child grant, and the token unchanged.
- A row pinned by an active `grant.streams[].connection_id` is refused (`P5:grant-stream-pin`); a row named by a grant `storage_binding_json.connector_instance_id` is refused (`P5:grant-storage-binding`).
- Duplicate Reddit: a stale zero-record default-account Reddit row (member-referenced only) is revoked; a separate data-bearing Reddit connection is skipped (`P4:records=…`) and stays active with its grant fan-in intact.
- All prior fail-closed cases (records/blobs/schedule/run/credential/device-source present, non-default provenance, non-deterministic id, non-active status, missing evidence table) still skip, in plan and at apply-time re-evaluation.
- `git diff --check` clean; the cleanup test suite (SQLite in-process; Postgres gated on `PDPP_TEST_POSTGRES_URL`) green; `openspec validate cleanup-grant-referenced-zero-record-connections --strict`.
