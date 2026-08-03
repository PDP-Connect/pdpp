# Dropped-parameter audit — HTTP route + operations layer

Scope: `reference-implementation/server/routes/*.ts` and `reference-implementation/operations/*/index.ts`
(all 49 route files, all ~60 operation files). Method: five parallel full-file reads tracing every
parsed query/body param to its terminal consumer, followed by direct verification of two leads that
crossed the stated scope boundary. Read-only; no code changed.

Defect class: an HTTP query/body param that is parsed, validated, typed, or documented, but never
actually applied to the underlying query/operation — the API looks like it supports the feature and
silently does nothing.

Note on the seed example: the `/grants?cursor=...` bug (`postgresListSpineCorrelations` accepting
`filters.cursor`, emitting `next_cursor`, never applying it in the WHERE/HAVING clause) is **already
fixed** on this branch, commit `2cf19f824` ("fix(ri): apply keyset cursor on the Postgres spine
correlation list"), with a regression test at `scripts/audit-pg-sqlite-parity.mjs`. It is out of scope
for this report and not re-listed as a finding.

## Confirmed findings

### 1. `resource` param validated then discarded in MCP device authorization (P2 — dead validation, not a broken feature)

- **Parse + validate site**: `reference-implementation/server/routes/as-oauth.ts:120-149`
  (function `handleMcpDeviceAuthorization`, lines 116-171). `resource` is read from the body
  (line 120), required — 400 if missing (lines 124-126) — then forwarded into
  `ctx.initiateMcpDeviceAuth({ clientId, resource, authorizationDetails }, { baseUrl })` at line 149.
- **Apply site (where it stops being used)**: `reference-implementation/server/index.js:3030-3070`,
  the `initiateMcpDeviceAuth` implementation injected as `ctx`:

  ```js
  initiateMcpDeviceAuth: async ({ clientId, resource, authorizationDetails }, opts2) => {
    let resourceUrl;
    try {
      resourceUrl = new URL(resource);
    } catch {
      const err = new Error('resource must be an absolute MCP protected-resource URL');
      err.code = 'invalid_request';
      throw err;
    }
    if (resourceUrl.pathname !== '/mcp') {
      const err = new Error('resource must identify the hosted MCP protected resource');
      err.code = 'invalid_request';
      throw err;
    }

    const initiated = await consentStore.initiateGrant(
      {
        client_id: clientId,
        authorization_details: authorizationDetails,
      },
      { baseUrl: opts2.baseUrl, nativeManifest: resolveNativeManifest(opts) },
    );
    ...
  ```

  `resource`/`resourceUrl` appears only in those four lines (parse + two shape checks) and never
  again in the function. It is not passed into `consentStore.initiateGrant` (only `client_id` and
  `authorization_details` are), not stored on the pending-consent row, and not threaded through
  `authorization_details`.

- **Call chain**: `as-oauth.ts:handleMcpDeviceAuthorization` → `ctx.initiateMcpDeviceAuth`
  (`server/index.js:3030`) → `consentStore.initiateGrant` → `auth.js:initiateGrant` (line 2687) →
  `normalizePendingGrantRequest`/`createPendingConsent`. I read `auth.js:initiateGrant` in full
  (lines 2687-2746) and confirmed `resource` does not appear anywhere in its input object or in
  `normalizePendingGrantRequest`.
- **Verified it isn't used downstream in token issuance either**: `auth.js:issueToken` (line 5731+)
  and the `tokens` table INSERT (`INSERT INTO tokens(token_id, grant_id, subject_id, client_id,
  token_kind, expires_at)`) have no resource/audience column — this reference implementation has no
  RFC 8707 resource-indicator concept anywhere in the token model. Grep for
  `resource_indicator`/`8707`/`audience` across `reference-implementation/` returned nothing relevant.
- **Failure scenario**: A client can pass `resource=https://anything.example/mcp` (any host, as long
  as the path is `/mcp`) and it is accepted identically to the real deployment's own MCP resource URL
  — the value is checked for *shape* only, never checked for *identity* against the actual protected
  resource, and never bound to the issued grant or token. In a single-tenant reference deployment this
  has no practical exploit surface (there is only one MCP resource to begin with), but the code reads
  as if it validates the caller is requesting access to *this* resource, when it only validates that
  the string looks like a URL ending in `/mcp`.
- **Why P2, not P0/P1**: this is not a regression of previously-working pagination/filtering (the
  seed bug's shape). It is a parameter that was clearly intended to support RFC 8707-style resource
  binding (the two `err.code = 'invalid_request'` checks are deliberate validation, which per the
  brief's own heuristic is "strong evidence the author intended the param to work") but the binding
  itself — storing `resource` on the grant/token and enforcing it at introspection/use time — was
  never implemented. No user-visible "Next page returns page 1" style silent corruption; the
  observable effect is that the resource check is decorative rather than a real access-control
  boundary. Flagging as P2 because it is a genuine gap between apparent and actual behavior, but it
  degrades to "TODO left in validation code" severity rather than "feature silently broken" severity
  given there's only ever one valid resource in this reference deployment.

## Non-findings worth recording (checked because they crossed the stated file-scope boundary and looked identical in shape to the seed bug)

These were raised as UNVERIFIED by the sub-audits because their terminal consumer lives outside
`server/routes/*.ts` and `operations/*/index.ts` (in `server/auth.js` / `server/stores/*.js`). I
followed both to their concrete apply sites and they are **not defects**:

- **`sourceNarrowing` / `approvedSourceIndexes` / `confirmedApproveAll` / `ai_training_consented`**
  (parsed at `as-consent.ts:465-489`, forwarded as `approveOptions` into
  `operations/as-consent-decision/index.ts:167-172`, which calls `deps.approveGrant(...)`). The real
  implementation is `auth.js:approveGrant` (line 3484) and, for batch requests,
  `auth.js:approveStagedGrantBatch` (line 3185). Read both in full:
  - `ai_training_consented` is read at `auth.js:3535` and gates a hard `invalid_request` throw at
    3536-3541 if the purpose is `ai_training` and consent wasn't given; also persisted via
    `markPendingConsentApproved(... aiTrainingConsented: ai_training_consented)` at 3642.
  - `approvedSourceIndexes` drives `resolveApprovedEntryIndexes(request, opts)` at 3191 and an
    approve-all gate at 3192-3208.
  - `confirmedApproveAll` is checked at 3203 and throws `invalid_request` (`param:
    'confirm_approve_all'`) if approve-all was implied but not re-confirmed.
  - `sourceNarrowing` is validated against the approved index set at 3256-3266 (rejects narrowing
    directives for sources that weren't approved — "must not silently no-op" per the code comment)
    and applied per-entry via `narrowResolvedSelectionForSource(baselineStreams,
    sourceNarrowing[stagedIndex], ...)` at 3297-3301.
  All four params are genuinely read and enforced, with fail-closed validation. Non-finding.

## Routes and operations examined and found clean

Full coverage across five parallel audits, each reading every file below in its entirety (not
signature-skimmed) and tracing every parsed param to a concrete apply site:

**Batch A — rs-read / rs-mutation / records / search:**
`server/routes/rs-read.ts`, `server/routes/rs-mutation.ts`,
`operations/rs-records-list`, `rs-records-detail`, `rs-records-delete`, `rs-records-delete-stream`,
`rs-records-ingest`, `rs-search-hybrid`, `rs-search-lexical`, `rs-search-semantic`, `rs-streams-list`,
`rs-streams-detail`, `rs-streams-aggregate`, `rs-schema-get`.
(A handful of params — `field-window` selector args, `record-detail` expand options, `records-list`
cursor/filter — are forwarded into host-injected substrate capabilities (`ctx.getRecordFieldWindowAcrossBindings`,
`ctx.queryRecordsAcrossBindings`, etc.) that live below the operations layer by explicit architectural
boundary ("this module SHALL NOT speak SQL"). Wiring into those capabilities was confirmed intact;
the capabilities' internal SQL was not re-audited as it's outside both the routes and operations
layers this task scoped.)

**Batch B — ref-connectors / ref-grants / ref-admin / ref-dataset:**
`server/routes/ref-connectors.ts`, `ref-grants.ts`, `ref-admin.ts`, `ref-dataset.ts`,
`ref-run-status.ts`, `ref-error-status.ts`, `run-cancel.ts`, `run-interaction.ts`,
`operations/ref-connectors-list`, `ref-connectors-detail`, `ref-connector-schedule-get`,
`ref-schedules-list`, `ref-approvals-list`, `ref-clients-list`, `ref-client-tokens-list`,
`ref-client-token-revoke`, `ref-client-event-subscriptions-list`, `ref-client-event-subscriptions-get`,
`ref-client-event-subscriptions-disable`, `ref-dataset-summary`, `ref-dataset-summary-streams`,
`ref-deployment`, `ref-records-timeline`.
(Confirmed the `/grant-packages` cursor pagination — a separate implementation from the fixed
`/grants` bug — genuinely applies its cursor on both Postgres and SQLite backends. Not a duplicate.)

**Batch C — owner-connection\* family:**
`server/routes/owner-connections.ts`, `owner-connection-delete.ts`, `owner-connection-diagnostics.ts`,
`owner-connection-intent.ts`, `owner-connection-reactivate.ts`, `owner-connection-revoke.ts`,
`owner-connection-run.ts`, `owner-connection-schedule.ts`, `owner-connector-templates.ts`,
`owner-control.ts`, `_owner-connection-helpers.ts`, `connector-source-kind.ts`.
(No pagination/sort surface in this family at all — only `connector_id`/`status` list filters and a
handful of path-scoped mutations, all wired correctly, including the highest-risk shape checked —
`allowStatuses` threaded through 3 layers in the reactivate flow.)

**Batch D — AS OAuth family:**
`server/routes/as-agent-connect.ts`, `as-authorize.ts`, `as-consent-ui-helpers.ts`, `as-consent.ts`,
`as-dcr.ts`, `as-device-ui.ts`, `as-grant-revoke.ts`, `as-oauth.ts`, `as-par.ts`,
`as-polyfill-connectors.ts`, `client-metadata.ts`,
`operations/as-authorization-server-metadata`, `as-client-event-subscriptions`, `as-consent-decision`,
`as-consent-exchange`, `as-dcr-delete`, `as-dcr-register`, `as-dcr-update`,
`as-device-authorization-init`, `as-device-decision`, `as-device-token-exchange`,
`as-discovery-index`, `as-grant-revoke`, `as-introspect`, `as-par-create`,
`as-polyfill-connector-detail`, `as-polyfill-connector-register`.
(This is where the one confirmed finding above was surfaced as an UNVERIFIED lead, then resolved by
direct read of `server/index.js`.)

**Batch E — device exporters / manual upload / provider auth / spine / hosted MCP / misc:**
`server/routes/ref-browser-enrollment-shell.ts`, `ref-device-exporter-sanitize.ts`,
`ref-device-exporters.ts`, `ref-manual-upload-draft-connection.ts`, `ref-provider-auth.ts`,
`ref-spine-correlations.ts` (minus the already-fixed cursor bug), `ref-spine-timelines.ts`,
`ref-static-secret-credentials.ts`, `ref-static-secret-draft-connection.ts`,
`ref-static-secret-setup-status.ts`, `root-and-discovery.ts`, `rs-hosted-mcp.ts`,
`source-webhooks.ts`, `web-push.ts`, `hosted-ui-asset.ts`,
`operations/ref-records-timeline`, `ref-source-webhook-ingest`, `ref-spine-correlations-list` (minus
known bug), `ref-spine-events-page`, `ref-spine-search`, `rs-blobs-read`, `rs-blobs-upload`,
`rs-client-event-deliver`, `rs-client-event-derive`, `rs-connectors-list`, `rs-connector-state-get`,
`rs-connector-state-put`, `rs-discovery-index`, `rs-explore-record-buckets`, `rs-explore-timeline`,
`rs-protected-resource-metadata`, `read-projection.ts`.
(Confirmed the already-fixed cursor bug is narrowly contained to
`postgresListSpineCorrelations` — sibling paths, including the event-page timeline cursor on both
backends, correctly apply their cursors.)

## Summary

- **Confirmed findings: 1** (P2 — `resource` param in MCP device authorization, validated for shape
  then discarded; no downstream resource/audience binding exists in this reference implementation's
  token model at all, so this reads as an unfinished RFC 8707 stub rather than a regression of a
  previously-working feature).
- **Unverified: 0** remaining — the two leads that crossed the file-scope boundary during sub-audits
  (`consent-store.js` `approveGrant`/`approveStagedGrantBatch`, and `server/index.js`
  `initiateMcpDeviceAuth`) were both run to ground: the consent-decision params are genuine
  non-findings (fully applied, fail-closed), and the `resource` param is the one confirmed finding
  above.
- **Most severe issue**: the `resource` finding is the only one found, and it is low severity — dead
  validation code, not a silent-corruption bug like the seed `/grants` cursor defect (which is already
  fixed on this branch). No pagination, filtering, or sorting param anywhere in the audited 49 route
  files + ~60 operation files was found to reproduce the seed defect's shape.
