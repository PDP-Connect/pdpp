# Tasks

## 1. Storage + status support for `draft`

- [x] 1.1 Add `'draft'` to `VALID_STATUSES` in
  `server/stores/connector-instance-store.js` so `normalizeRecord` and
  `updateStatus` admit it on both arms.
- [x] 1.2 Widen the SQLite `connector_instances.status` CHECK to include
  `'draft'` in the base DDL (`server/db.js`).
- [x] 1.3 Add a forward CHECK-widening migration
  `migrateConnectorInstancesStatusDraft` mirroring
  `migrateConnectorInstancesSourceKindBrowserCollector`, no-op once the
  constraint already names `'draft'`, registered alongside the existing
  connector-instance migrations.
- [x] 1.4 Add a store primitive `activateDraft(connectorInstanceId, { now })`
  on both SQLite and Postgres arms: flip `draft → active`; no-op if the row is
  not `draft` (idempotent, concurrency-safe).
- [x] 1.5 Widen the Postgres `connector_instances.status` CHECK in fresh
  bootstrap and legacy bootstrap so live Postgres deployments admit `draft`.
- [x] 1.6 Test: status admission, migration idempotency, Postgres legacy
  CHECK widening, `activateDraft` flip +
  no-op guard.

## 2. Read-surface exclusion for drafts

- [x] 2.1 Exclude `draft` from `listByOwner` by default on both arms (the single
  choke point covering `/_ref/connections`, `/_ref/connector-instances`, the
  dashboard, owner-agent connection reads, templates, device-exporter listings).
- [x] 2.2 Confirm `resolveActiveByConnector` / `listActiveByConnector` remain
  active-only (already SQL-filtered).
- [x] 2.3 Test: a draft does not appear on `/_ref/connections`,
  `/_ref/connector-instances`, or the dashboard listing; `get`/`getByBinding`
  still return it for owner-internal lookups.

## 3. Resolver `allowStatuses` admission

- [x] 3.1 Add `allowStatuses` (default `['active']`) to
  `resolveOwnerConnectorInstanceNamespace`; admit an explicitly addressed
  instance whose status is in the set, else throw `connector_instance_inactive`
  unchanged.
- [x] 3.2 Thread `allowStatuses` through the host
  `resolveOwnerConnectorNamespace` (`server/index.js`).
- [x] 3.3 Test: default rejects draft; `['active','draft']` admits draft;
  connector-only resolution is unaffected.

## 4. Owner-session draft-create route

- [x] 4.1 Add `POST /_ref/connectors/:connectorId/draft-connection`
  (`requireOwnerSession`): reject non-static-secret connector
  (`409 static_secret_credential_unsupported`); create one `draft` instance with
  `sourceKind: 'account'` and a random `sourceBindingKey`; return `connection_id`
  + typed next step; emit non-secret
  `owner.connection.static_secret_draft.create` audit.
- [x] 4.2 Mount the route in `server/index.js` with its context.
- [x] 4.3 Test: draft created for gmail/github; rejected for non-static-secret;
  two creates → two distinct ids; no secret in response or audit; not visible on
  reads.

## 5. Capture admits a draft target

- [x] 5.1 Pass `allowStatuses: ['active', 'draft']` in the capture route's
  namespace resolution (`server/routes/ref-static-secret-credentials.ts`); no
  other change.
- [x] 5.2 Test: owner-session capture seals onto a draft; bearer/agent cannot
  reach the draft as a target.

## 6. First-ingest activation

- [x] 6.1 In `mountRsRecordsIngest` (`server/routes/rs-mutation.ts`): pass
  `allowStatuses: ['active','draft']` when an explicit `connector_instance_id`
  addresses the target; after a successful ingest with `records_accepted > 0`,
  if the resolved instance was `draft`, call `store.activateDraft`.
- [x] 6.2 Test: first ingest with records flips draft → active and the
  connection becomes visible; zero-record/failed ingest leaves it draft.

## 7. Validation

- [x] 7.1 `openspec validate add-static-secret-owner-session-connect-path
  --strict`.
- [x] 7.2 Focused reference-implementation tests added in tranches above.
- [x] 7.3 `pnpm --dir reference-implementation run verify` (tsc + lint) when
  source changes.
- [x] 7.4 `git diff --check`.

## 8. Console add-connection surface (owner discoverability)

Closes the design's first Open Question ("should the dashboard surface the
static-secret path?") for the **creation entry point**. Lane:
`ri-static-secret-owner-connect-live-closeout-v1`. No backend change — the
console reads shipped manifests and routes Gmail/GitHub to an honest disposition.

- [x] 8.1 Add a `static_secret_connect` catalog disposition
  (`apps/console/src/app/dashboard/lib/connection-catalog.ts`): a network-class
  connector in `STATIC_SECRET_CONNECTORS` routes here instead of
  `api_network_unsupported`. No enrollment deep-link (Gmail/GitHub are not
  device-collectors), so the picker's exactly-two-deep-links invariant holds.
- [x] 8.2 Add `STATIC_SECRET_CONNECTORS` + `isStaticSecretConnector` +
  `STATIC_SECRET_ADD_MODALITY` + `STATIC_SECRET_RUNBOOK_PATH`
  (`apps/console/src/app/dashboard/lib/connection-modality.ts`). The connector
  set is test-pinned to the keys of `STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR`
  in `ref-static-secret-credentials.ts` (single source of truth, no drift).
- [x] 8.3 Render the static-secret group in the add-connection picker
  (`records-list-view.tsx`), inside the "Other connectors" disclosure:
  runbook-pointed, live-proof-caveated, NOT one-click, NOT deep-linked. Scope the
  `api_network` unsupported examples to the connectors that still have no owner
  connect route (Gmail/GitHub removed from that bucket).
- [x] 8.4 Add `docs/operator/static-secret-connection-runbook.md`: the owner
  draft → capture → first-ingest sequence and the live-proof packet (no-secret
  checks + what justifies the D.1/D.2 flip). Pinned to a committed doc by the
  console test.
- [x] 8.5 Tests: catalog disposition split, connector-set/backend pin, runbook
  resolution, picker group render, deep-link invariant, api_network examples
  exclude the static-secret connectors. `types:check` + `ultracite check` green.
- [ ] 8.6 (Deferred to a later console lane) A "setup in progress" surface that
  lists the owner's existing `draft` connections mid-flow (the design's Open
  Question for *drafts*, distinct from this creation entry point). Out of scope:
  drafts are invisible by construction and harmless; this is a separate slice.

## Notes / residual

- Tasks 1.4 and 2.1 cover BOTH the SQLite and Postgres store arms. Postgres was
  proven with `PDPP_TEST_POSTGRES_URL` against a temporary local Postgres
  database: the legacy narrow-CHECK bootstrap widens to admit `draft`, and the
  conformance test proves draft invisibility, explicit admission, activation,
  and no-op activation.
- The console static-secret surface (§8) is owner *discoverability* only — it
  does NOT flip the `api_network` intent branch or the catalog descriptor to
  supported (still D.2, gated on D.1 live proof). It surfaces the real
  owner-session path with an explicit live-proof caveat and a runbook pointer.

## Deferred (owner/live-gated — NOT in this lane)

- [ ] D.1 Live end-to-end proof: real Gmail app password / GitHub PAT, live
  IMAP/API, `draft → capture → first ingest → addressable connection_id`, two
  real mailboxes → two `connection_id`s, audit asserts no secret leak.
- [ ] D.2 `api_network` owner-agent intent branch + catalog descriptor flip from
  `unsupported`, in the same reviewable unit as D.1.
- [ ] D.3 Stale-draft cleanup/TTL primitive.
