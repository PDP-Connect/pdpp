# Owner Implementation Packets - 2026-06-18

Source inputs:
- `/home/user/code/pdpp/docs/inbox/the owner-feedback-6-18-26.md`
- `/home/user/code/pdpp/openspec/changes/redesign-owner-console-product-experience/design.md`
- `/home/user/code/pdpp/openspec/changes/redesign-owner-console-product-experience/tasks.md`
- `/home/user/code/pdpp/openspec/changes/redesign-owner-console-product-experience/specs/reference-surface-topology/spec.md`
- `/home/user/code/pdpp/docs/research/owner-console-slvp-prior-art-index-2026-06-18.md`
- `/home/user/code/pdpp/tmp/workstreams/feedback-contract-matrix-20260618.md`
- `/home/user/code/pdpp/tmp/workstreams/owner-route-noun-inventory-20260618.md`

This map turns the OpenSpec Wave 1-8 plan into implementation packets. It is not product code and does not replace the OpenSpec change. It is meant to let Codex or delegated lanes start work without rediscovering the product model.

## Standing Rules

- The five product-promise outcomes are: Know Data, Add Data, Inspect Data, Recover Problems, Grant/Connect AI Apps.
- Use canonical owner journeys before local page names: OJ1 source inventory, OJ2 source setup/configuration, OJ3 record inspection, OJ4 source recovery, OJ5 access grants, OJ6 activity audit.
- Use root codes from the OpenSpec taxonomy: R1 source truth/projection drift, R2 noun/route drift, R3 setup action dishonesty, R4 recovery agency/progress failure, R5 record workbench weakness, R6 access/grant ambiguity, R7 evidence-layer overload, R8 craft failure, R9 runtime/collector truth gap.
- Every implementation tranche needs data-truth proof when it claims counts, status, coverage, freshness, grant membership, read/disclosure state, or source state.
- Every owner-visible surface tranche needs pixel proof on desktop and mobile. For record workbench, setup, recovery, access review, and evidence timelines, include keyboard/focus proof too.
- Do not satisfy a packet by relabeling bounded samples, hiding individual leaked strings, or self-certifying journey evidence.
- Do not edit protocol contracts, connector manifests, collection profiles, OAuth/RAR semantics, or collector behavior unless the packet explicitly calls for a data-truth dependency and the OpenSpec change is updated first.

## Prioritized Packet Map

### Wave 1 - Owner Noun And Route Spine

Packet name: `wave-1-owner-noun-route-spine`

Journeys/root codes: OJ1, OJ2, OJ3, OJ5, OJ6; R2, R6, R7, R8.

Acceptance checks:
- Navigation, page headings, CTA labels, breadcrumbs, empty states, and detail-page titles consistently use the owner nouns Source, Stream, Record, Grant, Client, Read, Run, Trace, Credential only where they match the owner task.
- `/dashboard` is either confirmed as an implementation prefix with clean owner-facing route labels, or clean owner routes and compatibility redirects are documented before implementation.
- Source detail is reachable by an owner-readable route/action and is not hidden behind `Reauthorize`.
- Every `View records`, `Browse stream`, `Explore`, `Review`, `Reauthorize`, trace link, and token action declares its subject and destination state.
- Vocabulary-boundary scan finds no owner-facing leakage of protocol/debug names such as deprecated aliases, raw projection terms, internal connector codes, `pg_lexical_backfill`, "Subject/Owner Local", or personal project names.

Needed data-truth proof:
- Route inventory before/after with each owner route mapped to OJ1-OJ6 and R-code risk.
- Link-state proof for at least one source, stream, grant, read, run, trace, and credential destination.

Pixel proof:
- Desktop and mobile screenshots of nav, overview, source detail, Explore entry, Grants/Connect AI Apps entry, and an evidence-layer entry.
- Focus/selected-state screenshots for primary nav, row actions, and source-detail action cluster.

Likely files/surfaces:
- `apps/console/src/app/dashboard/**`
- dashboard overview, sources/syncs, source detail, Explore, grants/packages, traces, runs/syncs, owner tokens/credentials.

Safe delegation split:
- Lane A: route/nav/headline inventory and URL compatibility plan.
- Lane B: CTA destination/subject-state audit.
- Lane C: vocabulary-boundary scanner/report.

What not to change:
- Do not rename backend concepts, database tables, connector IDs, manifest fields, protocol names, or public API wire contracts.
- Do not delete existing routes before compatibility redirects are decided.

### Wave 2 - Source Truth And Counts

Packet name: `wave-2-source-truth-counts`

Journeys/root codes: OJ1, OJ3, OJ4; R1, R2, R5, R9.

Acceptance checks:
- Every owner-visible count states its basis: total held, current filtered result, current page/window, latest-run yield, latest-run-with-new-data yield, source count, stream count, grant package count, read count, credential/token count, or attention count.
- Source summary, stream rows, source detail, dashboard attention, and Explore scoped record counts reconcile or explicitly explain filter/sample/delta differences.
- No bounded owner list is terminal: each has next-page, view-all, copy-link, or virtualization path.
- Setup, first-sync, and recovery status surfaces auto-refresh or subscribe until terminal state; no manual refresh is required for owner comprehension.
- Retired/tombstoned streams are hidden from primary lists or state why they are unavailable and what the owner can do next.

Needed data-truth proof:
- Read-only query or fixture-backed matrix for Amazon-style source/stream count mismatch, GitHub first-run yield, latest run delta, total held, and scoped Explore result.
- Proof that a stream count matches the scoped record workbench or a visible label explains why it differs.
- `coverage_missing` or equivalent collector-side missing-coverage evidence is surfaced as a diagnostic dependency, not disguised as UI truth.

Pixel proof:
- Desktop/mobile screenshots of source inventory, source detail, dashboard attention count, stream table, and scoped Explore count labels.
- Screenshot of auto-refreshing status in a non-terminal state and terminal state.

Likely files/surfaces:
- sources/syncs list, source detail, stream rows, dashboard overview, Explore scoped count UI, run summary projections.

Safe delegation split:
- Lane A: count-basis contract and UI labels.
- Lane B: source/stream/Explore reconciliation proof.
- Lane C: auto-refresh/live status acceptance harness.

What not to change:
- Do not fake reconciliation with copied static labels.
- Do not cap counts or samples as final UX without full-set navigation.
- Do not change collector semantics just to make UI numbers agree unless the runtime proof identifies a real collector bug and the contract is updated.

### Wave 3 - Add Data Setup

Packet name: `wave-3-add-data-setup`

Journeys/root codes: OJ2, OJ1, OJ3; R2, R3, R9, R8.

Acceptance checks:
- Add Data primary actions are generated from connector capability and show only proven addable connectors in the primary path.
- Multiple accounts/sources for the same connector are addable; setup captures or echoes an owner label/account identity before the first sync starts.
- Provider-secret setup states exact scopes, permissions, expiration guidance, prerequisite links, and validation before final submit.
- "Setup complete" or "import complete" copy is gated on credential accepted, first visible yield, completed zero yield, or explicit still-collecting state.
- Rename propagates immediately to detail heading, nav, source lists, Syncs/Runs, and Explore-scoped context for a newly added source.
- "View records" after setup scopes Explore to the new source/stream through URL state.

Needed data-truth proof:
- Live or fixture-backed GitHub-style second-source setup evidence: token accepted, first sync started, status auto-refreshes, yielded records or clear zero-yield state, renamed source visible across surfaces.
- Connector capability proof that unavailable/future paths are not shown as primary actions.

Pixel proof:
- Desktop/mobile setup catalog, provider-secret form, validation error, first-sync progress, terminal first-sync state, rename confirmation, and post-setup Explore scope.
- Keyboard proof for setup form fields, submit, validation, and progress region.

Likely files/surfaces:
- Add Data/catalog, connector setup forms, provider-secret flows, source creation action, source detail rename, nav/source list projections, post-setup review route.

Safe delegation split:
- Lane A: connector capability/catalog truth.
- Lane B: provider-secret form contract.
- Lane C: first-sync status and rename propagation journey.

What not to change:
- Do not present provider docs as setup unless they land on the exact prerequisite/action.
- Do not use "server needed" or hosted-service framing; state the operator prerequisite and owner action.
- Do not make unavailable connectors primary actions.

### Wave 4 - Inspect Data Record Workbench

Packet name: `wave-4-inspect-data-record-workbench`

Journeys/root codes: OJ3, OJ1, OJ5; R1, R5, R6, R8.

Acceptance checks:
- Explore and stream/source record views share one record renderer and one scoped record model.
- URL-backed state covers source, stream, grant/read subject where applicable, query, date range, sort, page/window, selected record, and copied link.
- Owner can filter by source/stream autocomplete, date presets/custom range, search/query, sort, ID jump with visible feedback, and time distribution.
- Row selection, multi-select intent preservation, record detail rendering, full-set navigation, and empty/error states are SLVP-grade, not debug-table-grade.
- Every `View records` link from source, stream, setup, grant, package, read, or trace opens the workbench scoped to that subject.

Needed data-truth proof:
- Fixture-backed and, where safe, live scoped queries for source, stream, grant/read subject, date range, search, pagination/virtualization, and ID jump.
- Proof that current filtered count, page/window count, and total held count remain distinct.

Pixel proof:
- Desktop/mobile screenshots for source-scoped Explore, stream-scoped Explore, selected row, rich detail, empty state, long row, time distribution filter, pagination/virtualization, and copied URL reload.
- Keyboard proof for filters, date range, row focus, selected record, and ID jump.

Likely files/surfaces:
- Explore page, stream table/detail entry, record renderer, URL-state helpers, link builders from source/grant/trace/setup surfaces.

Safe delegation split:
- Lane A: URL-state and scoped link builders.
- Lane B: record renderer/detail and count labels.
- Lane C: filter controls, ID jump, time-distribution, pagination/virtualization.

What not to change:
- Do not close this packet with better copy around a capped list.
- Do not invent new record schemas; use the shared record model or introduce the model through OpenSpec if missing.
- Do not expose raw payloads as the primary reading experience; raw payload detail is supporting evidence.

### Wave 5 - Recovery Agency And Progress

Packet name: `wave-5-recovery-agency-progress`

Journeys/root codes: OJ4, OJ1, OJ6; R4, R1, R7, R9.

Acceptance checks:
- A broken source presents one human-readable cause, one closing action, live progress, terminal reconciliation, and a scoped diagnostic path.
- Dashboard and CLI agree on the recovery command/action and completion state; the dashboard does not hand the owner a command whose own output says it does not complete recovery.
- Source detail auto-refreshes or reconciles after recovery and no longer requires generic Runs/Traces spelunking to know whether the source is fixed.
- Multi-condition failures aggregate into one owner-readable explanation with expandable details.
- Connector-code terminal issues point to maintainer/bug-report action without hosted-service voice.

Needed data-truth proof:
- Local recovery run evidence for one broken source: before state, recovery command/action, progress events, terminal state, source detail after reconciliation.
- Proof that UI and CLI read the same recovery state or explicitly explain state boundaries.

Pixel proof:
- Desktop/mobile broken source, recovery action, progress, terminal success, terminal deferred/maintainer action, and post-recovery source detail.
- Terminal output excerpt or JSON evidence attached without printing secrets.

Likely files/surfaces:
- dashboard attention/recovery cards, source detail health/recovery panel, local collector recovery CLI copy, recovery status route/components, run/event timeline links.

Safe delegation split:
- Lane A: UI recovery copy/state model.
- Lane B: CLI/UI command agreement and timeline evidence.
- Lane C: progress rendering and post-recovery reconciliation.

What not to change:
- Do not add more diagnostic links as a substitute for one closing action.
- Do not route owners first to generic Runs, Traces, or raw logs.
- Do not claim recovery is complete without terminal data evidence.

### Wave 6 - Grants, Reads, And Connect AI Apps

Packet name: `wave-6-grants-reads-connect-ai-apps`

Journeys/root codes: OJ5, OJ3, OJ6; R6, R5, R7, R1, R8.

Acceptance checks:
- Connect AI Apps and Grants are client-centric: owner can answer which client can read what data, why, when it last used credentials/read data, and how to revoke.
- Grant/package/source/read relationships are grouped by client and subject, not exposed as raw package mechanics.
- Grant package counts and child rows exclude internal source leakage and distinguish package count, source/stream count, read count, and credential/token count.
- Revocation, last-used, last-read, source-bound scope, client-filtered activity, and trace/read filters are visible.
- Every grant/read/package `View records` link scopes Explore to the client/source/stream/read subject through URL state.

Needed data-truth proof:
- Fixture/live matrix for one client with grant scope, package membership, last-used credential, last read, revocation state, and scoped records.
- No-internal-leak proof across grants, package children, owner tokens/credentials, reads, traces, and source-bound scope labels.

Pixel proof:
- Desktop/mobile access review overview, client detail, grant/package detail, revoke confirmation, last-used/read facts, scoped activity, and scoped Explore link.
- Keyboard/focus proof for revocation and client/source filters.

Likely files/surfaces:
- Grants, grant packages, Connect AI Apps, owner tokens/credentials, reads, traces filters, Explore link builders.

Safe delegation split:
- Lane A: client-centric IA and grouping.
- Lane B: last-used/read and revocation facts.
- Lane C: package/source leakage scanner and scoped record links.

What not to change:
- Do not make raw grant packages the primary owner model.
- Do not hide internal leakage one string at a time; enforce the vocabulary boundary and source filtering.
- Do not broaden grant semantics or protocol authority without OpenSpec contract work.

### Wave 7 - Evidence Timelines, Runs, And Traces

Packet name: `wave-7-evidence-timelines-runs-traces`

Journeys/root codes: OJ6, OJ4, OJ5, OJ1; R7, R4, R6, R1, R8.

Acceptance checks:
- Runs, Syncs, traces, timelines, diagnostics, and tokens are evidence layers reached from Source, Grant, Read, Run, Credential, or recovery context, not primary owner artifacts by default.
- Evidence views are subject-scoped, dense, filterable, and linked to adjacent artifacts with clear back-links.
- Detail views open at the relevant event/row and do not jump owners to page-top ambiguity.
- Event detail uses owner-readable grammar first and raw payload/detail only as supporting evidence.
- Device exporter or other broad event dumps are filtered or clearly scoped before owner exposure.

Needed data-truth proof:
- Timeline JSON/run evidence for one source run, one recovery event, one grant/read activity, and one trace, each linked back to its subject.
- Proof that filters constrain event results and that raw payloads do not drive primary status/count claims.

Pixel proof:
- Desktop/mobile source-scoped timeline, run detail, trace detail, read activity, filter panel, event detail, overflow/long-string state, and subject backlink.
- Keyboard proof for timeline filters and event expansion.

Likely files/surfaces:
- Runs/Syncs, traces, timelines/diagnostics, token/credential activity, source detail evidence tabs, recovery evidence links.

Safe delegation split:
- Lane A: subject-scoped evidence navigation.
- Lane B: event grammar/detail rendering.
- Lane C: filters, backlinks, and overflow/mobile proof.

What not to change:
- Do not over-promote evidence browsers as the main owner product.
- Do not use raw traces to explain access, recovery, or source health when a higher-level owner fact exists.
- Do not introduce new diagnostics surfaces without a subject and owner question.

### Wave 8 - Craft, Mobile, And Product Gestalt

Packet name: `wave-8-craft-mobile-product-gestalt`

Journeys/root codes: all OJ1-OJ6; R8 plus unresolved R1-R7 regressions.

Acceptance checks:
- A fresh owner can complete readiness, first source setup, first records, source truth review, recovery/defer, and first AI-client grant without repo checkout, chat context, raw owner token handling, or debug vocabulary.
- Product gestalt reads as a coherent personal-data control plane: calm, precise, serious, with no false alarms, false reassurance, buried risk, or walls of default text.
- Desktop avoids crushed sidebars and empty gutters; mobile avoids horizontal overflow, clipped buttons, wall text, and unusable tables.
- Row affordances, selected/focus states, spacing, transition behavior, density, and purposeful motion are consistent across source inventory, workbench, recovery, access review, and evidence timelines.
- Every surface in Waves 1-7 has screenshot evidence and no unresolved owner-trust/task blocker.

Needed data-truth proof:
- End-to-end journey evidence for the five product promises using safe live data where possible and fixtures only for missing archetypes.
- Browser console/network capture for each journey and a list of any owner-only live checks left as residual risk.

Pixel proof:
- Desktop and mobile journey atlas: overview/readiness, Add Data, source detail/counts, Explore, recovery, Connect AI Apps/Grants, evidence timeline.
- Visual diff or screenshot comparison after final craft pass, including long labels, empty/loading/error states, and narrow mobile.

Likely files/surfaces:
- Shared layout, navigation, page headers, table/list primitives, buttons/links, focus states, mobile shells, loading/error/empty states, all owner journey surfaces touched in Waves 1-7.

Safe delegation split:
- Lane A: desktop/mobile journey screenshot atlas.
- Lane B: shared component craft pass.
- Lane C: copy/microcopy and owner vocabulary pass.
- Lane D: fresh-owner walkthrough harness.

What not to change:
- Do not introduce decorative marketing hero patterns or broad visual rewrites that obscure data truth.
- Do not make craft a substitute for unresolved R1-R7 truth defects.
- Do not broaden scope into schedules, deployment, device exporters, or event subscriptions except to prevent reviewed journey regressions.

## First 72 Hours - Codex-Only Sequence

Goal: maximize the five product-promise outcomes while minimizing incidental complexity. Stay inside documentation, route/link helpers, UI state, and proof harnesses until a data-truth dependency proves a deeper change is necessary.

### Hours 0-8: Freeze The Product Spine

1. Read the OpenSpec change, feedback matrix, route/noun inventory, SLVP index, and voice/framing guide.
2. Create a small route/CTA/vocabulary audit artifact before touching product code.
3. Pick the primary owner noun decisions for implementation: Source for configured data-producing instance, Stream for typed record subset, Record for readable data item, Client for AI app/access subject, Grant/Read/Credential only where needed.
4. Identify all `View records`/`Explore`/`Review`/`Reauthorize` link builders and mark which packet owns each.
5. Run existing console type/lint/test baseline and capture failures before edits.

Expected outcome: Wave 1 has a concrete diff plan and proof checklist; no behavioral changes yet.

### Hours 8-24: Ship The Smallest Trust Spine

1. Implement Wave 1 noun/route/CTA fixes that do not require backend changes.
2. Add or update a vocabulary-boundary check/report for owner-facing surfaces.
3. Implement scoped URL builders for `View records` links if isolated enough; otherwise write tests first and leave adapters for Wave 4.
4. Capture desktop/mobile pixels for nav, source detail entry, Explore entry, and grants/access entry.
5. Re-read touched files and grep old names/patterns before claiming consistency.

Expected outcome: owner no longer has to translate page names or unsafe CTAs to understand where to go.

### Hours 24-40: Make Counts And Status Honest

1. Implement count-basis labels and reconciliation copy for source summary, stream rows, source detail, dashboard attention, and Explore entry points.
2. Add first-sync/setup/recovery auto-refresh acceptance at the UI boundary before broad recovery work.
3. Build fixture-backed proof for total held, current filtered result, latest-run yield, and page/window count.
4. Do not edit collector logic unless the fixture/live proof isolates R9.
5. Capture pixels for source truth and non-terminal/terminal status states.

Expected outcome: Know Data becomes credible enough to share internally, with remaining runtime gaps named instead of papered over.

### Hours 40-56: Make Add Data Shareable

1. Implement connector capability filtering for primary Add Data actions if data already exists in the console; otherwise create the narrow adapter seam and fixture tests.
2. Add exact provider-secret prerequisites/scopes/expiration guidance for proven flows, starting with GitHub.
3. Add owner label/account identity capture or echo before first sync where the UI can support it.
4. Fix rename propagation on newly added sources across detail, nav, source lists, Syncs/Runs, and Explore context.
5. Validate post-setup `View records` opens source-scoped Explore.

Expected outcome: Add Data no longer blocks the core deploy-connect-collect-use path.

### Hours 56-72: Close The First Inspect/Access Loop

1. Implement the smallest Wave 4 workbench slice needed for scoped Explore URL state, shared record rendering, selected row/detail, and full-set path.
2. Implement the smallest Wave 6 access-review slice needed for client grouping, grant scope, last-used/read facts if already available, revocation clarity, and scoped `View records`.
3. Run the five-promise smoke: Know Data, Add Data, Inspect Data, Recover Problems or correctly defer, Grant/Connect AI Apps.
4. Capture desktop/mobile pixel proof and console/network evidence.
5. Produce a concise residual-risk list for anything requiring owner live credentials or collector/runtime work.

Expected outcome: a reviewer can walk the critical path without finding a new trust blocker, and any remaining blocker is isolated to a named packet with proof requirements.

## Delegation Boundary

Safe to delegate:
- Read-only route/CTA inventories.
- Vocabulary scans.
- Pixel atlas capture.
- Fixture construction and focused tests.
- Isolated link-builder or count-label implementations with narrow file scope.
- Prior-art comparison against the named SLVP archetype for a single packet.

Keep Codex-owner controlled:
- OpenSpec updates.
- Cross-wave product noun decisions.
- Any protocol, grant, collector, manifest, or route-compatibility contract change.
- Final merge gate for data-truth proof and pixel proof.

## Review Gate Before Each Packet Closes

1. Acceptance checks pass.
2. Data-truth proof attached or residual risk names why only the owner/external credentials can prove it.
3. Desktop/mobile pixel proof attached.
4. Owner vocabulary boundary checked.
5. Touched files re-read.
6. Old name/pattern grep completed for any naming/semantic cleanup.
7. Relevant tests/checks run and results recorded.
8. No product code changes are included in this planning artifact.
