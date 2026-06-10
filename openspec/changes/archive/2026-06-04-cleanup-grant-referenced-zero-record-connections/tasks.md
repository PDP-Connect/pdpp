## 1. Investigation (done — this lane)

- [x] 1.1 Prove the blocking `grant_package_members.source_json` reference is a non-load-bearing display pointer: child-grant `storage_binding_json` is `{connector_id}` only (`persistChildGrantForPackage`); read fan-in scopes from `listActiveByConnector` + `grant.streams[].connection_id` (`resolveFanInBindings`, `records.js`, `search.js`); no server read path scopes on `grant_package_members.source_json` (grep of `reference-implementation/server`).
- [x] 1.2 Prove revoking the phantom connection is self-contained: `listActiveByConnector` filters `status='active'`, the dashboard projection hides `revoked`, and `normalizePersistedPackageMemberSource` self-heals stale member display at read time — so no grant-package mutation is needed.
- [x] 1.3 Identify the one genuinely load-bearing case that MUST stay a hard block: `grant.streams[].connection_id` (grant body) and `storage_binding_json.connector_instance_id`.

## 2. Predicate change — split P5

- [x] 2.1 In `reasonsFromEvidence`, split the grant check into P5a (load-bearing: `grant.streams[].connection_id` pin + `storage_binding_json.connector_instance_id`) which blocks, and P5b (`grant_package_members.source_json`) which becomes an informational note, not a block. Keep `P5:grants-table-missing` fail-closed.
- [x] 2.2 Gather evidence for the grant-stream pin: count active grants whose `grant_json` scopes a stream to this `connector_instance_id`. Add `grantStreamPinRefs` to the SQLite and Postgres evidence gatherers (both arms; missing `grants` table → `missing` → fail closed).
- [x] 2.3 Carry the grant-package member reference count as a `note` on candidates (`buildPlan`), and surface it in human + JSON output. A candidate with a member note is still a candidate.
- [x] 2.4 Update `PREDICATE_TEXT` and the file header to describe P5a/P5b precisely. No silent behavior change undocumented.

## 3. Operator ergonomics — rollback / audit handle

Decision: the revoke is a non-destructive SOFT-FLIP (`status='revoked'`, only `status`/`updated_at`/`revoked_at` change), so it is reversible by flipping the row back to `active`. A separate `VACUUM INTO` backup file would be redundant surface for a reversible flip and is out of scope (no in-repo precedent on this branch base; the task's rollback handle is met without it). Instead, the rollback handle is the apply output itself.

- [x] 3.1 `--apply` JSON output already emits the exact revoked set (`revoked[].connector_instance_id` + `revoked_at`), which is the rollback manifest: re-activating is `UPDATE connector_instances SET status='active', revoked_at=NULL WHERE connector_instance_id IN (<ids>)`. Document this reverse path in the script header.
- [x] 3.2 No backup-file mechanism added (scope discipline; the soft-flip is reversible and the JSON revoked-set is the audit/rollback handle). Recorded in design + report.

## 4. Tests

- [x] 4.1 SQLite: a phantom referenced ONLY by `grant_package_members.source_json` IS a candidate; dry-run notes the member ref; apply revokes only the connection; the grant, member row, child grant, and token are unchanged.
- [x] 4.2 SQLite: a phantom pinned by an active `grant.streams[].connection_id` is refused (`P5:grant-stream-pin`).
- [x] 4.3 SQLite: a phantom named by `storage_binding_json.connector_instance_id` is still refused (`P5:grant-storage-binding`) — regression guard that P5a did not lose the original storage-binding block.
- [x] 4.4 SQLite: duplicate Reddit — stale zero-record member-referenced row revoked; data-bearing sibling skipped (`P4:records`) and stays active.
- [x] 4.5 SQLite: revoked-placeholder (`P3:status-revoked`) and records-present (`P4:records`) refusals unchanged.
- [x] 4.6 Pure-predicate (`reasonsFromEvidence`): member-ref-only → no block + note; grant-stream pin → block; both backends covered by the shared predicate.
- [x] 4.7 Apply-time re-evaluation: a grant-stream pin inserted AFTER the plan but BEFORE apply blocks the revoke (skipped-at-apply), proving the load-bearing check re-runs under the lock/transaction.
- [x] 4.8 Postgres arm (gated on `PDPP_TEST_POSTGRES_URL`): member-ref-only candidate + grant-stream-pin refusal mirrored.
- [x] 4.9 Backup-file behavior: no new `--backup-to` surface was added; the revoke is a reversible soft-flip and the JSON `revoked[]` apply output is the rollback manifest. The design records why a separate backup-file mechanism is out of scope for this operator tool.

## 5. Spec + validation

- [x] 5.1 `openspec validate cleanup-grant-referenced-zero-record-connections --strict`.
- [x] 5.2 `git diff --check`.
- [ ] 5.3 Fold the spec delta into `reference-connector-instances` on archive (owner).

## Acceptance checks

- A member-display-referenced zero-record phantom is revocable; the grant package and all grant rows are untouched.
- A load-bearing grant-scope pin (stream `connection_id` or storage-binding `connector_instance_id`) is refused with a distinct reason.
- Duplicate Reddit: stale row revoked, data-bearing sibling spared and still resolvable.
- All prior P1–P7 fail-closed cases still skip, in plan and at apply-time re-evaluation; missing evidence table fails closed.
- Cleanup test suite green (SQLite; Postgres gated); `openspec validate … --strict`; `git diff --check` clean.
