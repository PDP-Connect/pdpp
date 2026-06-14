## 1. Setup Engine Contract

- [x] 1.1 Add a shared setup-plan model covering connector identity, modality, support state, next-step kind, proof gate, deployment readiness, and non-secret documentation metadata.
- [x] 1.2 Implement the setup planner as the single source of truth over connector manifests, static-secret support, local collector support, browser-bound proof state, and deployment readiness.
- [x] 1.3 Add unit tests proving console, owner-agent, and CLI/SDK helper projections receive equivalent plans for local collector, static-secret, browser-bound, provider-authorization, and unsupported connectors.
- [x] 1.4 Add drift tests that fail if a surface introduces a setup modality or supported connector list outside the setup planner.

Progress note: implementation centralizes the setup-plan model and points console catalog, owner-agent intents, CLI setup, provider-authorization readiness, static-secret owner-session setup, and proof-gated browser/static-secret handling at that module. Live provider/browser proof flips remain gated on human-held evidence.

## 2. Console Setup Flow

- [x] 2.1 Replace the console add-connection catalog's hard-coded modality/disposition logic with setup-plan consumption.
- [x] 2.2 Render the add-connection page as a low-copy source picker plus one primary owner next step, with advanced route/runbook details behind disclosure.
- [x] 2.3 Show deployment-readiness blockers separately from per-connection owner actions.
- [x] 2.4 Preserve proof-gated and unsupported states as visible, honest outcomes without dead-end or false-supported copy.
- [x] 2.5 Remove connector-specific data-source labels, examples, and credential copy from Console setup code; render source setup from manifests, setup plans, and connector-authored descriptors instead.

## 3. Owner-Agent, CLI, and SDK-Style Setup Parity

- [x] 3.1 Switch `POST /v1/owner/connections/intents` to project setup plans from the shared planner.
- [x] 3.2 Add or update CLI setup helpers so a human or agent using CLI receives the same setup plan and next-step contract.
- [x] 3.3 Ensure owner-agent setup responses never include provider secrets, owner cookies, browser cookies, or grant-scoped MCP bearer material.
- [x] 3.4 Add black-box tests for owner-agent setup intent responses across supported, proof-gated, deployment-blocked, and unsupported connectors.

## 4. Static-Secret Normal Path

- [x] 4.1 Complete the static-secret proof gate for Gmail and GitHub using the existing draft-capture-first-ingest runbook, without committing secrets.
      Evidence (2026-06-10T22:55Z, ri-owner-current-state.md "STORE-ONLY CREDENTIAL POSTURE LIVE AND PROVEN"):
      gmail run_1781131328336 succeeded (env-free container, store-backed);
      github run_1781131195649 succeeded + run_1781131489458 trigger_kind=scheduled unattended succeeded (4 records);
      slack run_1781131204868 succeeded (also registry-backed, meets the same gate criteria);
      ynab store path proven (token provider-side dead — not a capture-path failure).
      Proof recorded in openspec/changes/fix-scheduled-run-store-credential-injection/tasks.md §4 (task 4.1 checked).
- [x] 4.2 After proof, flip static-secret setup plans from proof-gated/runbook to supported owner-mediated credential capture.
      Done: STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS = ["gmail", "github", "slack"] added to connection-setup-plan.ts;
      isStaticSecretLiveProven() gates the flip; proven connectors return supportState "supported", proofGate null,
      ownerAgentIntent.method "POST". Unproven static-secret connectors (e.g. mailbox) remain proof_gated.
- [ ] 4.3 Prove two accounts for one static-secret connector create two active connection ids with separate credentials.
- [x] 4.4 Update docs so connector-specific source credential env vars are fallback/dev paths, not the normal setup path.
- [x] 4.5 Move static-secret setup form metadata into connector manifests, expose a setup descriptor with credential-key-provider readiness, and block before draft creation when no provider is configured.
- [x] 4.6 Generate the Docker credential encryption key from `scripts/generate-secrets.sh` and keep Railway on an auto-generated template secret.
- [x] 4.7 Widen static-secret credential kinds for sealed multi-field bundles and username/password pairs, and add connection-scoped env injection registry entries for YNAB, Slack, and Reddit.

Progress note: normal static-secret setup no longer requires per-account env vars or runbook archaeology. The console now creates a draft, captures the provider secret from the owner session, and starts first sync. The support-state flip remains proof-gated until live Gmail/GitHub credentials produce no-secret-leak evidence and accepted records.

## 5. Browser-Bound Setup Path

- [x] 5.1 Keep browser-bound setup proof-gated until live browser collector proof is recorded for the connector.
- [ ] 5.2 When proof lands, flip the relevant browser-bound setup plan in the same reviewable unit as the proof artifact.
- [x] 5.3 Add regression tests ensuring unproven browser-bound connectors cannot appear as supported in console, owner-agent, or CLI projections.

## 6. Provider Authorization Path

- [x] 6.1 Add setup-plan support for provider-authorization connectors that distinguishes deployment-level provider app readiness from per-account owner authorization.
- [x] 6.2 Return `needs_deployment_config` when provider app material is missing, with non-secret readiness guidance.
- [x] 6.3 Ensure provider callback/token exchange materializes active connections only after authorization and required account inventory or connection test succeeds.

Progress note: the reference now ships a deterministic provider-authorization
lifecycle boundary with owner-session initiation, callback state validation,
injectable token exchange, account inventory/connection test, credential-store
gating, multi-account connection materialization, and no token leakage in
responses or audit events. Real provider connectors remain gated until their
connector-specific exchanger/inventory adapters are implemented and proven.

## 7. Deployment and Documentation

- [x] 7.1 Update self-host and Railway docs to list only instance-level deployment variables as required normal setup.
- [x] 7.2 Document connector-specific source credential env vars as compatibility fallbacks and local development escape hatches.
- [x] 7.3 Add an operator-facing "add a connection" flow document that points to the console and CLI/owner-agent setup plan rather than connector-specific runbook archaeology.
- [x] 7.4 Document the credential key provider abstraction: Railway generated env-var provider, Docker generated env-var provider, and Docker/Kubernetes file-provider escape hatch.

## 8. Acceptance Checks

- [x] 8.1 Run `openspec validate complete-self-service-connection-onboarding --strict`.
- [x] 8.2 Run `openspec validate --all --strict`.
- [x] 8.3 Run setup planner unit tests and console catalog/render tests.
- [x] 8.4 Run owner-agent connection-intent tests.
- [x] 8.5 Run static-secret and browser-bound proof tests only when their live proof gates are intentionally being flipped.

Progress note: live proof gates were not flipped in this tranche. Static-secret deterministic route tests ran; browser-bound live proof remains gated and therefore its live proof test was intentionally not run.

## 9. Owner Journey Realignment

- [x] 9.1 Update OpenSpec proposal/design/spec deltas so acceptance is the shipped owner add-source journey, not only planner parity.
- [x] 9.2 Stop normal owner UI from advertising unpublished source-card CLI commands, raw setup-planner labels, browser-bound monorepo proof commands, or per-account deployment jargon.
- [x] 9.3 Make static-secret credential help preserve task continuity by opening provider help in a new tab and keeping the form context.
- [x] 9.4 Add an owner-journey acceptance harness that fetches local/live setup surfaces, checks forbidden normal-path strings, and records evidence under `tmp/workstreams/`.
- [x] 9.5 Add visible pending/running/failed setup lifecycle projection for static-secret submissions, backed by setup attempt or connection-health state rather than transient redirect notices.
- [x] 9.6 Rebuild Sources/Connections IA so existing working data, add-new-account support, pending setup, and repair/reconnect actions are distinct on the first screen.
- [ ] 9.7 Productize browser-bound add-account setup as an in-dashboard owner browser flow, absorbing or superseding `add-browser-collector-enrollment-primitive`.
- [x] 9.8 Add clean-shell package freshness tests for every command rendered in normal owner UI before re-enabling any source setup CLI previews.
- [x] 9.9 Add deployment disk/headroom readiness checks for data-heavy reference restarts.
- [x] 9.10 Ensure manifest-declared manual/upload connectors project as manual/import setup rather than local-collector enrollment.
- [x] 9.11 Productize the generic owner file/artifact capture step for `manual_or_upload` connectors.

Progress note (9.4, 9.8): the owner-journey acceptance harness ships at
`scripts/check-owner-journey-acceptance.mjs` (+ pure modules under
`scripts/owner-journey-acceptance/`, tests at
`scripts/check-owner-journey-acceptance.test.mjs`, wired as
`pnpm run owner-journey:acceptance` / `:test`). It scans the normal owner setup
surfaces for every failure class from the walkthrough — developer-only paths
(`packages/...`, `pnpm --dir`, monorepo checkout, source-tree server start),
raw setup-planner labels, placeholder-substitution and env-var-per-account
jargon, same-tab credential help links, and transient-only post-submit flows —
and checks that every command rendered in owner UI is a published subcommand of
`@pdpp/cli` / `@pdpp/local-collector` (surface derived from package source;
`--clean-shell` additionally resolves the published package via
`npx -y <pkg>@<tag> --help`). It runs against local source by default and an
optional live origin with owner auth (`--origin`, `PDPP_OWNER_SESSION_COOKIE` /
`PDPP_OWNER_TOKEN`, never printed), and writes evidence to
`tmp/workstreams/owner-journey-acceptance-<ts>.md`. Building it surfaced one
forbidden string Phase 0 missed: the shared `ServerUnreachable` chrome (rendered
on ~23 dashboard pages incl. `/dashboard/connect`) instructed a
`packages/polyfill-connectors/...` + `node reference-implementation/server/...`
monorepo start — fixed in the same change to deployment-oriented owner copy.
Current owner UI now passes the full scan.

Progress note (9.5): the reference now exposes a durable owner-session
setup-status read, `GET /_ref/connections/:connectorInstanceId/setup-status`,
that resolves a not-yet-ingested static-secret `draft` (as well as an active
connection) and projects its real instance status, non-secret credential
metadata, and current/last run into one owner-facing lifecycle view. The
owner-facing `setup_state` (`awaiting_credential` / `first_sync_running` /
`first_sync_pending` / `first_sync_failed` / `active` / ...) maps onto the
canonical `ConnectionHealthState` taxonomy — no parallel onboarding-only enum,
no new durable table. The in-flight run is linked from the draft through
`controller_active_runs` (keyed on `connector_instance_id`); a terminal failure
is read by run id via `getRunTerminalStatus`. Console submit now redirects to a
durable per-connection status page instead of bouncing back to the form with a
transient `?notice=first_sync_started`. No secret, owner cookie, browser cookie,
or grant-scoped bearer appears in the response or logs.

Progress note (Phase 2 synchronous validation moment, flow design B1/D): the
reference now ships the optional, reference-only credential probe seam described
in the flow design — `probeCredential(secret, context) -> { identity, detail } |
typed error`, with a connector-keyed registry (`@pdpp/polyfill-connectors` →
`credential-probe.ts`). Gmail (IMAP LOGIN, identity = mailbox address) and GitHub
(`GET /user`, identity = login) are wired with an INJECTED transport
(`credential-probe-transport.ts`), so no live provider call occurs in tests. The
probe is NOT promoted to PDPP Core or the Collection Profile (no
`VALIDATE`/`PREFLIGHT` message) and is NOT re-exported from the runner barrel, so
the publishable local-collector slice never carries it. The setup planner /
owner setup descriptor now advertise `validation: synchronous | first_sync`
(projected from the probe registry; serialized in the static-secret-setup
descriptor, the owner-agent intent body, and the owner-connector-templates
`setup_plan`, with matching reference-contract schema fields). The owner-session
static-secret capture route probes a connector's credential BEFORE storing it
when a probe is available: a known-bad credential returns a typed
`static_secret_credential_rejected` (HTTP 400) with a provider-named, owner-causal
message and stores NOTHING (no credential row, audit carries the typed code
only); a valid credential is stored and the response echoes the non-secret
account identity (`identity.account_identity`, `validation: "synchronous"`). The
encryption-key fail-closed (503) is checked before probing. Connectors with no
probe self-report `skipped` and keep the first-sync activation path
(`validation: "first_sync"`, no identity echo). The Console static-secret form
preserves non-secret form context on a validation failure (the secret is never
round-tripped) and shows the identity echo on the status page on success; the UI
stays connector-generic (manifest/setup-plan driven, no connector-specific
branch). New deterministic tests cover wrong/valid Gmail+GitHub probes, the
no-probe first-sync path, and the validation-mode projection across
planner/intent/CLI without secrets.

Progress note: 9.6 now routes the full source setup catalog to `/dashboard/records/add` and keeps `/dashboard/connect` scoped to AI app / agent read-access setup. The Sources first screen shows existing source health, add-another-account support, and repair as distinct facts, while the dedicated Add source page owns the searchable manifest-driven catalog.

Progress note (9.9): deployment headroom now uses the existing diagnostics
surface rather than a second storage panel. `scripts/reference-stack.sh up`
preflights disk headroom before build/restart and blocks the critical
low-space case without deleting data. `/_ref/deployment` now includes a
`disk_headroom` block sourced from the database filesystem, and the dashboard
readiness rows render low-headroom warnings with explicit operator action.

Progress note (9.10): manifest-declared file/import connectors now use
`setup.modality: manual_or_upload` as the owner setup class even when their
runtime binding is filesystem-backed. The planner returns
`manual_upload_pending` / `provide_import_file`, and the source catalog projects
that generically instead of deep-linking to local-device enrollment. Google Maps
declares this setup posture in its manifest. The actual generic dashboard
file/artifact capture primitive is implemented in 9.11.

Progress note (9.11): the reference now has a generic owner-session
manual/upload setup primitive for manifest-declared `manual_or_upload`
connectors with an import binding. The setup planner projects
`manual_upload_connect` / `provide_import_file`; the console catalog links to a
manifest-driven upload page with no connector-specific React branches; the
owner-session staged-artifact route records durable upload status before
connector validation and creates an invisible `draft` connection with
`sourceKind: "manual"` only after a valid non-duplicate artifact is ready to
stage. The first run starts through the same connection run path as other
setups. The run environment resolver injects the connection-scoped import
directory for manual/upload runs, so schedulers and owner-triggered runs share
one path. The durable setup-status page is now
generic (`/dashboard/connect/status/:connectionId`) and distinguishes
`setup_kind: manual_upload` from static-secret setup, so file imports never show
"credential missing" copy. Owner-facing responses do not expose import
directories, env-var plumbing, file contents, provider secrets, browser cookies,
or bearer material. Deterministic route, planner, console, CLI, contract, and
OpenSpec checks are green. Live end-to-end Google Maps Timeline import remains
owner-data gated: it requires the owner to provide a real Timeline export and a
deployed image containing this tranche.

## 10. Google Maps Timeline Refresh UX

- [x] 10.1 Promote the decided Google Maps Timeline refresh plan into connector-authored setup metadata: platform export guidance, official help links, accepted formats, validation expectations, primary/secondary acquisition methods, and large-file fallback copy.
- [ ] 10.2 Ensure the Add source and source detail flows render Google Maps Timeline as phone-first guided import/refresh, not live OAuth sync, desktop scraping, local collector enrollment, or maintainer runbook setup.
- [ ] 10.3 Add pre-ingest validation feedback for Timeline uploads: detected format, estimated point/segment counts, detected date range, duplicate/stale/empty status, and concrete remediation for unsupported files.
- [ ] 10.4 Preserve one source identity across equivalent Timeline acquisition methods while recording acquisition method, source format, coverage, and import provenance per run or record batch.
- [x] 10.5 Model scheduled Takeout as an advanced/probe lane that can enable best-effort recurring imports only after the first archive proves current Timeline records, and otherwise steers back to phone export/share.
- [x] 10.6 Keep Google Maps Data Portability as a separate provider-authorization source and prevent UI or setup-plan copy from claiming it supplies Timeline points/segments.
- [ ] 10.7 Add owner-journey acceptance checks proving the Timeline flow contains no PDPP developer vocabulary, no repo/package-internal commands, no fake OAuth claim, and no source-specific Console UI branch.
- [ ] 10.8 Complete an owner-gated live pilot with a contemporary Timeline export or record the parser-format residual risk before archive.
- [x] 10.9 Add Timeline refresh governance tests proving valid uploads start validation/import without a fixed cooldown, Takeout cadence is scoped to the Takeout probe lane, and checkpoint/provenance state is recorded at the earliest coverage-safe boundary available to the parser/run model.

Progress note: this tranche added manifest-authored Timeline acquisition metadata, generic manual/upload rendering, a pure Timeline artifact validator with duplicate/stale/empty/unsupported/large-file remediation, and owner-session route validation before draft creation. Valid uploads store non-secret validation evidence and acquisition provenance in the manual-upload source binding without fixed cooldown fields; Takeout appears only as an advanced probe in connector metadata. The Add source/manual upload flow is covered, but route-level duplicate/stale detection still needs connection-history inputs, source-detail refresh that reuses an existing connection/source identity remains open in 10.2/10.4, and owner live pilot remains open in 10.8.

## 11. Manual/import UX Correction

- [x] 11.1 Configure the Console proxy/action upload body limit so manifest-accepted manual-upload artifacts are not rejected by Next before the reference validator runs.
- [x] 11.2 Make import the primary one-submit action; keep preview as an optional inspection action rather than a mandatory gate.
- [x] 11.3 Derive WhatsApp chat source identity from connector validation metadata and use it to suggest the new source label.
- [x] 11.4 Route manual-upload validation through a connector-package registry instead of reference-route connector branches.
- [x] 11.5 Let manual/upload owners explicitly choose new source vs. existing compatible source and edit the new-source label; artifact identity may suggest but must not auto-merge.
- [x] 11.6 Move normal manual/upload transfer off Server Action multipart parsing; add connector max-size preflight, upload progress, and multi-file import into one selected source.
- [x] 11.7 Promote normal manual/upload transfer to streamed staged artifacts with durable status polling; invalid and duplicate uploads must not create phantom source connections, and same-named artifacts must not overwrite each other before import.
- [x] 11.8 Import media-bearing WhatsApp zip exports as attachment records with blob references when runtime blob upload is available, or explicit deferred/failed hydration state otherwise.
- [x] 11.9 Align WhatsApp, Console proxy, and reference route upload limits so hundreds-of-megabytes media zip exports use the normal staged browser path instead of a stale small-file fallback.
- [x] 11.10 Scope runtime record ingest, blob upload, and state checkpoints to the explicit draft connection id, and admit explicitly addressed drafts on owner-authenticated state read/write routes so manual/import first sync cannot split records and checkpoints across sibling connections.

Progress note (11.7): the normal Console import path now posts each selected
file to a reference staged-artifact route using
`application/vnd.pdpp.manual-upload`, polls
`/_ref/manual-upload/artifacts/:artifactId`, and starts the import run only
after at least one artifact reaches `staged`. New-source uploads create no
connection at `uploaded`/`validating`; a source is created only after a valid,
non-duplicate artifact passes connector validation. Exact duplicate staged
uploads point at the existing receipt without creating another source, invalid
uploads fail with durable artifact status and no connection row, and each staged
artifact is moved under its own artifact directory so same-named exports can
coexist. The WhatsApp file connector now discovers supported export files
recursively so the generic artifact-directory layout works without
connector-specific Console code. Focused route and Console invariant tests are
green.

Progress note (11.8): WhatsApp zip exports with media now validate as
`included_for_import` and the connector declares an `attachments` stream. The
connector emits one attachment record per media file with stable id,
chat/message linkage when detectable, content hash, MIME type, size, hydration
status, and a standard `blob_ref` when `PDPP_RS_URL`/`RS_URL` plus
`PDPP_OWNER_TOKEN` are present. Missing blob upload config no longer lets the UI
claim "with media" while dropping the bytes; records surface
`hydration_status: "deferred"`. A real connector subprocess test stages a
WhatsApp zip in a nested artifact directory and proves `chats`, `messages`, and
`attachments` records are emitted through the production JSONL protocol.

Progress note (11.9): WhatsApp's manifest cap, the Console proxy/body envelope,
and the reference staged-artifact route now align at a 1 GiB explicit
deployment envelope. A 301 MB media zip therefore follows the normal browser
upload/import path; import-folder handoff remains reserved for artifacts above
that envelope.

Progress note (11.10): Live WhatsApp import `run_1781411486188` accepted blobs
and records, then failed at the final `/v1/state/:connectorId` checkpoint
because the explicit manual-upload connection was still `draft`. Live DB smoke
also showed those records landed under sibling connection
`cin_8e7ed2230aa9d110fdfdc1da` while the draft
`cin_539833f9f2d11bc0f58bbb00` stayed draft, proving the runtime mutation path
was not connection-scoped end-to-end. The runtime now sends
`connector_instance_id` on record ingest, the shared reference blob uploader
sends it for blob upload, and the owner-authenticated state routes mirror the
ingest route's explicit draft-admission rule for non-grant state reads/writes.
Drafts remain hidden from normal read/grant surfaces and still activate only
after accepted records; regressions prove ingest and checkpoint URLs carry the
same explicit connection id, blob upload carries it, and state can be written
and read for an explicit draft without activating it.
