# Owner Console SLVP Prior-Art Index

Date: 2026-06-18
Status: Synthesis index
Scope: Product experience research corpus for `openspec/changes/redesign-owner-console-product-experience`

## Purpose

This index turns the owner-console prior-art corpus into implementation guidance. The corpus exists to prevent the next pass from treating the owner's feedback as a list of route-local bugs. The real goal is a console that makes a motivated personal-server owner feel:

> I know what data I have, I know how to add more, I know what is broken, I know what to do next, and I trust this system.

SLVP means Stripe, Linear, Vercel, and Plaid as literal product-quality references. It is not a backronym.

## Corpus

### A0. Product gestalt and data dignity

Doc: `docs/research/owner-console-product-gestalt-and-data-dignity-prior-art-2026-06-18.md`

Design force:

- The console must feel like a coherent personal-data control plane, not generated admin cards over backend data.
- Personal data needs calm agency: no false alarms, no false reassurance, no buried risk, no walls of default text.
- A page should make its job understandable from heading, primary content, and primary action.

Implementation consequence:

- Every owner-facing tranche needs a product-gestalt review, even if the data model is correct.

### A1. Record workbench and Explore

Doc: `docs/research/owner-console-record-workbench-explore-prior-art-2026-06-18.md`

Design force:

- Modern record workbenches have visible selection, URL-backed query state, facets, date controls, sorting, time distribution, pagination or virtualization, and rich record detail.
- Debug tables with a few filters do not meet the bar.

Implementation consequence:

- Explore cannot be closed by changing copy around a capped list.
- Full record visibility is non-negotiable for source and stream inspection.

### A2. Setup and connector catalog

Doc: `docs/research/owner-console-add-data-connector-setup-prior-art-2026-06-18.md`

Design force:

- Setup flows show exact prerequisites, scopes, links, identity echo, validation, and progress.
- Unavailable or future paths are not primary actions.

Implementation consequence:

- Add Data must be generated from connector capability, but generated output still needs product acceptance gates.
- A provider docs link is not a setup path unless it leads to the exact human prerequisite for a real flow.

### A3. Source inventory and detail

Doc: `docs/research/owner-console-source-inventory-and-detail-prior-art-2026-06-18.md`

Design force:

- Inventory pages distinguish health, freshness, coverage, schedule, counts, and owner action.
- Detail pages are first-class destinations and not hidden behind side-effecting verbs.

Implementation consequence:

- Source summary, source detail, dashboard attention, and runs/syncs summaries need one status/count predicate per fact.

### A4. Recovery and liveness

Doc: `docs/research/owner-console-recovery-and-liveness-prior-art-2026-06-18.md`

Design force:

- Recovery surfaces lead with one human cause and one closing action, then show progress and terminal reconciliation.
- Diagnostics are supporting evidence, not the job.

Implementation consequence:

- Local collector recovery cannot be "run these commands from memory." The console and CLI must close the loop together.

### A5. Access review, grants, and clients

Doc: `docs/research/owner-console-access-review-grants-clients-prior-art-2026-06-18.md`

Design force:

- Access review groups by client, explains what can be read, shows what was read, and makes revoke/status clear.
- Package mechanics and raw trace events cannot replace consent comprehension.

Implementation consequence:

- Connect AI Apps and Grants need client-centric detail and read history, not generic traces.

### A6. Evidence timelines, runs, and traces

Doc: `docs/research/owner-console-evidence-timelines-runs-traces-prior-art-2026-06-18.md`

Design force:

- Timeline/event detail should be dense, subject-scoped, filterable, and linked to adjacent artifacts.
- Generic evidence browsers are useful only after the owner has a subject.

Implementation consequence:

- Runs, traces, timelines, diagnostics, and tokens stay important, but they should normally be reached from Source, Grant, Read, Run, or Credential context.

### A7. Craft, mobile, and responsive interaction

Doc: `docs/research/owner-console-mobile-responsive-and-craft-prior-art-2026-06-18.md`

Design force:

- Clickable/selected/focused states need spacing and consistency.
- Desktop must avoid crushed sidebars and empty gutters; mobile must avoid horizontal overflow and wall text.

Implementation consequence:

- UI acceptance must include actual desktop and mobile pixels, not just unit tests or string checks.

### A8. Copy and microcopy

Doc: `docs/research/owner-console-copy-and-microcopy-prior-art-2026-06-18.md`

Design force:

- Good copy states what happened, why it matters, and what to do.
- Internal runtime terms must stay out of normal owner paths.

Implementation consequence:

- Copy changes need vocabulary-boundary review, not one-off wording patches.

### A9. Fresh owner journey

Doc: `docs/research/owner-console-fresh-non-owner-journey-prior-art-2026-06-18.md`

Design force:

- Fresh owners need staged readiness, setup, first records, and access review without repo knowledge.
- Self-hosted does not mean self-explanatory by logs.

Implementation consequence:

- The console must be testable by a motivated Docker/Railway owner who did not build the repo.

## Ten Decisions The Corpus Supports

1. `Source` is the owner-facing primary collection noun.
2. Runs, traces, diagnostics, device exporters, and tokens are evidence layers unless the owner intentionally enters advanced/debug mode.
3. Add Data primary actions must be real setup/import/enrollment paths for the current instance.
4. Bounded samples and performance caps are never terminal owner answers for record inspection.
5. Every owner-visible count needs a basis label and a drill-through or full-set path.
6. Recovery needs one cause, one closing action, live progress, and terminal reconciliation.
7. Explore must become a modern record workbench, including selection affordances and URL-backed state.
8. Access review needs client-centric scope and read history, not trace-first mechanics.
9. Fresh owners must be able to go from instance readiness to first records to first client grant without repo checkout assumptions.
10. Broad UI changes need real pixels, mobile pixels, browser console evidence, and adversarial review before deploy readiness.

## Implementation Guardrails

### Do not solve these with copy alone

- Count mismatches.
- Artificial caps.
- Dead-end setup actions.
- Recovery commands that do not close the loop.
- Grants that cannot explain what the client can read.
- Explore controls that are technically present but not usable.

### Do not solve these by hiding evidence

- Broken sources.
- Failed runs.
- Internal maintenance artifacts that affect owner-visible grants or reads.
- Local collector liveness.
- First-sync zero-yield states.

### Do solve these by reducing incidental complexity

- One owner noun model.
- One source of truth per owner-visible fact.
- Subject-scoped evidence.
- Generated connector setup from manifests plus product acceptance gates.
- Shared record renderer and workbench controls.

## Confidence Assessment

Broad diagnosis: 92%.

The corpus strongly supports the conclusion that PDPP's console problem is systemic product-model drift plus weak interaction contracts, not a finite list of bugs.

Critical path understanding: 88%.

Sources, Add Data, Explore, Recovery, and Access Review are clearly the dominant journeys. Runs/traces/tokens are supporting surfaces unless they are the subject of an advanced task.

Interaction-contract understanding: 82%.

The archetype standards are now much stronger, especially for Explore selection, full visibility, setup progress, recovery progress, and access review. Confidence remains below 90% because the actual UI must still be walked with real pixels and live data.

Adjacent-class inference: 78%.

The plan now anticipates classes the owner did not enumerate, such as fresh-owner readiness, generated setup drift, client grant package comprehension, mobile density, and long-running operation reconciliation. It still needs a live journey atlas to catch state combinations not represented in text feedback.

Ready to implement broad UI changes: not yet.

Narrow P0 fixes can proceed if they have a journey row, data-truth proof, and pixel evidence. Broad UI redesign must wait for Wave 0 evidence and acceptance packets.

## Required OpenSpec Effects

The product-experience OpenSpec should:

- Reference this corpus as a first-class research input.
- Add the fresh-owner journey to Wave 0 and acceptance gates.
- Preserve "no final caps" and "basis-labeled counts" as normative requirements.
- Require every implementation packet to identify an interaction archetype.
- Require broad UI worker lanes to supply desktop/mobile/live-browser evidence before acceptance.
- Make Codex RI-owner review the integration gate when Claude lanes are unavailable or rate limited.

## Open Risks

- The prior-art corpus is broad but still text-heavy. It needs a screenshot atlas from PDPP's real console.
- Some source states are rare and require synthetic fixtures.
- External delight cannot be proven internally. Internal work can only remove trust and task blockers before external testing.
- Runs/Syncs and Explore/stream unification remain design decisions, not settled implementation directives.
