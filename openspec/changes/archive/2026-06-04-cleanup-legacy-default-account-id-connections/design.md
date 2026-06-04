## Context

`cleanup-phantom-connections.mjs` revokes residual phantom default-account `connector_instances` rows with a deny-by-default P1–P7 predicate. After the P5 split (`cleanup-grant-referenced-zero-record-connections`), the owner's live `/_ref/connectors` still lists four legacy zero-record default-account rows (notion, oura, spotify, strava) and the script reports zero candidates, each skipped only by `P2:id-not-deterministic-default-account`. This change establishes whether the P2 block is correct for those rows, and narrows it precisely if not.

### Proven facts this design rests on (read the code, not the comments)

1. **The four live rows are legacy default-account materializations, not spoofs.** Each row has `source_kind='account'`, `source_binding_key='default'`, `source_binding_json={"kind":"default_account"}`, `status='active'` — the exact shape `ensureDefaultAccountConnection` writes. Only the `connector_instance_id` differs from the current `makeDefaultAccountConnectorInstanceId(owner, connector_id)` (e.g. notion expected `cin_55d18b7c439285116455a7e4`, actual `cin_78248d6fa779ebbab25c0f84`). The id formula (`connector-instance-store.js` ~129) hashes `owner\nconnector\naccount\ndefault`; a row whose hash differs was minted under an earlier input/formula. The marker fields are intact.

2. **P2 was an anti-spoofing gate, and spoofing is neutralized elsewhere.** The original P2 (`id === makeDefaultAccountConnectorInstanceId(...)`) proved a row was a genuine materialization, not a row that copied the marker fields. But P4–P7 already fail closed on ANY record, record-change, blob, derived state, version counter, grant connector state, attention record, detail gap, load-bearing grant scope, schedule, active run, device-source instance, or credential. A marker-spoofed row that carried real owner-meaningful state is therefore still refused by its data. The only rows P2 uniquely blocks are zero-evidence rows with the exact default-account markers — which are, behaviorally, phantoms regardless of which id formula minted them.

3. **A legacy revoke is durable.** `ensureDefaultAccountConnection`'s durability guard (`connector-instance-store.js` ~366) looks the row up by BINDING — `getByBinding(owner, connector, source_kind='account', source_binding_key='default')` — NOT by id, and returns a `revoked` row unchanged. So revoking a legacy row (whose `source_binding_key` is still `'default'`) survives every future read exactly like a revoked current-id row: the next `ensureDefaultAccountConnection` finds the revoked legacy row by binding and returns it, with no re-materialization. (A genuinely missing row would re-materialize under the CURRENT id; that is correct, not a leak.)

4. **Revoking the legacy connection is self-contained and narrows nothing.** `listActiveByConnector` filters `status='active'`; flipping a legacy phantom to `revoked` drops it from grant fan-in (`resolveFanInBindings`, `connection-identity.js` ~170) and from the dashboard projection (which already hides `revoked`). The row carried zero records, so fan-in loses no data. The P5a grant-stream pin and grant `storage_binding_json` checks still hard-block if any grant genuinely scopes a read to the legacy id.

### The cases that MUST stay refused

- **Non-default source binding (P1).** A non-deterministic id with `source_binding != {kind:'default_account'}` (a real account/local/browser/API connection) is the owner's own connection. It is refused at P1 before P2 is even considered. Zero data does not make it a phantom.
- **Any real evidence (P4–P7).** A legacy default-account row with a record, load-bearing grant, schedule, run, credential, or device source is refused by that evidence, in plan and at apply-time re-evaluation. P2 acceptance does not relax any of these.
- **Missing evidence table.** Still fails closed (`Px:<table>-table-missing`).

## Decision

Split P2 into two distinct sub-checks:

- **P2a — current deterministic id (the prior accept path).** `connector_instance_id == makeDefaultAccountConnectorInstanceId(owner, connector_id)`. Accepted, no note.
- **P2b — legacy default-account id (newly accepted, does NOT block).** The id does not match the current formula, but the row already proved default-account provenance to reach this point (P1 returns early on any marker failure). The non-deterministic id is surfaced as an informational note (`P2b:legacy-default-account-id`) on the candidate so the dry-run discloses every legacy revoke; it is not a refusal.

Concretely: `reasonsFromEvidence` no longer pushes any P2 reason. The blocking predicate consults the id only through P1's provenance markers. `notesFromEvidence` computes the current deterministic id and attaches the `P2b` note when the row's id differs. Because notes are only attached to rows that already passed the full P1–P7 predicate, a non-matching id on a candidate is necessarily a legacy default-account row.

The revoke action is unchanged: the same `connector_instances` soft-flip to `revoked`, wrapped in the same apply-time full re-evaluation under a row lock (Postgres) / single-writer `writeTransaction` (SQLite). No grant-package code is called; nothing in `grants`, `grant_package_members`, or `tokens` is mutated. The dry-run discloses the legacy-id note (and any P5b member note) for every candidate; `--apply` JSON `revoked[]` remains the rollback handle.

## Alternatives considered

- **Drop P2 entirely (no legacy/current distinction).** Rejected: it loses the explicit disclosure that a given revoke targets a legacy id. The behaviour is identical, but the operator should see — in the dry-run — exactly which revokes are legacy-id cleanups versus current-id cleanups. The note costs nothing and is the honest surface.
- **Heal/rewrite the legacy id to the current deterministic id.** Rejected: mutating a row's primary key cascades to every `connector_instance_id`-keyed reference and is far riskier than a reversible soft-flip, for no benefit — the row carries no data and is being removed, not migrated.
- **Keep P2 a hard block; report only.** Rejected: it leaves the owner's stated problem unsolved (the dashboard keeps showing four unused connections) when the block is provably a false positive for a zero-evidence marker-intact default-account row. The safety criteria are met by accepting only on proven provenance + zero evidence, so a report-only outcome would under-deliver.
- **Relax P1 too (accept any zero-data row).** Rejected and explicitly forbidden by the task: a non-default source binding is a real owner connection. P1 stays a hard block.

## Acceptance checks

- A zero-record legacy default-account row (non-deterministic id, intact markers, active) IS a candidate; the dry-run notes `P2b:legacy-default-account-id`; apply revokes only the connection and the revoke survives the next read (no re-materialization, including no new current-id row).
- A current deterministic-id phantom is still a candidate and carries NO legacy-id note (P2a unchanged).
- A non-deterministic id with a NON-default source binding is refused at P1 even with zero data.
- A legacy default-account row with a record (P4), a load-bearing grant-stream pin (P5a), a schedule (P6), or a credential (P7) is refused — in the plan and at apply-time re-evaluation.
- A missing evidence table still fails closed.
- `git diff --check` clean; the cleanup test suite (SQLite in-process; Postgres gated on `PDPP_TEST_POSTGRES_URL`) green; `openspec validate cleanup-legacy-default-account-id-connections --strict`.
