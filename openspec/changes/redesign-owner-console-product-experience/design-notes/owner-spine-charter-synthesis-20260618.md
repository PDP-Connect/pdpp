# Owner Spine Charter Synthesis

Date: 2026-06-18
Status: accepted owner decision
Source inputs:

- the owner feedback: `docs/inbox/the owner-feedback-6-18-26.md`
- OpenSpec change: `redesign-owner-console-product-experience`
- Worker charters: Sources/Syncs/Runs, Explore/stream records, Add Data/setup, Recovery/liveness, Grants/Connect, Evidence timelines, Fresh owner
- Adversarial worker: charter alignment red-team

## Decision

The implementation spine is not seven independent page redesigns. It is one owner journey:

1. Confirm this instance can add real data.
2. Add one real Source with a meaningful identity.
3. Watch first collection reach a terminal state.
4. Inspect the complete backing records through the shared workbench.
5. Understand and repair one broken/stale Source without diagnostic spelunking.
6. Connect one client and understand what it can read and what it has read.
7. Open evidence only as scoped proof for a Source, Record, Grant, Read, or recovery action.

This is the acceptance lens for all implementation slices. A page-local improvement that does not improve this spine is deferred unless it is a tiny opportunistic fix inside an accepted slice.

## Why

The worker charters agree on the same root failure: the console exposes implementation artifacts before it establishes owner confidence.

The red-team found the remaining risk: the charters could still produce four or seven polished sub-surfaces instead of one coherent owner product. That risk is real. the owner's next review will not evaluate "Sources" or "Explore" as isolated components; it will evaluate whether a motivated owner can move through setup, source status, records, recovery, and access review without losing trust.

## Owner Object Model

Owner-facing primary objects:

- **Source:** configured data-producing account, device, artifact import, or provider-backed connection.
- **Stream:** typed record subset under a Source.
- **Record:** collected item the owner can inspect.
- **Client:** app or agent that can request/read data.
- **Grant:** permission backing a Client's access.
- **Read:** actual access/disclosure event by a Client.

Evidence/supporting objects:

- **Run / Sync / Trace / Diagnostic / Artifact / Raw payload:** scoped evidence for a Source, Record, Client, Grant, Read, credential, device, schedule, or recovery action. These may be browsable for advanced work, but they are not the default owner path.

## Surface Contracts

### Sources, Syncs, Runs

- Source is the primary collection object.
- Run/Sync is evidence about a collection attempt.
- Every count declares a basis: total held, current filtered result, current page/window, latest-run yield, latest-run-with-new-data yield, or needs-action predicate.
- Every rollup count drills into the same predicate that produced it.
- Source detail must preserve useful run facts, especially per-stream records collected, without making broad Runs/Traces the first answer.

### Add Data And Setup

- Unavailable connectors do not get primary setup actions.
- Setup begins by naming exact provider prerequisites, scopes, identity, and multiple-account behavior.
- Credentials or OAuth state are validated before durable success.
- Success means `Connected as <identity>` plus first-sync progress and a link to first records, not just "submitted" or "created".
- A fresh Docker/Railway owner must not need repo checkout, chat memory, hidden env knowledge, or developer-only commands.

### Explore And Stream Records

- Explore and stream-scoped record views share one record workbench.
- Every entry point carries subject scope in the URL: Source, Stream, Client/Grant/Read when applicable, query, filters, date range, sort, cursor/window, and selected record.
- Bounded samples are previews only. The owner must have a full-set path through pagination, cursoring, or virtualization.
- The UI distinguishes total held, filtered count, and shown page/window count.
- Selection, ID jump, date range, filters, sort, and record detail must be visible, keyboard reachable, and restorable.
- Raw JSON is a secondary face of a rich record detail, not the canonical owner explanation.

### Recovery And Local Collector Liveness

- Recovery shows one human cause, one closing action, progress, and terminal reconciliation.
- CLI output is evidence, not the owner journey.
- The web console and CLI must converge on the same terminal source state, or the UI must say it is still checking.
- Unknown/checking is a named state, not green, red, silence, or fake certainty.
- Diagnostics are available behind details; they do not lead.

### Grants And Connect AI Apps

- Client is the primary access-review object.
- The owner must be able to answer: which clients can read data, what exactly they can read, what they have read, and how to stop them.
- Packages, scopes, raw grant IDs, traces, and protocol terms are supporting mechanics unless they directly explain client access.
- Client detail separates "Can read" from "Has read" and deep-links into Explore with scoped URL state.
- Revocation states immediate effect, preserved historical read evidence, and what cannot be recalled from the client.

### Evidence Timelines

- Evidence is subject-scoped before it is global.
- Subject pages may show compressed evidence strips and link to full scoped detail.
- Full evidence detail uses dense list/timeline plus inspector, ordered as Summary, Artifacts/Related Objects, Raw Payload.
- Jump-to-ID must show success/failure feedback and preserve subject context.
- Raw payloads and protocol artifacts are mandatory for auditability but secondary in the owner path.

### Fresh Owner

- The first-run path must prove: readiness, first addable source, first records, first client grant.
- Missing deployment/runtime/provider prerequisites name the exact owner action.
- No setup path is considered complete until first collection is terminal and record inspection is reachable.

## Alignment Gate

Before broad implementation or deployment, a slice must pass this gate:

- **Product promise:** It directly improves at least one of: know data, add more, recover, inspect records, review access, trust system.
- **Vertical continuity:** It preserves Source identity and owner language across setup/status/records/evidence/access.
- **Truth basis:** Every visible count/status/action names or implies a single data source and basis; contradictory projections fail.
- **Full visibility:** Samples/caps are not terminal answers; the full backing set is reachable or the limitation is explicitly unresolved.
- **Subject-scoped evidence:** Runs, traces, diagnostics, and raw payloads are evidence for a named owner subject, not generic detours.
- **Pixel proof:** Desktop and mobile screenshots exist for the journey state under review.
- **Interaction proof:** Selection/focus/keyboard/URL-state behavior is verified for controls the owner will use.
- **Console/network proof:** Browser console and failed-network evidence are captured for the journey.
- **Adversarial proof:** A separate worker or reviewer tries to prove the tranche is page-local churn, copy-only, or internally inconsistent.

## First Build Sequence

1. **Fresh-owner vertical slice:** readiness -> Add Data -> one real Source -> first-sync progress -> first records -> one client grant review.
2. **Source truth/count basis slice:** Sources, Syncs/Runs, and Source detail share count basis labels and predicate drill-through for one real multi-stream Source.
3. **Record workbench slice:** stream drill-through and Explore become one URL-backed workbench with full-set navigation, ID jump feedback, selection affordance, and rich detail/raw JSON split.
4. **Recovery liveness slice:** one local-collector-backed broken Source shows one cause/action/progress/terminal reconciliation with no default diagnostic wall.
5. **Access review slice:** one Client detail shows Can read / Has read / Revoke / Explore-scoped activity without package or protocol jargon as the headline.
6. **Evidence slice:** one Source-scoped run/evidence timeline preserves per-stream collection facts and links back to Source and records.
7. **Craft/mobile slice:** apply visual, motion, responsive, and selected-state polish only after the above contracts are true.

## Explicit Non-Goals For Initial Slices

- Renaming routes without changing the underlying product contract.
- Improving copy around bounded samples while keeping data unreachable.
- Making Runs/Traces a better generic browser before subject-scoped evidence works.
- Building a generic policy editor before Client review works.
- Treating a CLI command as recovery completion.
- Hiding unavailable connectors by relabeling them as real actions.
- Letting raw JSON, raw IDs, package IDs, connector keys, or monorepo commands be primary owner copy.

## Owner Confidence Assessment

Confidence that the plan now captures the owner's stated and implied product judgment: high, but not complete until implementation evidence exists.

- Broad problem diagnosis: 95%.
- Product object model and journey sequence: 92%.
- Interaction-contract understanding: 88%.
- Ability to predict next-review delight from planning alone: 70%.
- Ability to raise confidence through the gate above: 90% if every implementation tranche includes live/pixel/journey evidence and adversarial review.

The remaining uncertainty is not conceptual; it is execution risk. The mitigation is to ship vertical slices only after whole-journey evidence, not to keep adding planning prose.
