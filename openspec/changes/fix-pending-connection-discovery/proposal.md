## Why

An owner reported that after creating a brand-new credential-backed connection, a push notification was the only way to find or continue the first interactive sync — the newly created connection was absent from Sources, Syncs, and even direct-by-id navigation to its own detail page.

Root cause: a fresh connection is created as a `connector_instances` row with `status: "draft"`. `draft` was deliberately excluded from `listByOwner` (the single choke point backing `/_ref/connections`, `/_ref/connector-instances`, owner-agent reads, templates, and device-exporter listings) to avoid a prior phantom-row bug — before that fix, merely viewing the dashboard with zero connections silently persisted ~14 `status: 'active'` default-account rows. That was the right call for those surfaces. But `listConnectorInstanceRowsForDashboard` (the read backing the owner-facing dashboard, Sources, Syncs, and `getConnectorSummaryForRoute`) reused the SAME `listByOwner`, so it inherited the draft exclusion too — with no replacement discovery mechanism. A draft connection was therefore invisible to every owner-navigable surface until its first successful ingest flipped it to `active`.

The only reason a push notification worked at all is that it is keyed by `run_id` in a completely separate, unfiltered namespace (`/syncs/{run_id}`) — an accident of the notification path's design, not a deliberate discovery mechanism. If the owner missed or dismissed the notification and had no bookmarked `/connect/status/:id` URL, the connection was effectively unreachable through the UI.

A second, related bug was found and fixed during implementation: the first-ingest draft→active activation (`maybeActivateDraftAfterIngest` in `rs-mutation.ts`) never invalidated the dashboard/Sources/Syncs summary cache, unlike every other connection-mutating route (revoke, reactivate, schedule, run, rename, delete). This meant the summary feed could keep serving a stale `draft`/`setup_in_progress` row for up to the cache's TTL (default 5s) after the connection had actually activated — a real, if narrow, stale-state window.

## What Changes

- `listConnectorInstanceRowsForDashboard` (the read backing `/_ref/connectors` — Sources, Syncs, source-detail) now includes `draft` connections via a new, narrowly-scoped store method (`listByOwnerIncludingDrafts`). Every other consumer of `listByOwner` (`/_ref/connections`, `/_ref/connector-instances`, owner-agent reads, templates, device-exporter listings) is unchanged and still hides drafts — this is a deliberate, scoped exception, not a removal of the prior phantom-row protection.
- A new closed `owner-state.ts` resolver, `setup_in_progress`, derived from explicit `draft` lifecycle evidence with the same top-priority, evidence-only discipline as the existing `retired` resolver. Never falls through to `healthy`, `not_measured`, or any verdict-derived tone.
- The console's `source-actionability.ts` projects `setup_in_progress` into a distinct, honest status (`pending` status kind, "Setup in progress" label) that overrides any verdict-derived tone — mirroring how `revoked` already overrides it.
- Every visible Continue/Open action for a draft connection — the Sources row link (`detailHref`), the next-action CTA, the passport-foot action, and a new Syncs "pending setup" card — resolves to the SAME authoritative target: `/connect/status/:id`, the existing durable, binding-agnostic status page (already resolves `draft` for both static-secret and browser-enrollment-shell setups). No H-E-B or connector-specific special-casing.
- Direct/bookmarked navigation to a draft connection's `/sources/:id` now redirects to `/connect/status/:id` instead of 404ing.
- Syncs gets a new `PendingSetupCard` — a distinct needs-you-tier card for a draft connection, since it has no run history to build a `SyncGroup` or `FailureCard` from.
- Fixed the first-ingest activation cache-invalidation gap: `maybeActivateDraftAfterIngest` now calls `invalidateConnectorSummariesCache()` after activating a draft, matching every other connection-mutating route, so the summary feed reflects `draft → active` immediately rather than up to 5s later.
- Push notifications are unchanged — they remain a supplementary, faster path, not the only path.

## Capabilities

Modified:

- `reference-connection-health`

## Impact

- A freshly created connection is discoverable in Sources and Syncs immediately, labeled honestly as "Setup in progress," with a working Continue action, even before any push notification arrives or is acted on.
- No connector is special-cased; the fix is a lifecycle-status projection change, reachable by any static-secret or browser-enrollment-shell connector.
- `/_ref/connections`, `/_ref/connector-instances`, owner-agent reads, `owner-connector-templates.ts`, and device-exporter listings are unchanged — drafts remain invisible there, preserving the original phantom-row protection those surfaces depend on.
- The dashboard/Sources/Syncs summary feed no longer has a stale-cache window after first-ingest activation.
