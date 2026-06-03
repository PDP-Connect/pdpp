# Cleanup legacy default-account-id zero-record connections

## Why

`separate-connector-catalog-from-connections` stopped a reference read from materializing phantom default-account `connector_instances` rows; `cleanup-phantom-connections` revokes the residual rows; and `cleanup-grant-referenced-zero-record-connections` narrowed P5 so a stale grant-package member display pointer no longer blocks. But on the owner's long-lived instance the cleanup script still reports **zero candidates**: the remaining placeholders (Notion, Oura, Spotify, Strava) are blocked solely by P2 (`id-not-deterministic-default-account`). Their `connector_instance_id` does not equal the current `makeDefaultAccountConnectorInstanceId(owner, connector_id)` — they are **legacy** default-account rows minted under an earlier id-hash formula. Each has zero records, zero history, zero state, zero load-bearing grants, no schedule, no run, no credential — and the exact default-account markers (`source_kind='account'`, `source_binding_key='default'`, `source_binding_json={"kind":"default_account"}`, `status='active'`).

P2 was authored as an anti-spoofing gate: requiring the id to match the deterministic hash proved a row was a real default-account materialization, not a row that merely copied the marker fields. That guard over-refuses here: a legacy materialization has intact markers and only a different id hash, so it is provably a default-account row, not a spoof. Spoofing is already neutralized by the rest of the predicate — P4–P7 fail closed on ANY record, grant scope, schedule, run, credential, or device-source evidence — so a marker-spoofed row that carried real owner-meaningful state is still refused by its data. A zero-evidence row with the exact default-account markers is, behaviorally, a phantom regardless of which id formula minted it.

## What Changes

- The phantom-connection cleanup safety predicate SHALL accept a default-account row whose `connector_instance_id` does not match the current deterministic formula (a **legacy** default-account id), provided the row independently proves default-account provenance (the P1 markers) and passes every other check (P3 active, P4–P7 zero evidence). P2 SHALL NOT, by itself, block revoking such a row.
- A legacy default-account id SHALL be surfaced as an informational note (`P2b:legacy-default-account-id`) on the candidate, so the dry-run discloses every legacy revoke to the operator before they apply. A current deterministic id (P2a) carries no such note.
- A non-deterministic id with a NON-default source binding SHALL still be refused at P1 (out of scope; the owner genuinely created it). A legacy default-account row with ANY real evidence SHALL still be refused at P4–P7, in both the dry-run plan and the apply-time re-evaluation. A missing evidence table SHALL still fail closed.
- The revoke remains the same non-destructive `connector_instances` soft-flip; durability of a legacy revoke is guaranteed by the binding-keyed durability guard in `ensureDefaultAccountConnection` (lookup by owner + connector + `source_kind='account'` + `source_binding_key='default'`, not by id), which returns a `revoked` row unchanged and never re-materializes it.

## Capabilities

### Modified Capabilities

- `reference-connector-instances` — refines the operator phantom-connection cleanup contract: a legacy (non-deterministic) default-account id no longer blocks revoking a zero-record default-account row that independently proves provenance; a non-default binding and any real evidence still fail closed.

## Impact

- The residual legacy zero-record default-account rows blocked solely by P2 become revocable, so the owner's dashboard stops showing connections they never created.
- No grant, grant-package member, child grant, or token is revoked or modified by this path.
- Real account/local/browser/API connections (non-default source bindings) stay out of scope — they are refused at P1 regardless of id.
- A revoked legacy row is durable: the next read returns it unchanged and does not silently materialize a new current-id phantom in its place.
- No PDPP protocol contract change. This is a reference operator tool; the `connector_instances` revoke it performs is the same soft-flip the owner-agent revoke route uses.
