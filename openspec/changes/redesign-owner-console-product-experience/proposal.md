# Redesign Owner Console Product Experience

## Why

The owner console still fails the product promise even after several verified UI tranches. the owner's 2026-06-18 walkthrough shows the same root pattern across Dashboard, Sources, Add Data, Explore, Runs, Grants, Traces, Owner Tokens, and local-collector recovery: the console exposes implementation artifacts as primary UX objects, computes the same truth in multiple places, and asks the owner to infer the next action.

This change treats `docs/inbox/the owner-feedback-6-18-26.md` as discovery evidence, not as a finite bug list. The goal is to establish the product model, journey ledger, acceptance gates, and implementation sequence needed to make a motivated personal-server owner feel:

> I know what data I have, I know how to add more, I know what is broken, I know what to do next, and I trust this system.

## What Changes

- Define the owner console's essential product model: Source, Record, Grant, Run/Trace evidence, Device, Schedule, Credential.
- Normalize the console around six stable owner journeys: source inventory, source setup/configuration, record inspection, source recovery, access/grants, and activity/audit evidence.
- Define SLVP interaction-archetype standards for record workbenches, source setup, source inventory, recovery, access review, evidence timelines, and craft.
- Treat Runs, Traces, Device Exporters, diagnostics, and raw timelines as evidence layers unless the owner is debugging a specific subject.
- Require a journey-keyed evidence atlas, real browser evidence, technical truth probes, and adversarial review before broad UI implementation.
- Define implementation waves that reduce incidental complexity before adding polish.
- Establish worker/delegation rules for high-velocity low-burn execution without letting narrow lanes decide product direction.

### 2026-07-03 owner request and audit findings

The 2026-07-03 owner review and three read-only audits (`tmp/workstreams/ui-url-brand-0703-report.md`, `ui-jump-0703-report.md`, `ui-owner-access-0703-report.md`) settle several decisions the earlier iterations had explicitly parked, and add a durable-contract change the change did not previously cover:

- Adopt a canonical clean owner-route topology and retire `/dashboard` as an owner-visible prefix. Root console is `/`, and sections are clean top-level nouns: `/sources`, `/syncs`, `/audit`, `/explore`, `/grants`, `/connect`, `/schedules`, with deployment/admin surfaces under clean top-level nouns as well. `/dashboard/*` is not preserved as compatibility behavior; owner-facing links and generated actions SHALL use the clean routes directly.
- Finish the owner-noun rename in every surface: Runs becomes Syncs, Traces becomes Audit, and the already-shipped Records→Sources label rename is completed to a matching route.
- Make the default brand PDPP, using the PDPP logo/mark. `Recordroom` is not the owner-visible default wordmark; it remains only as internal component/CSS identifiers.
- Unify the command palette to one component behind one Ctrl/Cmd+K listener, with autofocus on open, first-outside-click dismissal, live type-ahead/autocomplete/filtering over commands, and an explicit (not default) Explore/search fallback row.
- Make the owner-access overview scale: token/client label edit where the contract supports it, consistent timestamp semantics, a per-client token drilldown/details when `active_token_count > 1`, a preview+full-list pattern for bearers, collapsed zero-pending-approvals, discoverable grant packages, and an accurately labeled read/audit ladder.

These decisions supersede the earlier "keep `/dashboard`" and "defer route retirement" leanings recorded in the iteration log and the owner docket parking row; the design and spec deltas record the change.

### 2026-07-09 studio review and state-model convergence

A reconciled two-blind-assessment studio review
(`design-notes/studio-critique-20260709.md`), grounded in the 2026-07-09 owner
operating-reset and instance-health evidence, adds one durable direction the
change did not previously cover: the console consumes **one server-derived
owner state per source** (closed vocabulary, named resolver, evidence age and
posture, wired action) and deletes its parallel status derivations; headline
counts become definitionally equal to their lists; paused and refresh-due
sources carry honest semantics and a wired action; and the owner console gets
its own governing charter split from `.impeccable.md`'s leadership/demo brief.
Design §Iteration 18 and §Wave 10 and the spec delta record the decisions.

## Capabilities

Modified:

- `reference-surface-topology`

## Impact

- No product code changes are authorized by this proposal alone.
- Future owner-console changes that affect navigation, source setup, source state, record inspection, recovery, grant/read presentation, or evidence surfaces must map to the journey ledger and acceptance gates in this change.
- Existing console UI work may need to be reverted, replaced, or re-sequenced if it improves local copy while preserving the wrong product model.
- The `/dashboard` prefix removal changes the owner-visible route topology named normatively in `reference-surface-topology`; the spec delta modifies the affected requirements so they express owner-control-plane intent without pinning or preserving the `/dashboard` literal. `docs/voice-and-framing.md` §2–§3 (which cited `/dashboard/**`) must be reconciled to the new topology when the route work lands.
- Owner-access label edit and per-token drilldown require small additive reference-implementation contracts (RFC 7592 client-name update, a per-client token listing/revoke, and an optional grant-package count). Label-only polish (timestamp consistency, bearer preview/collapse, read-ladder relabel, package discovery link) needs no contract change and can land first.
