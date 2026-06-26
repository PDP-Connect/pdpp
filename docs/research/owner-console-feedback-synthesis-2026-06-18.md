# Owner Console Feedback Synthesis

Date: 2026-06-18
Owner: RI owner
Status: product synthesis for `docs/inbox/owner-feedback-2026-06-18.md`

## Purpose

This document preserves the synthesis of the 2026-06-18 owner walkthrough so it is not lost in chat or ignored worker reports. It complements OpenSpec change `redesign-owner-console-product-experience`.

## Source Inputs

- `docs/inbox/owner-feedback-2026-06-18.md`
- `docs/research/product-leadership-aperture-and-discovery-2026-06-18.md`
- `tmp/workstreams/feedback-taxonomy-20260618.md`
- `tmp/workstreams/feedback-ia-model-20260618.md`
- `tmp/workstreams/feedback-prior-art-20260618.md`
- `tmp/workstreams/feedback-technical-probes-20260618.md`
- `tmp/workstreams/feedback-plan-redteam-20260618.md`

The `tmp/workstreams` reports were read and folded into the OpenSpec design. This document records the durable summary.

## Product Standard

The owner console should make a motivated personal-server owner feel:

> I know what data I have, I know how to add more, I know what is broken, I know what to do next, and I trust this system.

This standard is stricter than "the listed complaints are fixed." The owner-feedback note is baseline discovery evidence, not a finite backlog.

## Canonical Journeys

| ID | Journey | Owner question |
|---|---|---|
| OJ1 | Source inventory | What data do I have, from which accounts/devices/files, and how current is it? |
| OJ2 | Source setup/configuration | How do I add another source, name it, configure it, reauthorize it, revoke it, or change its schedule? |
| OJ3 | Record inspection | Can I read, filter, verify, and share a view of the records? |
| OJ4 | Source recovery | What is broken, do I need to act, and what exact next action should I take? |
| OJ5 | Access and grants | Who can read parts of my data, what can they read, and what have they read? |
| OJ6 | Activity and audit evidence | What happened underneath this source, grant, read, run, or credential? |

## Canonical Root Codes

| Code | Root | What it means |
|---|---|---|
| R1 | Source truth/projection drift | Counts, freshness, coverage, last run, and samples disagree or are unlabeled. |
| R2 | Noun and route drift | Sources, Connections, Records, Runs, Syncs, IDs, and URLs require translation. |
| R3 | Setup action dishonesty | Unavailable or advanced paths look like primary owner actions. |
| R4 | Recovery agency/progress failure | Source is broken but the owner cannot understand or close the loop. |
| R5 | Record workbench weakness | Filters, pagination, ID jump, rendering, and URL state are not SLVP-grade. |
| R6 | Access/grant ambiguity | Packages, grants, scopes, reads, and clients are hard to relate. |
| R7 | Evidence-layer overload | Runs, traces, timelines, diagnostics, and tokens are over-promoted or unreadable. |
| R8 | Visual/interaction craft failures | Selected states, layout, density, mobile, and row geometry undermine trust. |
| R9 | Runtime or collector correctness gap | The console truth is blocked by missing runtime evidence or collector output. |

## Opportunity Map

| Priority | Opportunity | Root codes | Journeys | First wave |
|---|---|---|---|---|
| P0 | Make Add Data honest and complete for proven connectors, including multiple accounts and exact setup requirements. | R2, R3 | OJ2 | Wave 3 after Wave 1 noun spine |
| P0 | Establish one `Source` noun and route/headline/action model. | R2 | OJ1, OJ2, OJ6 | Wave 1 |
| P0 | Reconcile source truth projections: total held, bounded samples, last-run delta, coverage, freshness, and setup/run status. | R1, R9 | OJ1, OJ3, OJ4 | Wave 2 |
| P0 | Fix setup/status honesty: GitHub-style setup success must not imply records collected before first sync settles. | R1, R3 | OJ2 | Wave 2/Wave 3 |
| P0 | Fix local-collector recovery loop: explain cause, show progress, emit coverage diagnostics, and auto-reconcile after recovery. | R4, R9 | OJ4 | Wave 2/Wave 5 |
| P0 | Filter internal source artifacts from grant packages and explain package vs child grants. | R6, R9 | OJ5 | Wave 6 |
| P0 | Replace dead-end setup/provider CTAs with real actions or honest unavailable states. | R3 | OJ2 | Wave 3 |
| P1 | Make Explore a reliable record workbench: URL state, ID jump feedback, pagination/virtualization, autocomplete, date controls, and shared record rendering. | R5 | OJ3 | Wave 4 |
| P1 | Resolve Sources vs Runs/Syncs vs stream views through prior-art memo and owner-reviewed mock before merging or deleting surfaces. | R2, R7 | OJ1, OJ6 | Wave 0 decision |
| P1 | Make grants/reads answer "what can this client read?" and "what did it read?" without trace forensics. | R6, R7 | OJ5, OJ6 | Wave 6 |
| P1 | Replace raw timeline/table expansion patterns with one readable evidence component, linked from subjects. | R7, R8 | OJ6 | Wave 7 |
| P1 | Remove owner-facing implementation/debug leakage by enforcing an owner/operator/protocol vocabulary boundary. | R2, R7 | all | All waves |
| P2 | Repair visual craft problems: selected-row highlight, layout squish, row geometry, overflow, mobile density. | R8 | all | Wave 8, with P0 exceptions |

## Technical Truth Findings

The technical probe corrected several alarming first impressions:

- Amazon 1,183 vs 6 is not data loss. Sources shows all-time retained records; Explore shows a six-row bounded sample without enough context.
- GitHub connector data exists and the connector is healthy. The trust gap is setup/status language and conditional first-sync triggering.
- Local collector `checking` and `draining` states are mostly honest but owner-hostile. The real runtime gap is missing coverage diagnostics after recovery.
- The grant-package internal leak is bounded to one `pg_lexical_backfill_*` source path in affected packages, not a broad internal-source flood.
- Jump-to-ID is wired but undiscoverable because it requires Enter and gives no live feedback.

These findings move the first implementation waves away from broad data rewrites and toward projection truth, setup honesty, and IA repair.

## Key Design Decisions

- Owner-facing noun: `Source`.
- Internal/API term: `Connection` remains acceptable where the technical contract requires it.
- Primary objects: Source and Grant.
- Evidence layers: Runs, traces, timelines, diagnostics, devices, schedules, and credentials support a subject; they should not be the normal front door for owner comprehension.
- Structural merges are not decided by fiat. Runs/Syncs-to-Sources and Explore/stream-table unification require a prior-art memo and owner-reviewed mock before implementation.
- Workers produce evidence and narrow implementations; the RI owner owns product judgment and deploy readiness.

## Confidence

High confidence:

- The root failure is systemic product-model drift, not a finite list of component bugs.
- The first reliable move is source noun/model/truth alignment, not polish.
- The technical findings are sufficient to prevent re-investigating the same scary-but-not-data-loss issues.

Medium confidence:

- The final IA shape after Wave 0 decisions, especially Runs/Syncs and Explore/stream relationship.

Low confidence without future evidence:

- External-user delight. Internal agents can prepare the surface for external testing, but only real external users can prove it.
