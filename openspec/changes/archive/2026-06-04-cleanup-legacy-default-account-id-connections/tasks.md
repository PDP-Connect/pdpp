## 1. Investigation (done — this lane)

- [x] 1.1 Prove the four live blocked rows (notion, oura, spotify, strava) are legacy default-account materializations: intact markers (`source_kind='account'`, `source_binding_key='default'`, `source_binding_json={kind:default_account}`, `status='active'`), only the id hash differs from the current `makeDefaultAccountConnectorInstanceId(owner, connector_id)`. Each is skipped only by `P2:id-not-deterministic-default-account`; scalar evidence (records/history/state/gaps/schedules/runs/credentials and load-bearing grants) is all 0.
- [x] 1.2 Prove a legacy revoke is durable: `ensureDefaultAccountConnection`'s guard looks the row up by BINDING (`getByBinding`, owner+connector+account+default), not by id, and returns a `revoked` row unchanged — so the revoke survives future reads and does not re-materialize a current-id row.
- [x] 1.3 Confirm spoofing is neutralized without P2: P4–P7 fail closed on any real evidence, so the only rows P2 uniquely blocks are zero-evidence marker-intact default-account rows (phantoms regardless of id formula). Non-default bindings stay refused at P1.

## 2. Predicate change — split P2

- [x] 2.1 In `reasonsFromEvidence`, stop pushing any P2 reason. The blocking predicate consults the id only through P1's provenance markers. A legacy id no longer blocks.
- [x] 2.2 In `notesFromEvidence`, compute the current deterministic id and attach a `P2b:legacy-default-account-id` note when the row's id differs. Notes are only attached to candidates (rows that passed P1–P7), so a non-matching id is necessarily a legacy default-account row. P2a (current id) carries no note.
- [x] 2.3 Update `PREDICATE_TEXT`, the file header P2 section, the evidence-shape docstring, and the spec-reference list to describe P2a/P2b precisely. No silent behavior change.

## 3. Tests

- [x] 3.1 SQLite: a zero-record legacy default-account row (non-deterministic id) IS a candidate with a `P2b` note; revoke is durable across the next read (no re-materialization, including no new current-id row).
- [x] 3.2 SQLite: a current deterministic-id candidate carries NO legacy-id note (P2a regression guard).
- [x] 3.3 SQLite: a legacy id WITH a record is refused at P4 (not P2); a legacy id pinned by an active `grant.streams[].connection_id` is refused at P5a.
- [x] 3.4 SQLite: a non-deterministic id with a NON-default source binding is refused at P1 even with zero data.
- [x] 3.5 SQLite apply-time re-evaluation: a legacy candidate that gains a record before apply is skipped-at-apply (P4).
- [x] 3.6 Pure-predicate (`reasonsFromEvidence`/`notesFromEvidence`): legacy instance clean → no block + `P2b` note; current instance → no note; legacy + member ref → both notes; legacy + records → P4 block, no P2; non-default → P1 block. Backend-agnostic.
- [x] 3.7 Postgres arm (gated on `PDPP_TEST_POSTGRES_URL`): legacy-id candidate + note + durable revoke; legacy-id-with-record P4 refusal mirrored.

## 4. Spec + validation

- [x] 4.1 `openspec validate cleanup-legacy-default-account-id-connections --strict`.
- [x] 4.2 `git diff --check`.
- [ ] 4.3 Fold the spec delta into `reference-connector-instances` on archive (owner).

## Acceptance checks

- A zero-record legacy default-account row is revocable, with a `P2b` note; the revoke is durable and materializes no replacement.
- A current deterministic-id phantom is still a candidate with no note.
- A non-default binding is refused at P1; any real evidence is refused at P4–P7, in plan and at apply-time re-evaluation; missing evidence table fails closed.
- Cleanup test suite green (SQLite; Postgres gated); `openspec validate … --strict`; `git diff --check` clean.
