# Cleanup grant-referenced zero-record legacy connections

## Why

`separate-connector-catalog-from-connections` stopped a reference read from materializing phantom default-account `connector_instances` rows, and `cleanup-phantom-connections` revokes the residual rows left behind on instances materialized before that fix. But on a long-lived instance, some of those residual zero-record default-account rows are referenced by `grant_package_members.source_json`. The cleanup script's safety predicate (P5) fails closed on any such reference, so it finds **no candidates** and the legacy rows persist on the dashboard — the owner still sees connections they never created (Notion, Oura, Spotify, Strava, and a stale duplicate Reddit alongside a separate data-bearing Reddit connection).

The blocking reference is not load-bearing for grant scope. A hosted-MCP child grant's `storage_binding_json` is `{connector_id}` only; the `connection_id` in a member's `source_json` is a display/audit pointer recorded at approval time. Grant read fan-in resolves over the connector's **currently active** `connector_instances` (`listActiveByConnector`) plus any `grant.streams[].connection_id` pin carried in `grant_json` — it never reads `grant_package_members.source_json` to scope a read. Revoking a phantom connection therefore removes it from the dashboard projection and from grant fan-in **without** revoking any grant, member, child grant, or token, and without narrowing what the package can read (fan-in re-resolves over the remaining real connections of that connector).

The original P5 hard-block over-refused: it treated a stale display pointer as if it were live grant scope. This change narrows P5 so a stale member display-pointer to a zero-record phantom no longer blocks cleanup, while a genuinely load-bearing `grant.streams[].connection_id` pin in `grant_json` remains a hard, non-relaxable block.

## What Changes

- The phantom-connection cleanup safety predicate SHALL distinguish a load-bearing grant-scope pin (`grant.streams[].connection_id` in an active grant's `grant_json`, or a grant `storage_binding_json.connector_instance_id`) from a non-load-bearing display pointer (`grant_package_members.source_json.connection_id`). Only a load-bearing pin SHALL block revocation.
- A `grant_package_members.source_json` reference to a zero-record phantom default-account row SHALL NOT, by itself, block revoking that connection. The grant package, its members, child grants, and tokens SHALL remain untouched by the connection revoke.
- A grant-scope pin (`grant.streams[].connection_id`) or a grant `storage_binding_json.connector_instance_id` naming the row SHALL remain a hard fail-closed block (`P5:grant-stream-pin=…` / `P5:grant-storage-binding=…`), because revoking would change what that grant can read.
- All existing P1–P7 evidence checks (records, blobs, schedules, runs, credentials, device sources, deterministic-id provenance, active-only status) remain unchanged and continue to fail closed, including the apply-time re-evaluation under a row lock / single-writer transaction.
- The tool stays operator/owner-only (direct database access, dry-run default, no HTTP route, no scheduler), with per-row dry-run reasons for every candidate and every refusal, transactional apply, and a `--backup-to` rollback handle.

## Capabilities

### Modified Capabilities

- `reference-connector-instances` — refines the operator phantom-connection cleanup contract: a non-load-bearing grant-package member display-pointer does not block revoking a zero-record phantom; a load-bearing grant-scope pin still does.

## Impact

- The residual legacy zero-record rows that were blocked solely by a stale grant-package member pointer become revocable, so the owner's dashboard stops showing connections they never created.
- No grant, grant-package member, child grant, or token is revoked or modified by this path; an active package keeps all of its real access. A package member whose display pointer named a now-revoked phantom simply renders without that stale pointer (fan-in already resolves display over active connections).
- A connection that is genuinely scoped by a live grant (`grant.streams[].connection_id`) or pinned by a grant storage binding remains protected — cleanup refuses it with a precise reason.
- Duplicate-connection safety is preserved: a stale zero-record default-account Reddit row is revocable while a separate data-bearing Reddit connection (its own `connector_instance_id`, non-zero records) stays active and keeps its grant fan-in.
- No PDPP protocol contract change. This is a reference operator tool; the `connector_instances` revoke it performs is the same soft-flip the owner-agent revoke route uses.
