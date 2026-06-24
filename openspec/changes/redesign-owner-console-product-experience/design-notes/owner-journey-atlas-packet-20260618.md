# Owner Journey Atlas Packet - 2026-06-18

Sources read from `/home/user/code/pdpp`: the owner feedback, owner-console redesign design/tasks, SLVP prior-art index, latest owner-journey acceptance reports, and screenshot filename inventory. Available screenshot inventory is currently only `scripts/phone/screenshot.sh`; new journey screenshots are required.

## Evidence Contract

Each journey capture must include:

- Desktop screenshot: full viewport plus any opened detail panel/row state.
- Mobile screenshot: same state at phone width, including nav/overflow behavior.
- Browser console/network: no uncaught console errors; failed requests accounted for; relevant API responses saved or summarized with status, URL, and count fields.
- Data-truth probe: CLI/API/database proof for every visible count, status, and drill-through target.
- Fixture note: list synthetic data needed to make the journey deterministic.
- Pass/fail: pass only when the owner question is answered by the product surface without requiring repo knowledge, hidden CLI memory, or manual URL guessing.

## OJ1 - Instance Readiness And Overview

- Route sequence: `/dashboard` -> `/dashboard/deployment` -> `/dashboard/deployment/tokens` only if credentials/readiness is the owner question.
- Owner question: "Is this instance ready, and what needs my attention first?"
- Expected product answer: one primary attention state, deployment readiness/prerequisites, source/read/grant summary counts, and links to the exact surfaces that resolve each item.
- Screenshots needed: desktop/mobile overview with attention state; deployment readiness state; any token/prerequisite state reached from overview.
- Browser-console/network evidence: overview and deployment requests settle; loading/checking states either resolve or explain why they remain unknown.
- Data-truth probes: compare overview attention count, source counts, grant counts, and deployment readiness with backing API/fixture state.
- Synthetic fixture gaps: ready instance; missing deployment prerequisite; one actionable source issue; no-action clean state.
- Pass/fail criteria: fail if dashboard uses inconsistent nouns, silently changes attention counts after reload, buries the primary Add Data path, or links to an unexplained runs/debug surface as the first answer.

## OJ2 - Add Data / Source Setup

- Route sequence: `/dashboard/records` -> `/dashboard/records/add` -> connector setup route under `/dashboard/connect/...` -> `/dashboard/connect/status/[connectionId]` or connector-specific status route -> source detail.
- Owner question: "How do I add this source and know first collection is actually working?"
- Expected product answer: connector catalog, real setup/import/enrollment path, credential/help links that preserve progress, setup status, first-run progress, and final source detail with record yield or honest no-record state.
- Screenshots needed: desktop/mobile catalog with Add Source CTA; selected connector setup; status/progress; post-setup source detail.
- Browser-console/network evidence: setup POST/launch/status polling requests; no same-tab credential-help navigation that loses state; status updates without manual refresh.
- Data-truth probes: connector manifest availability, source/connection creation, first run id, current run status, accepted/rejected record counts.
- Synthetic fixture gaps: successful browser-session connector; static-secret connector; manual upload/import connector; first-run pending; first-run no records; first-run failed.
- Pass/fail criteria: fail if setup exposes developer-only paths, unpublished CLI commands, raw setup-planner labels, transient-only post-submit state, or says setup/import is complete before first-run/record-yield truth is settled or explicitly separated.

## OJ3 - Record Inspection / Explore

- Route sequence: `/dashboard/records` -> source/stream row -> `/dashboard/records/[connector]/[stream]` or `/dashboard/explore?source=...&stream=...` -> record detail `/dashboard/records/[connector]/[stream]/[recordKey]`.
- Owner question: "Can I read and verify all records behind this source, stream, count, or filter?"
- Expected product answer: full-set path from every count/sample, URL-shareable filters, date/search/ID jump that works, honest bounded-sample labels, readable rendered record detail plus raw payload.
- Screenshots needed: desktop/mobile records inventory; stream table with filters; selected record; record detail/raw payload; empty/no-results state.
- Browser-console/network evidence: pagination/virtualization requests beyond initial window; filter/search/date/ID jump requests; copied/shared URL preserves state on reload.
- Data-truth probes: source stream count, filtered count, total held count, current page/window count, record id lookup, and backing raw record payload.
- Synthetic fixture gaps: stream over UI page size, stream with date spread, record with nested JSON, missing/retired stream tombstone, filter with zero results.
- Pass/fail criteria: fail if a bounded sample is the terminal answer, a stream count cannot drill through to all records, Jump to ID does nothing, deprecated alias errors leak to owners, table overflow/layout shifts obscure data, or URL state is not shareable.

## OJ4 - Source Recovery / Liveness

- Route sequence: `/dashboard/records` -> source detail -> source health/recovery route such as `/dashboard/records/[connector]/[stream]/health` when stream-scoped -> run/trace detail only as supporting evidence.
- Owner question: "What is broken, what can I do, and did recovery finish?"
- Expected product answer: one human-readable cause, one closing owner action, live progress, terminal reconciliation, and supporting diagnostics without making logs the primary task.
- Screenshots needed: desktop/mobile broken source row; source detail with recovery action; progress state; success/failure terminal state; diagnostic detail if linked.
- Browser-console/network evidence: recovery dry-run/apply/status requests; polling or push updates; terminal refresh without manual reload.
- Data-truth probes: source verdict, credential validity, schedule eligibility, coverage state, dead-letter/pending/sent counts, retry result, last successful run.
- Synthetic fixture gaps: credential expired; website/schema changed; dead-letter backlog; local collector offline; recovery succeeds; recovery fails with non-owner-action state.
- Pass/fail criteria: fail if the owner sees persistent "checking/unknown" without explanation, has to remember a local command, gets multiple competing actions, cannot tell whether rows were requeued/ingested, or source summary and detail disagree.

## OJ5 - Access / Grants / Connect AI Apps

- Route sequence: `/dashboard/grants` -> `/dashboard/grants/packages` -> `/dashboard/grants/packages/[packageId]` -> `/dashboard/grants/[grantId]` -> `/dashboard/connect` or grant request/bootstrap route when creating access.
- Owner question: "Who can read parts of me, what did I grant, what was read, and how do I revoke it?"
- Expected product answer: client-centric grants, package/child grant structure, active/revoked/expired state, disclosed scopes/records, read history, and clear revoke/status action.
- Screenshots needed: desktop/mobile grants list; package detail; grant detail/review; read/disclosure history; revoke confirmation/result; Connect AI Apps entry.
- Browser-console/network evidence: grant/package/read-history requests; revoke request and refreshed state; no table overflow or layout shift in detail views.
- Data-truth probes: grant package id, child grants, client id/name, scope set, revocation status, disclosure trace/read count.
- Synthetic fixture gaps: active package with multiple source-bound grants; revoked grant; expired grant; client with recent reads; client with no reads; broad consent/request flow.
- Pass/fail criteria: fail if a source-bound package renders as "one grant," review looks like an unexplained trace timeline, parent package links are unclear, read history is absent, or revoke does not reconcile visible status.

## OJ6 - Activity / Audit Evidence

- Route sequence: dashboard attention/link -> relevant source/grant/record detail -> supporting run/trace/timeline artifact. Runs, traces, diagnostics, device exporters, subscriptions, and tokens stay supporting surfaces unless the owner intentionally enters advanced/debug mode.
- Owner question: "What happened, when, to which source/grant/record, and what evidence supports it?"
- Expected product answer: dense subject-scoped event timeline with filters, linked artifacts, raw payload/detail where needed, and no duplicate noun model competing with sources/grants/records.
- Screenshots needed: desktop/mobile timeline or trace from a source issue; linked artifact/detail; filtered event list; empty/no-events state.
- Browser-console/network evidence: timeline/filter requests; artifact links resolve; no unexplained failed requests; back/forward navigation preserves selected subject.
- Data-truth probes: run id, trace id, event count, subject id, artifact id/path, diagnostic status, source/grant/record state before and after event.
- Synthetic fixture gaps: successful run; failed run; recovery event; disclosure/read event; artifact-linked event; empty timeline.
- Pass/fail criteria: fail if owner must interpret raw traces to answer a product question, events are not subject-scoped/filterable, artifact links dead-end, or runs/syncs become a competing primary noun for source health.

## Fresh-Owner Onboarding

- Route sequence: first visit `/dashboard` -> `/dashboard/deployment` -> `/dashboard/records/add` -> connector setup/status -> first source detail -> first stream/record inspection -> `/dashboard/connect` or `/dashboard/grants/request` -> grant/package review.
- Owner question: "Starting from a new instance, can I reach first records and first AI-client grant without being a PDPP developer?"
- Expected product answer: readiness checklist, deployment-setting prerequisites, first source setup, first collection progress, first record proof, and first client grant/readability review.
- Screenshots needed: desktop/mobile first-run dashboard; deployment prerequisites; Add Source; setup progress; first records; Connect AI Apps/grant creation; final grant review.
- Browser-console/network evidence: fresh-session route load, setup/status polling, first records request, grant request/package creation, console clean throughout.
- Data-truth probes: initial empty source/grant state, deployment config truth, connection/source id, first run result, first held record count, grant package/child grant state.
- Synthetic fixture gaps: truly empty owner; missing prerequisite; successful single connector; first records delayed; no-record connector; first grant to a test AI client.
- Pass/fail criteria: fail if onboarding assumes a checkout/local CLI, hides deployment prerequisites, cannot move from first source to first records, cannot create/review a first client grant, or requires manual URL construction.

## Global Fixture And Probe Backlog

- Fixture builder for: empty owner, healthy multi-source owner, source with dead-letter recovery, source with stale/unknown coverage, large stream, grant package with multiple child grants, read-history events, and artifact-linked run traces.
- Probe helpers for: rendered count -> backing count, source status predicate, stream drill-through, first-run status, recovery reconciliation, grant package tree, read-history/disclosure trace, and URL state reload.
- Screenshot capture helper should output predictable filenames by journey, viewport, and step, for example `oj3-desktop-stream-filter.png` and `fresh-mobile-first-grant.png`.
