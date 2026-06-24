# Owner Console Feedback Refresh

Status: captured
Owner: RI owner
Created: 2026-06-19
Updated: 2026-06-19
Related: `openspec/changes/redesign-owner-console-product-experience`

## Question

What did the owner actually ask us to do after sharing `docs/inbox/the owner-feedback-6-18-26.md`, including the later steering corrections and dispatched planning results, so future work stays grounded in the full intent rather than the first few complaints?

## Context

This note extracts the owner-console steering thread from the Codex session log around `~/.codex/history.jsonl` lines `22245-22546`. The feedback doc itself is the evidence baseline, but the surrounding conversation is the operating contract.

The thread was interleaved with StorageBackend, app-dev, and worker-coordination messages. Those are not the owner-console product goal. For this OpenSpec change, the relevant thread is:

- the owner shared `docs/inbox/the owner-feedback-6-18-26.md` after a 90-minute real-user walkthrough.
- the owner corrected the interpretation repeatedly: the doc is a baseline, not a finite backlog.
- the owner asked for SLVP product-manager judgment, prior-art-driven design, and aggressive iteration.
- the owner rejected local detail-churn and asked for execution that predicts his next review.
- the owner asked that the conversation and worker planning results be preserved as a refresh note.

## Stakes

If this thread is remembered only as a list of route bugs, the console will keep improving narrow strings/components while failing the actual product bar. The target is not "fix every named complaint." The target is:

> A motivated personal-server owner feels: "I know what data I have, I know how to add more, I know what is broken, I know what to do next, and I trust this system."

The implementation must infer adjacent failures from the feedback, not wait for the owner to name every missing affordance.

## Source Log Range

Primary session log extraction:

- `22245-22248`: the owner introduced the feedback doc and clarified it is baseline evidence, not full scope.
- `22249-22251`: the owner challenged the first shallow synthesis and clarified full visibility is required, not bounded samples with nicer labels.
- `22263-22266`: the owner rejected partial adjacent-class inference and required deeper feedback understanding.
- `22271`: the owner requested the full OpenSpec documentation process and an explicit confidence critique.
- `22286-22295`: the owner repeated the confidence question, pushed on reading between the lines, and named Explore selection affordances as an example of a major implied intent that could be missed.
- `22338-22349`: the owner distilled the alignment question and asked for deeper SLVP prior-art research to guide IA, affordances, copy, and design quality.
- `22353-22355`: the owner returned and directed Codex to proceed, then pivoted owner-console drive to Codex-only with sub-agents available.
- `22375-22395`: the owner asked for concrete user-facing examples, challenged confidence, warned against rabbit holes, and insisted RI owner personally vet dispatched work.
- `22421-22423`: the owner allowed deploys but no routine pushes, and demanded high-velocity/low-burn execution using low-cost agents where appropriate.
- `22425-22439`: the owner caught the behavioral pattern of overchecking/underdispatching and corrected process: batch implementation first, use 3-5+ lanes, do not spend wall-clock on premature Playwright loops.
- `22523`: the owner explicitly told us to find this conversation whenever needed to stay grounded.
- `22544-22546`: the owner rejected premature stop and asked for actual completion, then requested this refresh note.

## Core Steering Messages

### 1. The feedback doc is not a backlog

the owner's instruction was to treat `docs/inbox/the owner-feedback-6-18-26.md` as a baseline signal from which to digest, classify, triage, extend, and infer more comprehensive product failures. The named issues are examples of broken product judgment. They do not bound the work.

Implementation implication:

- Do not close a tranche by fixing only the explicitly quoted defect.
- For every named defect, identify the underlying interaction contract and nearby surfaces likely to share the failure.
- A worker report that says "fixed the complaint" is insufficient unless it proves the broader contract.

### 2. Full visibility is a hard promise

the owner corrected an attempted interpretation that "Amazon 1,183 vs 6" was simply a bounded sample mislabeled as a count. The correction was that data should be fully visible. An honest preview label may be necessary, but it is not enough when the owner is trying to inspect backing records.

Implementation implication:

- Bounded samples are allowed only as previews.
- Every preview/count/rollup must have a subject-scoped path to the complete backing set through pagination, cursoring, virtualization, or a clearly specified missing contract.
- "Showing 6 recent orders of 1,183" is not an acceptable final design for the stream-inspection context if the owner cannot inspect all 1,183.

### 3. Adjacent inferred failures are part of the task

the owner repeatedly asked about feedback he did not explicitly give but that should be trivial to anticipate from the given feedback. He named Explore selection affordances as the example: even if the owner model is understood, the UI can still fail modern interaction expectations.

Implementation implication:

- Explore/Record Workbench must include sane selection/focus affordances, keyboard-visible state, URL-backed state, filters/operators/date/sort/ID jump, and rich record detail.
- The acceptance bar is not "correct data appears"; it is whether modern users see a credible product interaction.
- Adjacent areas like grants, traces, tokens, deployment, and schedules remain risk until checked. the owner explicitly declined to review them in detail but said similar feedback would likely exist.

### 4. Prior art is an execution input, not after-the-fact justification

the owner asked for deep SLVP prior-art research to guide design, affordances, IA, and copy. The research corpus is meant to prevent solving hard product problems with local text edits.

Implementation implication:

- Use `docs/research/owner-console-slvp-prior-art-index-2026-06-18.md` as a gate for hard surfaces.
- Prior art should define expected affordances before implementation.
- The products named across the corpus are literal quality references: Stripe, Linear, Vercel, Plaid, Datadog, GitHub, PostHog, DevTools, Airtable, Algolia, Notion, Google account access, GitHub app authorization, Apple, Tailscale, Railway, Vercel, Supabase.

### 5. The RI owner must control product judgment

the owner's concern was not that Codex failed to see problems. The concern was that Codex would understand many problems, then implement small real fixes while avoiding the hard SLVP-tier solution. the owner explicitly asked the RI owner to personally vet and control solution quality and prioritization, while using sub-agents for bounded work.

Implementation implication:

- Workers gather evidence, implement focused slices, or red-team. They do not own product judgment.
- The RI owner must reject worker output that is page-local churn, copy-only, non-vertical, or missing journey proof.
- Low-cost workers should be used for breadth, but their outputs need owner-level synthesis before merging/deploying.

### 6. High velocity / low burn means batching and delegation, not slow proof loops

the owner corrected premature browser/check loops. His process guidance was to batch implementation after deep planning, aim for 3-5+ lanes where possible, use lower-cost agents, keep an eye on clawmeter estimates, and avoid heavy Playwright/live checks until the majority of a planned slice is implemented.

Implementation implication:

- Do not run a browser loop after every minor local change.
- Use focused tests and source invariants during implementation.
- Use live/pixel proof as the deploy gate for a coherent tranche, not as a substitute for product design.
- Do not push routinely. Work locally, commit locally, deploy when useful under the live-stack mutex, and push only at intentional epic boundaries.

### 7. Actual completion means implemented, deployed, and re-walked

the owner clarified that "task complete" means the planned outcome is actually implemented, iteratively reviewed, improved, deployed, and high-confidence for the next user review. Returning after one slice, one plan, or one test pass is premature.

Implementation implication:

- Do not report overall completion while OpenSpec tasks remain open.
- A tranche can be complete; the owner-console goal is not complete until the owner-spine gate passes across the core journeys.
- Each deployment should tell the owner what to check, then continue the broader loop.

## Dispatched Planning Results To Preserve

### Feedback interaction-contract matrix

Artifact: `tmp/workstreams/feedback-contract-matrix-20260618.md`

Key result:

- The feedback was decomposed into owner-visible contract failures, not pages.
- Critical classes include dashboard attention contradiction, Sources/Syncs overlap, count basis mismatch, setup/status detachment, duplicate source identity, owner-facing debug terms, grants lacking scope, and trace/read filters missing client/grant/source context.
- Cross-cutting roots include subject-scoped hrefs/filter controls, verdict-axis reconciliation, Explore pagination/full visibility, console reads using `connection_id`, and create-time source naming.

Use this as:

- The lossless mapping from the feedback doc to implementation contracts.
- A guard against saying "we fixed the issue" when only one instance was addressed.

### Friction-to-SLVP direction

Artifact: `openspec/changes/redesign-owner-console-product-experience/design-notes/friction-to-slvp-direction-20260618.md`

Key result:

- Repeated friction is evidence of missing product contracts.
- Hard surfaces require charters before broad implementation.
- The rabbit-hole filter allows work only when it improves a product promise, removes a trust blocker, establishes a reusable contract, or is tiny and unambiguous inside an accepted slice.

Use this as:

- The preflight for broad UI changes.
- The rejection basis for "this is real but not on the active spine."

### Owner route / noun / headline inventory

Artifact: `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-route-noun-inventory-20260618.md`

Key result:

- Owner-facing nouns drift across Source/Connection/Records/Runs/Syncs/Explore/Grant/Trace/Token.
- `/dashboard/records` is labeled Sources; `/dashboard/runs` is labeled Syncs; source detail still leaks connector/connection terms.
- A route/noun map and vocabulary-boundary scan are required before route/IA work is considered sound.

Use this as:

- The Wave 1 noun/route acceptance reference.
- The guard against renaming strings without deciding surface jobs.

### Owner journey atlas packet

Artifact: `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-journey-atlas-packet-20260618.md`

Key result:

- The six canonical owner journeys are OJ1 readiness/overview, OJ2 Add Data/setup, OJ3 record inspection, OJ4 recovery/liveness, OJ5 access/grants, and OJ6 activity/audit evidence.
- Each journey requires desktop/mobile pixels, browser console/network evidence, data-truth probes, fixture notes, and pass/fail criteria.

Use this as:

- The evidence contract for deploy gates.
- The prevention against unit-test-only UI acceptance.

### Owner spine charter synthesis

Artifact: `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-spine-charter-synthesis-20260618.md`

Key result:

- The implementation spine is one owner journey, not seven page redesigns.
- Primary owner objects: Source, Stream, Record, Client, Grant, Read.
- Evidence/supporting objects: Run, Sync, Trace, Diagnostic, Artifact, Raw payload.
- First build sequence: fresh-owner vertical, source truth/counts, record workbench, recovery liveness, access review, evidence, craft/mobile.

Use this as:

- The durable product object model.
- The acceptance lens for every implementation slice.

### Owner implementation packets

Artifact: `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-implementation-packets-20260618.md`

Key result:

- Wave 1: owner noun/route spine.
- Wave 2: source truth/counts.
- Wave 3: Add Data setup.
- Wave 4: Inspect Data Record Workbench.
- Wave 5: recovery agency/progress.
- Wave 6: grants/reads/connect AI apps.
- Wave 7: evidence timelines/runs/traces.
- Wave 8: craft/mobile/fresh-owner closeout.

Use this as:

- The dispatch map for workers.
- The "what not to change" guardrail for each wave.

### Prior-art index

Artifact: `docs/research/owner-console-slvp-prior-art-index-2026-06-18.md`

Key result:

- The corpus supports ten product decisions: Source as primary collection noun, evidence layers as secondary, real Add Data paths, no terminal bounded samples, count-basis labels and drill-through, one-cause recovery, Explore as modern record workbench, client-centric access review, fresh-owner path, and pixel/mobile/adversarial proof before deploy readiness.

Use this as:

- The source of quality-bar expectations.
- The defense against "acceptable" but non-SLVP solutions.

### Initial live atlas and owner-spine browser proof

Artifacts:

- `openspec/changes/redesign-owner-console-product-experience/design-notes/initial-live-atlas-pass-20260618.md`
- `openspec/changes/redesign-owner-console-product-experience/design-notes/owner-spine-browser-proof-20260618.md`

Key result:

- The browser evidence loop works, but the initial atlas was incomplete.
- One vertical source-continuity slice was proven, not the whole console.
- The first browser pass caught failures local tests missed: raw source ID in breadcrumb and deprecated alias warning.

Use this as:

- Evidence that live/pixel proof is required.
- Also evidence that proof must be tranche-level, not every micro-edit.

## Product Contracts Extracted From The Thread

### Know what data I have

- Sources must show real held data, stream counts, coverage, freshness, schedule, and source identity without contradictions.
- Counts must be basis-labeled and drillable.
- Duplicate sources for the same connector must be distinguishable by owner-controlled labels and account identity.
- Retained/retired streams must be explained, not dead links.

### Know how to add more

- Add Data must show proven, addable connector paths first.
- Unavailable connectors must not masquerade as setup actions.
- Multiple accounts must be supported for proven connectors.
- Setup must state prerequisites, validate credentials, echo identity, name the source, show first-sync progress, and route to the exact source.

### Live Add Data Blocker: Browser Account Identity

2026-06-19 live owner report:

- The owner tried to add a new Amazon account.
- The flow said "Amazon - Personal is back on it" without asking for credentials/account identity or visibly showing the browser stream first.
- Collection started, probably against the wrong account.
- Live source data showed two active Amazon sources with the same display name, `Amazon - Personal`, with different record totals.

This is a core OJ2/OJ1 trust blocker, not just bad copy. A browser-backed "add account" flow must not imply a new source/account while silently resuming or collecting against an existing provider session. The acceptable fix must bind:

- setup mode: create-new-source vs retry/reconnect-existing-source
- source identity: owner label plus exact source route
- provider account/session identity: confirmed or explicitly unknown before collection
- browser profile/session behavior: reused profile vs fresh login path
- run language: "resume/retry this source" vs "add this account"

Until that contract holds, browser-session Add Data is not SLVP-ideal for multi-account browser providers, even if the connector can technically collect records.

### Know what is broken

- Health, freshness, coverage, schedule, outbox, and owner action are separate axes but must reconcile into one owner-readable verdict.
- Unknown/checking states must not look like success or failure.
- Dashboard attention counts must explain exactly which sources need owner action.

### Know what to do next

- Recovery shows one human cause and one closing action, not a wall of diagnostics.
- Device-local actions navigate to instructions and resolved commands; dashboard buttons must not imply web-executable local commands.
- Code-fix/maintainer states should offer an honest report path, not hosted-service "we are on it" copy.

### Trust this system

- No deprecated alias warnings, internal grant package mechanics, raw connector IDs, debug token copy, or personal project names should appear in normal owner flows.
- Evidence layers remain available but subject-scoped and secondary.
- Raw JSON is supporting evidence, not the primary owner explanation.
- Every deployed tranche needs enough journey proof to avoid tests passing while the product fails.

## Current Completion Gate

The owner-console OpenSpec change cannot be considered complete until all of the following are true:

1. The core journeys OJ1-OJ6 have working, subject-scoped paths through the live console.
2. The Source -> Stream -> Record -> Explore path offers full visibility, not terminal previews.
3. Add Data supports proven connector setup for multiple accounts with identity, progress, and exact source routing.
4. Recovery shows one human cause, one closing action, progress, and terminal reconciliation.
5. Access Review is client-first: can read, has read, revoke, evidence, and scoped records.
6. Counts, status, and health are basis-labeled and reconciled across overview, source detail, runs/syncs, and Explore.
7. Desktop and mobile pixel evidence exists for the deployed core journeys.
8. Browser console/network evidence is clean or accounted for.
9. Data-truth probes back every status/count/full-set claim.
10. An adversarial reviewer tries to prove the work is page-local churn, copy-only, or non-SLVP before deploy-readiness is claimed.

## Current Leaning

This thread raises confidence that the correct target is known, but it lowers tolerance for isolated local fixes. The right operating mode is:

- Use this refresh note plus the OpenSpec design/tasks as the working memory.
- Implement coherent vertical slices in batches.
- Let low-cost workers audit/implement bounded seams.
- RI owner personally accepts or rejects product judgment.
- Deploy coherent tranches under the live-stack mutex and re-walk them.
- Do not report overall completion until the owner-spine gate is satisfied.

## Promotion Trigger

Already promoted into `redesign-owner-console-product-experience`. Any new durable user-facing behavior, route contract, setup contract, recovery state, access-review model, or read-workbench contract discovered while executing this note should update that OpenSpec change before or alongside code.

## Decision Log

- 2026-06-18: Feedback doc treated as baseline evidence, not full backlog.
- 2026-06-18: OpenSpec change `redesign-owner-console-product-experience` created with waves and owner-journey framing.
- 2026-06-18: Worker planning artifacts produced: contract matrix, noun inventory, atlas packet, implementation packets, charter synthesis, prior-art index, initial atlas, owner-spine proof.
- 2026-06-19: the owner requested the original conversation be re-read from session log and extracted into this refresh note before proceeding.
- 2026-06-19: Live Add Data blocker added to the active ledger: Amazon browser-session setup can say "Amazon - Personal is back on it" and start collection without proving the owner is creating or collecting the intended account. This reinforces that setup must bind run-start language, source identity, and account/session confirmation before collection.
