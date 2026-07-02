# Design: Owner Console Product Experience

## 1. Inputs

Primary feedback:

- `docs/inbox/the owner-feedback-6-18-26.md`

Project context:

- `design-notes/full-context-refresh.md`
- `design-notes/owner-console-slvp-execution-plan-2026-06-16.md`
- `design-notes/post-owner-journey-broader-work-ledger-2026-06-18.md`
- `docs/voice-and-framing.md`

Research and prior art:

- `docs/research/product-leadership-aperture-and-discovery-2026-06-18.md`
- `docs/research/control-plane-prior-art.md`
- `docs/research/trace-surface-patterns.md`
- `docs/research/reference-implementation-ux-prior-art.md`
- `docs/research/sources-slvp-redesign-and-data-health-2026-06-11.md`
- `docs/research/slvp-connector-health-FINAL-design-2026-06-15.md`
- `docs/research/owner-console-product-gestalt-and-data-dignity-prior-art-2026-06-18.md`
- `docs/research/owner-console-record-workbench-explore-prior-art-2026-06-18.md`
- `docs/research/owner-console-add-data-connector-setup-prior-art-2026-06-18.md`
- `docs/research/owner-console-source-inventory-and-detail-prior-art-2026-06-18.md`
- `docs/research/owner-console-recovery-and-liveness-prior-art-2026-06-18.md`
- `docs/research/owner-console-access-review-grants-clients-prior-art-2026-06-18.md`
- `docs/research/owner-console-evidence-timelines-runs-traces-prior-art-2026-06-18.md`
- `docs/research/owner-console-mobile-responsive-and-craft-prior-art-2026-06-18.md`
- `docs/research/owner-console-copy-and-microcopy-prior-art-2026-06-18.md`
- `docs/research/owner-console-fresh-non-owner-journey-prior-art-2026-06-18.md`
- `docs/research/owner-console-slvp-prior-art-index-2026-06-18.md`

Worker reports:

- `tmp/workstreams/feedback-taxonomy-20260618.md`
- `tmp/workstreams/feedback-ia-model-20260618.md`
- `tmp/workstreams/feedback-prior-art-20260618.md`
- `tmp/workstreams/feedback-technical-probes-20260618.md`
- `tmp/workstreams/feedback-contract-matrix-20260618.md`
- `tmp/workstreams/feedback-empathy-reconstruct-20260618.md`
- `tmp/workstreams/feedback-critical-path-20260618.md`
- `tmp/workstreams/feedback-adjacent-classes-20260618.md`
- `tmp/workstreams/feedback-plan-redteam-20260618.md`
- `tmp/workstreams/feedback-technical-contracts-20260618.md`

Additional research:

- `docs/research/explorer-workbench-and-access-transparency-prior-art-2026-06-18.md`

Lane closeout:

- `tmp/workstreams/owner-console-slvp-prior-art-ultracode-20260618.md`

OpenSpec design notes:

- `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-route-noun-inventory-20260618.md`
- `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-journey-atlas-packet-20260618.md`
- `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-implementation-packets-20260618.md`
- `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-noun-model-decision-20260618.md`
- `openspec/changes/redesign-owner-console-product-experience/design-notes/initial-live-atlas-pass-20260618.md`
- `openspec/changes/redesign-owner-console-product-experience/design-notes/friction-to-slvp-direction-20260618.md`
- `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-spine-charter-synthesis-20260618.md`
- `openspec/changes/redesign-owner-console-product-experience/design-notes/feedback-refresh-20260619.md`
- `openspec/changes/redesign-owner-console-product-experience/design-notes/surface-architecture-and-truth-packets-20260701.md`

## 2. Leadership Aperture

The failure mode was not lack of effort. It was the wrong aperture.

The previous loop moved directly from observed complaints to route-local fixes. That narrowed too early. The right sequence is:

1. Wide aperture: classify the whole owner journey and product system failures.
2. Medium aperture: derive the essential nouns, information architecture, state model, and gates.
3. Narrow aperture: dispatch implementation packets only after acceptance checks are defined.

This is the practical application of the leadership-aperture research: a product owner must move between system, strategy, and task lenses instead of treating every feedback note as a ticket.

## 3. Product Promise

The console succeeds when a motivated personal-server owner can truthfully say:

- I know what data I have.
- I know how to add more.
- I know what is broken.
- I know what to do next.
- I trust this system.

The console does not need to be a consumer social app. It does need to feel serious, calm, precise, and worth sharing with engineers, standards reviewers, family, friends, and curious external users who are willing to operate a personal-data server.

## 4. What the owner's Feedback Means

The feedback is baseline evidence, not a complete backlog. It contains many concrete defects, but the core signal is systemic:

- The same object is named differently across nav, URLs, headings, and IDs.
- The same fact is computed differently across surfaces.
- Internal runtime/debug terms leak into owner paths.
- Primary actions sometimes lead to dead ends, forensic pages, or unrelated setup pages.
- Runs, traces, diagnostics, schedules, and device exporters are promoted as first-class destinations even when the owner is trying to manage a source.
- Explore, stream detail, and source stream tables overlap without a crisp relationship.
- Grants, packages, reads, traces, and owner tokens are shown as artifacts without enough semantic explanation of what the owner granted or what read occurred.
- Local collector recovery gives commands but not a human explanation, progress, or a closed loop.
- Bounded samples and artificial caps are not an acceptable substitute for full visibility; they are allowed only as labeled previews with a direct path to the full paginated or virtualized set.

The root cause is incidental complexity: implementation growth leaked into product shape. The answer is not to decorate the current routes. The answer is to collapse the console to the essential objects and make every evidence layer subordinate to the subject it explains.

## 5. Canonical Owner Journeys

These IDs are the single source of truth for this change. Worker reports may use older local numbering; future packets SHALL use these IDs.

| ID | Journey | Owner question | Primary surface |
|---|---|---|---|
| OJ1 | Source inventory | What data do I have, from which accounts/devices/files, and how current is it? | Sources |
| OJ2 | Source setup and configuration | How do I add another source, name it, configure it, reauthorize it, revoke it, or change its schedule? | Add Data and Source detail |
| OJ3 | Record inspection | Can I read, filter, verify, and share a view of the records? | Explore and stream-scoped record views |
| OJ4 | Source recovery | What is broken, do I need to act, and what exact next action should I take? | Dashboard and Source detail |
| OJ5 | Access and grants | Who can read parts of my data, what can they read, and what have they read? | Grants and Connect AI Apps |
| OJ6 | Activity and audit evidence | What happened underneath this source, grant, read, run, or credential? | Runs, traces, timelines, diagnostics |

`Know data` and `manage sources` are intentionally separate here. Inventory answers what exists and whether it is current. Setup/configuration answers how the owner changes the source set or source policy. Combining them was one cause of the earlier route and CTA confusion.

## 6. Canonical Defect Taxonomy

These root codes replace local worker numbering such as taxonomy `C*` or IA `IC-*` for future implementation packets.

| Code | Root | First affected journeys |
|---|---|---|
| R1 | Source truth/projection drift: counts, freshness, coverage, last run, and samples disagree or are unlabeled. | OJ1, OJ3, OJ4 |
| R2 | Noun and route drift: Sources, Connections, Records, Runs, Syncs, IDs, and URLs require translation. | OJ1, OJ2, OJ6 |
| R3 | Setup action dishonesty: unavailable or advanced paths look like primary owner actions. | OJ2 |
| R4 | Recovery agency/progress failure: source is broken but the owner cannot understand or close the loop. | OJ4 |
| R5 | Record workbench weakness: filters, pagination, ID jump, rendering, and URL state are not SLVP-grade. | OJ3 |
| R6 | Access/grant ambiguity: packages, grants, scopes, reads, and clients are hard to relate. | OJ5 |
| R7 | Evidence-layer overload: runs, traces, timelines, diagnostics, and tokens are over-promoted or unreadable. | OJ6 |
| R8 | Visual/interaction craft failures: selected states, layout, density, mobile, and row geometry undermine trust. | all |
| R9 | Runtime or collector correctness gap: the console truth is blocked by missing runtime evidence or collector output. | OJ1, OJ4 |

## 7. Iteration Log

This plan intentionally went through multiple passes before settling on the final model.

### Iteration 1: Raw Complaint Inventory

Initial inventory captured surface-level complaints across Dashboard, Sources, Add Data, Explore, Runs, Grants, Traces, Owner Tokens, local collectors, and Chase.

Rejected output: a bug backlog by page. That would repeat the previous failure.

### Iteration 2: User Jobs

The complaints were recast as jobs:

- Triage what needs attention.
- Add another account/source.
- Understand whether a source is collecting.
- Recover a local collector or broken connector.
- Inspect records and verify counts.
- Understand what an AI app or client can read.
- Audit what was read.

This exposed that Sources/Add Data/Explore/Recovery are the critical path, while traces/grants/tokens are important but should not derail the first product spine.

### Iteration 3: Root Cause Clustering

The taxonomy lane grouped defects into roots:

- no single source of truth for attention/status
- leaked internal semantics
- incoherent noun model and route model
- redundant surfaces without differentiated jobs
- broken add-source path
- recovery loop not closed
- undefined status vocabulary
- weak Explore search/filter/sort

This moved the plan away from patching individual labels.

### Iteration 4: Essential Noun Model

The IA lane applied Rich Hickey's incidental vs essential complexity lens. The essential owner objects are:

- Source: a configured account, device, artifact import, or provider-backed connection.
- Stream: a slice of data within a source.
- Record: the collected item the owner wants to read.
- Grant: consent/disclosure authority for a client.
- Read/Disclosure: an actual access event.
- Run/Trace: evidence about collection or protocol activity.
- Device, Credential, Schedule: policy or infrastructure attached to a source.

Runs, traces, diagnostics, and device exporters are not primary owner destinations. They are evidence layers.

### Iteration 5: Prior-Art Cross-Check

The prior-art lane mapped the plan to established control-plane patterns:

- Airbyte is connection-centric for data movement.
- Temporal and Trigger.dev are run-centric only once the owner is debugging an execution.
- Datadog/Sentry-style surfaces separate health summaries from forensic event detail.
- Stripe/Plaid-quality reference surfaces separate docs, operations, and advanced/debug flows.

This supports a source-centric console with trace/run evidence reachable from the source, not a flat nav where every artifact is equally primary.

The later 2026-06-18 targeted prior-art corpus deepened that conclusion by interaction archetype:

- record workbench: Datadog, GitHub, PostHog, Notion, DevTools, Algolia, and Airtable all point toward URL-backed filters, explicit selection, time controls, pagination or virtualization, and rich detail
- setup/catalog: Stripe, Plaid, GitHub, Railway, Vercel, Supabase, Tailscale, and Google point toward staged prerequisites, exact scopes, validation, identity echo, and first-sync or check-in progress
- recovery/liveness: Sentry, Temporal, Trigger.dev, and device-management flows point toward one cause, one closing action, progress, and terminal reconciliation
- access review: Google, GitHub, Stripe, Plaid, and Apple point toward client-centered scope review, last-used/read facts, and revocation
- evidence timelines: Datadog, Temporal, Sentry, and GitHub Actions point toward subject-scoped, dense, filterable event grammar rather than generic trace browsing
- craft/mobile: modern product surfaces point toward consistent row affordances, touch targets, selected-state breathing room, master-detail breakpoints, and no horizontal overflow

This corpus also adds a fresh-owner constraint: a motivated Docker/Railway owner who did not build PDPP must be able to go from instance readiness to one source, first records, and one AI-client grant without repo-checkout assumptions or chat memory.

### Iteration 6: Voice And Framing Check

The plan was checked against `docs/voice-and-framing.md`.

Decisions:

- No hosted-service voice such as "we are fixing this" for a self-hosted reference instance.
- No cybersecurity framing for normal owner recovery.
- No unqualified connector claims when a connector cannot actually be set up.
- No Core/Collection/Profile/RI conflation.
- Connector-specific setup UI must be generated from connector capabilities, not hard-coded console knowledge.

### Iteration 7: Technical Truth Gap Pass

The technical-probe lane was scoped to safely identify likely ownership and verification paths for the most alarming facts:

- Amazon count mismatch: verified as projection/IA, not data loss. Sources shows all-time retained count; Explore shows a six-row bounded sample with `window: "none"` and no "showing 6 of 1,183" context.
- GitHub first-run success but missing/zero records: connector is healthy; trust gap is success copy decoupled from record yield plus conditional first-sync start semantics.
- local collector recovery/draining/checking: mostly honest projection with owner-hostile copy; real gap is missing coverage diagnostics after collector recovery.
- grant package count/internal source leakage: package-vs-grant hierarchy is unclear; internal leak is bounded to one `pg_lexical_backfill_*` source path in grant packages.
- run/detail/trace navigation: Jump-to-ID works only on Enter with poor feedback; trace links grant but not grant package; timeline tables are hard to read and overflow.

The key correction: nothing in the technical report proves data loss. The highest-confidence failures are projection, IA, and honesty gaps. That increases the priority of a single source of truth and clear projection labels. A polished UI over contradictory projections is still untrustworthy, but the first move should not be a broad storage rewrite.

Named technical outcomes:

- Amazon and similar count mismatches: treat "showing N of total" as an interim honesty label, not the final product answer. The final interaction must let the owner continue through the full set via pagination or virtualization, because the feedback explicitly rejects artificial caps as the cost of performance.
- GitHub: fix setup/status copy and first-sync trigger semantics so setup success is not confused with records collected.
- Local collector: fix missing coverage diagnostics and make recovery progress/closeout visible.
- Grants: filter internal source artifacts from grant-package paths and explain package vs child grant.
- Run/trace: improve jump feedback, package pivots, credential last-used visibility, and timeline readability.

### Iteration 8: Sequence Pruning

The plan was pruned by critical path:

1. Owner must add data.
2. Owner must know what data exists.
3. Owner must inspect the data.
4. Owner must recover collection.
5. Owner must grant/connect AI apps.

Everything else is a secondary surface until it supports one of those jobs.

### Iteration 9: Delegation Model

Waspflow and Claude lanes are useful for breadth, but they are dangerous if they own acceptance. Workers produce reports, critique, implementation branches, screenshots, and red-team findings. The RI owner integrates, sets acceptance checks, and decides whether the result is SLVP ideal.

### Iteration 10: Live Source-Card Projection Defects

The 2026-07-01 owner review exposed defects that were plain in the live Sources/source-detail card:

- `auth` rows said `owner action required` for manual refresh/retry review actions, conflating authentication repair with every owner-runnable verdict action.
- `config` stream counts used `summary.stream_count` while the visible stream table used the union of manifest, retained, and collection-report streams.
- Owner-runnable verdict actions rendered twice: once as a body `NextActionCta`, then again in the passport footer.
- Paused sources could receive a stale annotation that said they refresh on schedule because rendered-verdict copy read static assisted-refresh policy instead of the already-projected schedule-enabled progress mode.

The correction belongs in the shared projections, not in connector-specific copy. The model now derives auth only from reauth evidence, stream counts from the same stream set the card renders, and one owner action from the server-owned verdict. The rendered-verdict stale annotation uses progress mode so disabled schedules use owner-run/manual language.

Current clawmeter posture makes this especially important: conserve Codex/OpenAI for integration and signoff; use Claude lanes for broad synthesis and independent review.

### Iteration 11: Owner Spine Synthesis

The hard-surface charters for Sources/Syncs/Runs, Explore/stream records, Add Data/setup, Recovery/liveness, Grants/Connect, Evidence timelines, and fresh-owner onboarding were accepted only after an adversarial alignment review.

The accepted synthesis is not seven page redesigns. It is one owner spine:

1. confirm the instance can add real data;
2. add one real Source with meaningful identity;
3. watch first collection reach a terminal state;
4. inspect the complete backing records through the shared workbench;
5. understand and repair one broken/stale Source without diagnostic spelunking;
6. connect one Client and understand what it can read and what it has read;
7. open evidence only as scoped proof for a Source, Record, Grant, Read, or recovery action.

This synthesis is the alignment gate for implementation. A page-local improvement that does not improve the owner spine is deferred unless it is a tiny opportunistic fix inside an accepted tranche. This is the concrete guard against the failure mode the owner identified: many correct local fixes that still do not create a console he would feel confident sharing.

### Iteration 12: Final Gate Model

The final plan replaces "tests passed" as a completion proxy with named gate artifacts:

- product model accepted
- journey ledger row exists
- technical truth gap closed or tracked
- desktop and mobile evidence captured
- real browser path walked
- console/network errors checked
- no false primary action
- no implementation jargon
- independent adversarial review artifact with an explicit verdict
- live deploy smoke with the same journey

This is slower than a grep gate but faster than a week of reactive churn.

### Iteration 13: Surface Architecture And Truth Packets

The 2026-07-01 follow-up packet resolves the remaining foundation decisions that
do not require new owner screenshots or a human-reviewed mock.

Accepted decisions:

- Sources, Add Data, Explore, and Grants/Connect AI Apps remain primary owner
  surfaces.
- Runs/Syncs, traces, schedules, device exporters, deployment, and owner tokens
  remain useful but are evidence or administration surfaces unless the owner
  intentionally enters them.
- Runs/Syncs is retained as a secondary activity view until a human-reviewed mock
  proves that its useful per-run and per-stream facts survive demotion or merge.
- Explore and stream-scoped record views remain separate destinations with a
  shared record model until a human-reviewed mock proves full merger is better.
- `/dashboard` remains the implementation prefix for now; clean owner aliases
  may be added only through subject-preserving route helpers.
- Source is the owner-facing configured data-producing instance. Connector type,
  collector, device, credential, and schedule are properties or supporting
  concepts unless one of them is the owner's active repair/setup subject.

The packet also converts the technical truth matrix into implementation
contracts for counts, drill-through, full visibility, CTA subject scoping, and
setup/recovery liveness.

## 8. Essential Surface Model

### Sources

Sources are the primary collection object. A Source is a specific owner-configured data-producing instance: "Amazon - family account", "Claude Code on Peregrine", "Gmail - work", "WhatsApp import", or "GitHub PAT - the owner".

Sources own:

- source identity and owner label
- connector type
- account/device/artifact identity
- credentials or local binding
- streams
- record counts
- freshness
- coverage
- schedule
- last meaningful run
- next owner action

The owner-facing noun is `Source`. The UI may internally use `connection_id`, but normal owner-facing navigation, headings, and CTAs SHALL use `Source`. `Connection` remains acceptable in API docs, protocol/debug views, logs, and advanced copy where the technical identifier matters.

### Streams

Streams are children of sources. A stream view answers "what records are in this slice?" It should not feel like a different product from Explore.

### Records And Explore

Explore is the cross-source record workbench. It must share record rendering with stream views. It must support URL-addressable state, pagination/virtualization instead of artificial caps, source/stream/date/query filters, ID jump, and copyable links.

A bounded sample may appear only as a preview or loading optimization. It must never be the terminal answer to "show me this stream" or "show me this source's records." Every sample needs an explicit full-set affordance that reaches the remaining records without requiring the owner to know an ID or write a query.

### Grants And Reads

Grants are the access/consent object. The owner should be able to answer:

- Which clients can read?
- What sources/streams/fields can they read?
- What have they actually read?
- What grants are active, revoked, expired, or single-use consumed?

Grant packages need an explicit parent/child model. A package with many source-bound grants cannot be rendered as "one grant" without context.

### Runs, Traces, Timelines

Runs and traces are evidence layers. They remain important and first-class as evidence, but they should usually be reached from a source, grant, read, or run-specific error. A generic top-level run list should not be the normal path for understanding a source.

Open design decision: do not remove or merge the current Runs/Syncs destination until a prior-art memo and owner-reviewed mock prove that the records-collected-per-stream-this-run view the owner valued is preserved in Sources or another clearer surface. The current leaning is source-centric evidence, not deletion by fiat.

### Devices, Credentials, Schedules

These are policies or infrastructure attached to sources. They should be visible where they explain a source's state, not as unrelated objects the owner must correlate manually.

## 9. Critical Journey Ledger

Each future implementation packet must map to at least one row here.

| Journey | Owner question | Required answer | Primary surface | Evidence layer |
|---|---|---|---|---|
| OJ1 Source inventory | What data do I have? | Sources list and source detail show specific accounts/devices/files, streams, counts, freshness, and coverage consistently. | Sources | stream detail, read model |
| OJ2 Source setup/configuration | How do I add or change sources? | Add Data shows only real setup/import paths as primary actions, supports multiple accounts for proven connectors, and source detail exposes naming, reauth, revoke, schedule, and config. | Add Data, Source detail | setup status, connector manifest |
| OJ3 Record inspection | Can I read and verify records? | Explore and stream views show the same records with URL-shareable filters, honest sample/window labels, and no fake caps. | Explore | record detail, source filter |
| OJ4 Source recovery | What is broken and what should I do? | Dashboard/source detail show one cause-specific action, progress, or an honest non-owner-action status. | Sources/Dashboard | run/trace/diagnostics |
| OJ5 Access/grants | Who can read parts of me? | Client/grant surfaces show scope, package structure, active grants, revocations, and reads. | Grants/Connect AI Apps | disclosure trace |
| OJ6 Activity/audit evidence | What happened under the hood? | Runs, traces, timelines, tokens, and diagnostics support the subject being inspected rather than replacing it. | Subject detail pages | run, trace, timeline, credential detail |

## 10. Severity And Priority

P0: trust and task blockers on the critical path.

- add-source inability for proven connectors and multiple accounts
- GitHub-style setup success that is decoupled from a settled first sync or record yield
- missing local-collector coverage diagnostics after recovery
- grant-package internal-source leakage
- dead-end setup CTAs or provider links that do not actually configure the source
- recovery actions that do not explain what is wrong or close the loop
- internal sources/debug streams/deprecated alias warnings visible in owner paths
- browser-session setup crashes
- count/sample labels that make correct data look contradictory, such as Explore showing 6 rows without "of 1,183"
- artificial caps or bounded samples with no full-set pagination/virtualization path
- CTAs that drop subject context, perform a different verb than their label, or land on a generic surface when a source/grant/run/credential-specific target exists

P1: comprehension blockers.

- Sources vs Syncs/Runs vs Records route/noun drift
- grant package count/scope ambiguity
- traces/timelines that do not show the artifact the owner is looking for
- Explore filter/search controls that are not self-explanatory or shareable
- unknown/checking states that persist without explanation

P2: craft and interaction quality.

- selected-row highlight touching content
- layout squish, row shape changes, table overflow
- repeated source names, duplicate nav entries, missing rename reflection
- mobile density and hit-target polish

P3: expansion and delight.

- record type-specific rendering beyond guaranteed manifest data
- richer timelines/waterfalls
- proactive source reminders
- external-user onboarding narrative

## 11. Implementation Waves

Ordering constraint:

- Wave 0 must complete before any implementation wave.
- Wave 1 and the Wave 2 truth model for an affected surface must be accepted before workers start Wave 3 or later work on that same surface.
- Wave 4 through Wave 8 must not begin as broad surface work until Waves 1-3 are accepted for the critical path.
- Exceptions are allowed only for isolated P0 fixes that have their own journey ledger row and do not change the product model.

### Wave 0: Evidence And Alignment

Deliverables:

- feedback synthesis and opportunity map
- journey-keyed screenshot/PDF atlas
- technical truth-gap matrix
- current-route inventory and noun drift map
- prior-art memo and owner-reviewed mock before deciding whether to merge Runs/Syncs into Sources or unify Explore/stream pages beyond shared record rendering
- adversarial review of this plan

No UI code should be merged from this wave except diagnostic harnesses or documentation.

### Wave 1: Noun And Route Spine

Goal: one owner-facing noun model.

Work:

- choose and document the owner noun for configured data sources
- normalize nav labels, page headings, CTA labels, and route aliases
- decide whether `/dashboard` remains a hidden implementation prefix or is replaced by cleaner owner routes with compatibility redirects
- add redirects/compatibility for old routes where needed
- make "Source detail" an explicit destination, not hidden behind Reauthorize
- make Add Data a primary action from Sources and the dashboard

Gate:

- owner can point to one object and say whether it is a source, stream, record, grant, run, or trace

### Wave 2: Source Truth And Counts

Goal: one source of truth for source status and record counts.

Work:

- reconcile source summary, stream counts, Explore scoped counts, last-run delta, and current held records
- ensure "collected last run", "collected during the last run that found new data", and "total held" are separate facts
- make every rollup count drill through to the counted subjects, or state why it cannot
- ensure attention-count changes across reloads are explained by resolved/snoozed/no-longer-actionable state rather than silently changing
- remove internal/deprecated source rows from owner surfaces or explain them as advanced/internal
- make unknown/checking/fresh/stale/coverage states follow the rendered-verdict contract
- show bounded samples as bounded samples, not as stream counts, and pair every sample with a full-set path
- hide or tombstone retired/renamed streams so live stream rows do not click into "no longer advertises this stream" errors
- gate "import complete" or "setup complete" copy on a settled first-run/record-yield state, or state explicitly that setup is complete while first collection is still running
- fix missing coverage diagnostics after local collector recovery
- add live-status-without-manual-refresh acceptance for setup, recovery, and first-sync status pages

Gate:

- a source's stream count matches the scoped record workbench or explains the filter/sample/delta difference

### Wave 3: Add Data

Goal: every primary setup action is real, specific, and generated from connector capability.

Work:

- show proven connectors as addable even if another account/source already exists
- support owner naming and identity echo during setup
- hide or separate unavailable sources from the primary add-now list
- replace "server settings needed" jargon with exact operator requirement and action
- provider-secret flows include exact scopes, links, expiration guidance, and validation before final submit
- setup status auto-refreshes until the first run settles

Gate:

- owner can add a second source for an already-used connector and see it named, syncing, and searchable without manual route guessing

### Wave 4: Inspect Data

Goal: Explore becomes a trustworthy record workbench.

Work:

- unify record renderer between stream views and Explore
- implement URL-backed filter state and copy-link
- replace caps with pagination/virtualization; "showing N of M" alone is not sufficient for stream/source record inspection unless there is an obvious next-page or view-all path
- implement ID jump with visible feedback, source/stream autocomplete, date range presets/custom range, and clear sort semantics
- support richer sort affordances, including multiple keys where the backend can guarantee stable semantics
- restore a performant time-distribution visualization as a filter aid
- ensure multi-select interactions do not drop clicks
- ensure every "View records" or "Explore" link scopes the record workbench to its source, stream, grant, or read subject through URL state

Gate:

- owner can move from source stream to Explore, verify the same records, refine the query, and share the URL

Open design decision: shared record rendering is required, but a broader Explore-vs-stream-table merger needs prior-art review and an owner-reviewed mock. The current stream table may be preserving useful scoped context that Explore does not yet replace.

### Wave 5: Recovery

Goal: broken sources have one honest next action and a closed loop.

Work:

- local collector recovery explains what is wrong in human terms
- commands show progress and final state, not a blinking cursor
- the dashboard and CLI agree on the one command or UI action that closes the recovery loop; the dashboard must not hand the owner a low-level command whose own output says it does not complete recovery
- dashboard and source detail auto-refresh/reconcile after recovery
- terminal connector-code issues offer a real bug-report or maintainer-action path without hosted-service voice
- Chase-style multi-condition failures aggregate into one owner-readable explanation with detail one click down

Gate:

- owner can recover or correctly defer one broken source without visiting generic Runs, Traces, or a wall of diagnostics

### Wave 6: Grants, Reads, And Connect AI Apps

Goal: access surfaces explain authority and actual reads.

Work:

- client view shows active grants, package children, source-bound scopes, and revocations
- grant-package paths filter internal connector/source artifacts consistently with other owner lists
- trace/read filters support client, grant, source, and status
- trace detail links to the grant package when the event belongs to a package, not only to the child grant
- "View Records" from a grant either scopes to grant-readable records or explicitly states the current limitation
- owner tokens show provenance, last-used, scope, rename validation, and advanced/debug boundaries

Gate:

- owner can answer "what can ChatGPT read?" and "what did ChatGPT read?" without decoding trace internals

### Wave 7: Activity Evidence Layer

Goal: one reusable timeline/event component.

Work:

- design one dense event/timeline component for run, grant, trace, and disclosure evidence
- fix table overflow and layout shifts
- link each event to adjacent artifacts
- demote generic trace browsing from primary owner path while preserving advanced forensic access

Gate:

- every timeline/detail surface uses the same component grammar and can be read without expanding dozens of identical boxes

### Wave 8: Craft, Mobile, And Delight

Goal: the console feels intentionally designed.

Work:

- visual hierarchy and layout pass on desktop and mobile
- selected row, focus ring, density, and card geometry polish
- source setup first-run narrative
- empty/loading/transition states
- short moments that reinforce "your data, under your control" without adding noise

Gate:

- pixel review passes for the canonical atlas and no P0/P1 product defects are open

## 12. Delegation Plan

Use waspflow for breadth and isolation, but do not outsource product judgment.

Standing worker roles:

- taxonomy lane: classify feedback and root causes
- IA lane: challenge noun model and route structure
- prior-art lane: map existing and new research to product decisions
- technical-probe lane: safely verify data/projection/root-cause gaps
- visual atlas lane: capture desktop/mobile screenshots and DOM facts
- adversarial-review lane: attack proposed plan and implementation for false progress
- implementation lanes: narrow packets only after acceptance rows exist

Owner responsibilities:

- define the acceptance packet
- choose scope and priority
- review diffs, pixels, and data truth
- run or obtain live journey proof
- decide merge/deploy readiness

Worker constraints:

- no deploys unless explicitly delegated under the live-stack mutex
- no source/provider runs unless explicitly authorized
- no product code changes for plan/research lanes
- no remote pushes for every local branch
- all web research lands in `docs/research/`
- all broad behavior changes get OpenSpec coverage

## 13. Acceptance Gates

Every wave must pass:

- OpenSpec validation if it changes durable behavior
- journey ledger row with explicit acceptance checks
- contract-matrix row mapping for every owner-visible claim changed by the tranche
- desktop screenshot evidence
- mobile screenshot evidence
- browser console and failed-network evidence
- data truth checks for affected counts/statuses/actions
- vocabulary-boundary review showing owner, operator/debug, protocol, and connector-authored terms are in the right places
- no primary CTA that cannot complete the promised action
- no mocked-fetch-only proof for browser/provider paths
- independent adversarial review for substantive tranches, written by a lane that did not implement the change and ending with `accept`, `accept_with_required_edits`, or `reject`
- live-stack mutex and smoke evidence for deployment

Gate artifacts:

- Journey evidence: `tmp/workstreams/<tranche>-journey-evidence-<date>.md` with desktop and mobile screenshots, route sequence, console errors, failed requests, and verdict.
- Data-truth proof: `tmp/workstreams/<tranche>-data-truth-<date>.md` with probe-style live read-only API or database evidence when counts, statuses, grants, or source state are affected.
- Adversarial review: `tmp/workstreams/<tranche>-redteam-<date>.md` from a non-implementing lane.
- Vocabulary review: `tmp/workstreams/<tranche>-vocabulary-boundary-<date>.md` showing no owner path depends on raw implementation/debug terms for comprehension.
- Contract matrix: `tmp/workstreams/<tranche>-contract-matrix-<date>.md` listing the affected owner claim, source-of-truth field/API, accepted basis label, drill-through target, and full-set path for any bounded list.

## 14. What This Plan Will Not Prove

This plan can raise internal confidence that PDPP's console is coherent, honest, and ready for external testing. It cannot by itself prove that colleagues, Reddit users, family, or friends will feel delight. That requires external users after the critical trust and task blockers are gone.

The target confidence model:

- 70%: plan accepted and atlas complete
- 80%: P0 waves pass real-browser and data-truth gates
- 90%: independent adversarial review finds no journey blockers
- 95%: the owner completes a fresh walkthrough without discovering a new trust or task blocker
- 95%+ external delight: requires external users

## 15. Current Confidence

High confidence:

- The failure is systemic IA/state-model drift rather than a finite list of UI bugs.
- `Source` should be the owner-facing noun for configured data-producing instances.
- The five most alarming technical observations are mostly projection/IA/honesty gaps, not data loss.
- Implementation workers need journey evidence and independent red-team review before deploy readiness.
- The owner rejects performance-motivated artificial caps as a final UX. Pagination, virtualization, or a real full-set path is required anywhere the owner is trying to inspect records.

Medium-high confidence:

- The console should be source-centric with grants/access as the second dominant product object.
- Runs/traces/device exporters should usually act as evidence layers rather than the normal owner front door.
- Waves 0-3 are the right first sequence for the critical path.
- The current plan captures the main failure classes, but the contract matrix remains the safer authority for implementation details because it preserves every observed interaction expectation.

Lower confidence until Wave 0 evidence:

- Whether the current Runs/Syncs destination should be removed, merged, or retained as a secondary activity view.
- Whether Explore and stream-scoped record tables should fully merge or share components while remaining separate destinations.
- Whether a single 72-hour cycle can close enough P0/P1 issues to make the owner confident with external reviewers.

The practical call: stop treating new feedback as a patch queue. Complete the product model, atlas, and truth-gap matrix, then implement by journey waves with strong gates.

## 16. Prior-Art Synthesis For Implementation

The 2026-06-18 prior-art corpus raises the plan's confidence, but it also tightens the bar. The implementation standard is not "route looks cleaner" or "tests passed." The standard is that each surface behaves like its interaction archetype.

Decisions now backed by the corpus:

- `Source` is the owner-facing primary collection noun.
- Add Data primary actions are limited to paths the current instance can honestly complete.
- Unavailable connectors may be visible only as separated, owner-readable secondary entries.
- Full record visibility is required for source, stream, grant-readable, and Explore inspection. Samples are allowed only as previews with a full-set path.
- Counts distinguish total held, current filter, current page or preview, latest-run yield, and latest meaningful run yield.
- Setup is not complete until the owner sees credential acceptance plus first-collection progress or a clear waiting/failure state.
- Recovery is not complete until the owner sees one human cause, one closing action, progress, and terminal reconciliation.
- Access review is client-centric and answers both authority and actual reads.
- Evidence timelines are subject-scoped and use a reusable event grammar.
- Fresh owners must not need repo knowledge, internal IDs, or owner bearer-token copying for normal setup.

Confidence after this pass:

- broad diagnosis: 92%
- critical path understanding: 88%
- interaction-contract understanding: 82%
- adjacent-class inference: 78%

That is enough to proceed with Wave 0 acceptance packets and narrow P0 fixes. It is not enough to green-light broad UI implementation without the atlas, pixel evidence, and adversarial reviews described in the gates.

## 17. Friction-To-Solution Governor

the owner's feedback friction is the direction signal. Repeated confusion means the product contract is missing or incoherent; it does not mean the next worker should patch the closest string or component.

Hard surfaces require a charter before broad implementation:

- Sources / Syncs / Runs relationship
- Add Data and connector setup
- Explore / stream record workbench
- Recovery and local collector liveness
- Grants / reads / Connect AI Apps
- Evidence timelines / traces
- Fresh-owner onboarding

Each charter must name the owner promise, friction evidence, prior-art anchor, product contract, useful facts to preserve, incidental complexity to demote, rabbit holes to avoid, and acceptance evidence. This is how the change avoids optimizing real but small detail problems while leaving the SLVP-tier interaction problem unsolved.

The rabbit-hole filter is:

- direct product-promise impact
- trust blocker removed
- reusable cross-journey contract established
- or tiny opportunistic fix inside an already accepted tranche

Everything else waits. This rule is deliberately strict because previous churn came from solving true local defects before the product model was settled.

## Appendix A: SLVP Interaction Standards

This appendix is the missing layer between product values and implementation packets.
It exists because a surface can use the right nouns, preserve the right source of
truth, and still feel sub-SLVP if the controls are clumsy. the owner's Explore feedback is
the clearest example: a coherent record workbench still fails if selection is
unclear, rapid multi-select drops intent, date presets fight each other, ID jump is
not obviously actionable, or filters require memorized syntax.

Each implementation packet SHALL identify the interaction archetype it is changing
and inherit the standard below. If no archetype fits, the packet must define one
before code starts.

### A0. Product gestalt and personal-data dignity

Use this for every owner-facing journey. It is the layer that prevents a set of
locally-correct controls from still feeling like an inspired hallucination of a
product.

Required interaction contract:

- The owner can state the surface's job in one sentence from the heading, primary
  content, and primary action.
- The surface leads with owner-relevant meaning before implementation evidence.
- Debug detail, protocol terms, raw identifiers, and diagnostic payloads are
  secondary unless the owner intentionally enters an advanced/debug path.
- The product explains enough in-flow that a motivated Docker/Railway operator does
  not need chat context or repo knowledge to continue.
- Personal data is treated with calm agency: no alarmist copy, no false reassurance,
  no buried risk, and no wall of text as the default answer.
- A shareability review asks whether a colleague, family member, Reddit reader, or
  standards reviewer would understand why the surface exists and why PDPP is worth
  trusting.

Must feel like: a coherent personal-data control plane. Must not feel like: a set of
generated admin panels over a strong backend.

### A1. Record workbench

Use this for Explore, source stream record views, grant-readable record sets, and any
surface whose job is "show me records."

Prior-art anchors: Datadog Log Explorer, PostHog filters, Algolia-style faceted
search, GitHub search, and browser-devtools-style inspection. The expected shape is
query + typed filters + facets + time distribution + result list + in-place detail,
all URL-backed.

Required interaction contract:

- Selection is obvious, reversible, keyboard-reachable, and visually separate from
  row content.
- Rapid multi-select interactions are accumulated instead of dropped while data is
  loading.
- Search and filters are discoverable through autocomplete, field suggestions,
  operator menus, and value suggestions where the schema can support them.
- Date presets and custom ranges are one control with one selected state, not
  competing chips and duplicate summary boxes.
- Sort controls expose the stable sort keys the backend can actually guarantee.
- Jump-to-ID is a real control with visible success, not-found, and invalid-ID
  states; otherwise it is removed.
- The time-distribution chart is an interactive filter when the data volume makes it
  useful; it is not removed as a performance workaround without an equivalent
  replacement.
- Record detail uses the richest guaranteed renderer available, with raw JSON as
  supporting detail, not as a competing primary face.
- Bounded previews must have an immediate full-set path. "Showing N of M" is a label,
  not a substitute for pagination, virtualization, or another route to the complete
  backing set.

Must feel like: a modern data workbench. Must not feel like: a debug table with a few
filters attached.

### A2. Source setup and connector catalog

Use this for Add Data, connector setup, provider-secret capture, browser setup,
artifact import, and local collector enrollment.

Prior-art anchors: Stripe/Plaid onboarding, GitHub token setup, Railway deployment
templates, and connector self-service setup research already captured in this repo.

Required interaction contract:

- The primary catalog shows only actions this instance can honestly perform now.
- Proven connectors remain addable for additional accounts, devices, or artifacts
  when connector semantics allow them.
- Unavailable, operator-gated, proof-gated, or future paths are separated from
  primary add-now actions and phrased in owner language.
- The owner sees prerequisites, exact scopes, links, identity echo, and naming before
  committing.
- The system validates credentials or setup inputs as early as practical.
- Submitting setup starts a live status surface that progresses through accepted,
  collecting, yielded records, completed with zero yield, failed, or waiting states
  without manual refresh.

Must feel like: the shortest honest path to add one more source. Must not feel like:
deployment documentation disguised as a button.

2026-06-19 Amazon browser setup correction:

- The live `cin_af565613063f3fc2ffa7d2f4` failure proved that a connection-scoped
  browser setup can look like it succeeded while silently using deployment-wide
  `AMAZON_USERNAME` / `AMAZON_PASSWORD`.
- That violates the setup archetype: adding another source must authenticate the
  account for that source, not reuse an operator/deployment credential intended for
  a different source.
- The fix belongs at the connector/runtime boundary before UI polish: connection-
  scoped browser profiles must require visible browser login unless that exact
  profile is already authenticated.

2026-06-19 source credential mode correction:

- The rule is not "browser connectors never use credentials." The rule is that
  provider-account credentials are always source-scoped. A stored username,
  password, recovery code, app password, token, cookie, or OTP helper can be part
  of setup only when it belongs to the source being created or reauthorized.
- Deployment-wide provider-account credentials such as `AMAZON_USERNAME` /
  `AMAZON_PASSWORD` must not satisfy a source setup or scheduled run. Deployment
  env may configure the instance, encryption, collector transport, or source
  app/client settings; it must not impersonate one provider account for all
  sources.
- Browser-backed setup has three owner choices:
  1. Source-scoped stored credentials can assist the browser login where the
     connector explicitly supports that mode. When the owner opts in, those
     credentials may be reused for that same source after the browser session
     expires; the owner should only be bothered when stored credentials are
     absent, rejected, insufficient, or require fresh human action. Stored-
     credential setup should start first collection on the durable setup-status
     surface and escalate to the secure browser only when the existing run
     interaction machinery reports login, OTP, challenge, or identity
     confirmation is needed.
  2. Source-scoped streamed browser login remains the default proof path and must
     still happen when the source has not already proven an authenticated profile.
  3. An optional ephemeral browser mode clears session and credential material
     after collection; at least one connector must prove this mode before the UI
     advertises it generally.
- Existing OTP and login helpers are not obsolete. They should be preserved and
  moved behind source-scoped credential resolution, not deleted as a proxy for
  removing deployment-wide credentials.
- Setup success requires source identity evidence: the UI/runtime must know which
  source account or browser profile is authenticated before records are accepted
  for a new source.

2026-07-01 stored-credential repair correction:

- Browser-backed connectors with source-scoped username/password runtime support
  must also declare manifest-owned credential capture. Otherwise a source with a
  rejected stored credential can be routed to browser-session repair that cannot
  update the credential blocking scheduled runs.
- The static-secret owner form must treat `username_password` and
  `secret_bundle` as sealed multi-field credential bundles. Capturing only the
  first secret field is valid for single-secret connectors, but drops required
  login fields for browser-backed username/password sources.
- Source detail must expose the stored-credential update path proactively when a
  connector declares it, not only after failure. Browser-session reconnect is the
  fallback for browser-bound connectors with no manifest-owned credential surface.

### A3. Source inventory and status

Use this for Sources, dashboard source summaries, stream lists, and source detail.

Prior-art anchors: Sentry issue lists, Linear issue state, Airbyte connection lists,
and Datadog monitor status pages.

Required interaction contract:

- Health, freshness, coverage, schedule, and owner action are distinct facts.
- Status color always has a text label and maps to the same predicate used in
  dashboard/runs summaries.
- Counts identify their basis: total held, current page or preview, current filter,
  latest run yield, latest meaningful run yield, and backing total.
- Rollup counts drill through to exactly the counted subjects.
- Source detail is a first-class destination. It is never reachable only through a
  side-effecting verb such as Reauthorize.
- Stream rows that cannot open because a stream was renamed or retired are hidden or
  tombstoned with an explicit reason.

Must feel like: an inventory the owner can trust. Must not feel like: several
projections trying to explain one another.

### A4. Recovery and long-running operations

Use this for broken sources, local collector recovery, browser sessions, imports,
first sync, reauthorization, upload drains, and backfills.

Prior-art anchors: Sentry resolution flows, Linear issue remediation, Temporal run
status, and Stripe setup status.

Required interaction contract:

- The surface leads with one human cause and one next action, or explicitly says no
  owner action is available.
- Commands and buttons must be the closing action for the stated problem, or the
  limitation is stated before the owner acts.
- Progress is visible during long operations through stage, count, rate, heartbeat, or
  other available evidence.
- The initiating surface reconciles to a terminal state without requiring a manual
  refresh.
- Diagnostic detail is one click down and scoped to the source/run/device being
  repaired.

Must feel like: the system knows what happened and is helping me close the loop. Must
not feel like: a wall of forensics or a blinking terminal cursor.

### A5. Access, grants, reads, and clients

Use this for Grants, Connect AI Apps, client detail, read history, owner tokens, and
credential activity.

Prior-art anchors: Google account app access, GitHub Authorized OAuth Apps, Plaid
consent, and the repo's access-transparency prior-art note.

Required interaction contract:

- The list groups by client/app when answering "who can read?"
- Client detail shows what that client can read in the same concrete terms the owner
  consented to: sources, streams, fields, time/change bounds, status, and revocation.
- Read/activity history is filterable by client, grant/package, source, stream, and
  time.
- Last-used and last-read facts are first-class where available.
- Internal maintenance sources, package mechanics, and raw grant child structure do
  not replace the owner-facing scope summary.

Must feel like: an access review. Must not feel like: a trace browser that happens to
contain grant events.

### A6. Evidence timelines and forensic detail

Use this for Runs, Traces, timelines, event subscriptions, diagnostics, and advanced
operator drill-down.

Prior-art anchors: Datadog traces/logs, Temporal history, Sentry event detail, and
GitHub Actions logs.

Required interaction contract:

- Evidence is reached from the subject it explains unless the owner intentionally
  opens an advanced/debug browser.
- Timeline density is high enough to scan, with expansion for detail instead of
  dozens of visually identical boxes.
- Events are filterable and linked to adjacent artifacts: source, stream, run, trace,
  grant, read, credential, device.
- Tables do not overflow or shift layout when expanded.
- Raw event payloads are available, but the primary view states what happened in
  owner/operator language.

Must feel like: a precise audit trail. Must not feel like: raw JSON wrapped in cards.

### A7. Craft, affordance, and motion

Use this for every owner-facing surface.

Required interaction contract:

- Clickable rows, buttons, links, and disabled states are visually distinct and
  consistent among siblings.
- Focus rings and selected states have breathing room and never touch content.
- Desktop layouts avoid crushed sidebars and empty gutters; mobile layouts preserve
  hierarchy without horizontal overflow.
- Loading and transition states preserve owner intent. If the owner clicks several
  filters quickly, the final state reflects all accepted input.
- Motion is purposeful: progress, relationship, or state change. It is not decorative
  camouflage for missing information.

Must feel like: a product with taste and care. Must not feel like: a generated
dashboard that happens to pass tests.
