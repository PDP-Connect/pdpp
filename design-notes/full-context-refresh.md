# Full Context Refresh

Status: captured
Owner: reference implementation owner
Created: 2026-05-19
Updated: 2026-06-01
Related: spec-core.md, spec-collection-profile.md, spec-architecture.md, spec-dti-alignment.md, docs/personas/pdpp-reviewer-onboarding.md, openspec/changes/define-connector-instances, openspec/changes/design-local-device-exporter-collection, openspec/changes/publish-pdpp-local-collector, openspec/changes/complete-local-agent-collectors, design-notes/local-collector-durable-work-substrate-2026-05-19.md

## Question

What full PDPP context should guide current reference implementation work, especially local collectors, connections, schedules, connector reliability, and remote surfaces?

## Context

PDPP is not primarily a connector framework. It is an authorization and disclosure protocol for personal data. A user authorizes an app or AI agent to access specific records from a personal server, and the resource server enforces that grant.

The load-bearing split is:

- Connector manifests define the consent surface.
- Grants define actual consent.
- The resource server enforces disclosure under grant constraints.
- Collection is one way data gets into the resource server.

The Collection Profile is a companion profile, not Core. It standardizes bounded connector runs around runtime bindings, normalized scope, state, records, and completion messages. It must remain agnostic to whether a connector uses an API, browser automation, local filesystem access, uploaded artifacts, or future platform-native portability APIs.

The reference implementation exists to prove the paradigm and make it inspectable. It is not a toy demo, and it must not let current implementation needs leak into protocol semantics.

## Stakes

The project has several audiences at once:

- the owner, validating whether the paradigm is powerful and general enough.
- Vana/OpenDataLabs engineering, evaluating data portability as production infrastructure.
- Peer engineering teams with similar personal-data collection and disclosure problems.
- Regulators and DTI/standards reviewers, evaluating whether the model is disciplined, honest, and complementary to existing portability efforts.
- App and AI-agent developers, who need predictable grant-scoped query semantics.
- Connector authors, who need a clear Collection Profile runtime contract.
- Personal-server operators and users, who need safe ownership, scheduling, consent, revocation, interaction, and diagnostic UX.

Optimizing for only one audience creates wrong architecture. A connector hack may unblock one run but weaken the standards story. A standards abstraction may be elegant but useless if the reference implementation cannot prove it against real sources.

## Current Leaning

The current local-collector and connection work should be understood as reference implementation and Collection Profile machinery, not as new PDPP Core semantics.

The clean noun model should be:

- `connector_id`: stable connector type or manifest identity, such as Gmail, ChatGPT, Claude Code, or Chase.
- `connection`: owner-facing configured source, such as "Gmail personal", "Claude Code on Simon laptop", or "Chase card account".
- `connector_instance_id`: technical storage/runtime identity for a configured connection.
- `device`: enrolled local machine or personal-server-adjacent runtime host.
- `run`: one bounded execution attempt against a connection or source.
- `schedule`: policy for when runs are requested or suggested.
- `coverage`: honest statement of collected, skipped, unavailable, inventory-only, deferred, or failed streams.
- `grant`: immutable consent artifact for disclosure to a client; not a collection run, connection, or device.

This model preserves the Core/Collection split:

- Core grants and resource-server queries remain collection-method agnostic.
- Collection Profile runs operate on normalized scope and bindings, never raw grants.
- Reference implementation UX can expose connection/device/run/schedule concepts without implying they are protocol requirements.

## Boundary Map

PDPP Core owns:

- record envelope and stream semantics
- manifest consent surface
- selection request shape
- immutable grants
- grant-bound access tokens
- resource server query enforcement
- field, stream, resource, time-range, and change-projection enforcement
- security and privacy semantics such as data minimization, purpose/retention classification, revocation boundaries, and auditability primitives

Collection Profile owns:

- connector runtime contract
- runtime binding matching
- normalized `START.scope`
- `RECORD`, `STATE`, `DONE`, and interaction messages
- connector conformance
- owner-token ingest and state management for implementations claiming Collection Profile support

Reference implementation owns:

- Docker deployment topology
- n.eko and remote-surface substrate
- local collector package shape and CLI convenience
- dashboard UX
- connector health and fixture capture
- schedules and notifications
- source-specific connector implementation
- storage layout, event spine, traces, and operational diagnostics

These boundaries matter because current work is easy to over-promote. For example, local devices and browser surfaces are important to the reference implementation, but a conformant PDPP Core resource server can serve pre-collected or manually imported records without either.

## Technical Values

The reference implementation should meet the SLVP bar: simple, lossless, verifiable, and polished enough to resemble work from Stripe, Linear, Vercel, or Plaid.

In practice:

- Prefer essential complexity over incidental complexity.
- Prefer explicit protocol boundaries over convenient coupling.
- Preserve meaning instead of hiding failures behind green statuses.
- Treat gaps as first-class outputs when completeness is not achieved.
- Build shared runtime primitives when several connectors need the same behavior.
- Keep browser automation framed as a portability polyfill, not the ideal end state.
- Verify real user journeys and inspect stored records/timelines before claiming success.
- Keep protocol facts, manifest-authored descriptions, structured policy declarations, and client-authored claims visually and semantically distinct.
- Do not conflate revocation, deletion, retention, access validity, data freshness, and collection state.

## Standing Principle: Good Construction Before Feature Lists

When a problem appears to require a long list of features, first ask what small set of durable primitives would make those features correct by construction. The reference implementation should avoid accreting one-off fixes for each source, device, connector, or UX symptom when the same pressure points reveal a missing construction boundary.

The standard test is:

```text
If a novel or exotic use case appeared later, would this design still look like
the right foundation, or would it expose that we only patched today's case?
```

Prefer designs that identify the essential nouns, invariants, and ownership boundaries, then implement the minimum behavior needed to prove them. For collection work, this often means reasoning in terms of connection, runtime, bounded work, progress, backlog, and policy rather than enumerating source-specific setup features. For UI work, this means separating the durable state model from its current presentation. For protocol work, this means keeping reference-only operational mechanisms from leaking into Core unless they have earned standardization.

This is not a license to over-generalize. The bar is construction quality, not abstraction volume. A new primitive is justified only when it reduces incidental complexity across multiple concrete cases, makes correctness easier to verify, or prevents a class of false-success/failure modes. Otherwise, keep the solution local and honest.

Advertised capabilities need end-to-end conformance gates, not isolated implementation checks. If metadata says a client can use a feature, the schema, generated docs, agent skill, MCP/tool input shape, request builder, REST route, and runtime enforcement should all agree on the same invocation shape. Acceptance checks should include at least one canonical positive case and at least one plausible noncanonical negative case that proves the system errors instead of silently widening the read or falling back to an unfiltered result. This is part of the SLVP construction bar, not a separate audit project.

## Research Corpus Discipline

Prior-art research that informs OpenSpec or implementation work should leave a durable source artifact, not just a chat summary or worker report. Design notes are not that corpus: they are the intake queue for significant design observations and unresolved questions to revisit when the project shifts from execution mode into slower architecture review.

For non-trivial research, preserve a small, curated research artifact under `docs/research/` for cross-cutting work or `openspec/changes/<change>/research/` for change-local work. Record sources, dates, provenance, and the conclusion we are carrying forward. Link from a design note only when the research creates a significant observation or open question that belongs in the architecture-review queue.

Hand-written synthesis is usually enough when the source material is stable and linkable. Direct downloads or copied artifacts are appropriate when the original is likely to move, when exact wording matters, or when reviewers need to inspect the source offline. Keep these artifacts scoped and citeable; do not dump large logs, private records, or source material whose reuse is unclear.

Worker reports are transient coordination evidence. If research changes the protocol surface, reference contract, architecture boundary, security posture, storage model, user-facing behavior, or multi-step implementation plan, promote the finding into OpenSpec before implementation depends on it. If the research instead surfaces an unresolved implication, capture that implication in a design note rather than turning the note into the research corpus.

## History To Preserve

The core design already converged on a few non-negotiables:

- Core and Collection Profile are separate.
- Manifests and grants must not be conflated.
- Consent UI semantics matter because users must be able to distinguish enforceable protocol constraints from policy declarations and client claims.
- Projection-safe incremental sync is one of PDPP's distinctive privacy properties and must be verifiable.
- DTI alignment is strategic: PDPP should define parameterized consent and disclosure semantics, while DTI and similar efforts can handle transfer mechanics and canonical models.
- Browser automation is a polyfill for missing portability APIs.
- Connector trust, provenance, maintenance, and source-specific decay are not side concerns for the Collection Profile story.

Recent reference implementation history also matters:

- Browser-backed connectors drove the n.eko remote-surface work because users need to complete real manual actions from their own devices.
- The remote-surface substrate has been extracted toward an internal package boundary so it can later be published or reused without PDPP-specific leakage.
- Connector reliability work exposed the need for fixture-first debugging, honest gaps, connector health state, and fewer user-driven test runs.
- Local Claude/Codex collectors exposed the need for a first-class connection model that supports multiple accounts, multiple devices, multiple schedules, and source-specific coverage.
- Local collector prior-art research is now captured in `design-notes/local-collector-durable-work-substrate-2026-05-19.md`. The key conclusion is that the next tranche should promote a durable outbox/checkpoint/backlog substrate into OpenSpec before implementation, rather than adding more setup or queue patches.

## Current Risk

The main risk is fragmented partial abstractions:

- A local collector package without a clear connection model becomes a setup script, not architecture.
- A connection model that ignores Core grants risks leaking operational concepts into consent/disclosure semantics.
- A schedule model that only launches runs misses user-attention, notification, and source-readiness realities.
- A connector health UI that only reports success/failure misses partial coverage and false success.
- A remote surface that solves current ChatGPT/Chase runs but exposes PDPP-specific assumptions will not become a clean substrate.

## Promotion Trigger

Promote this note into OpenSpec before implementing any tranche that changes:

- connection or connector instance storage semantics
- owner-facing source/account/device UX
- local collector enrollment or package contract
- schedule/notification/control-plane behavior
- run coverage, gap, or health-state semantics
- Collection Profile runtime bindings or messages
- remote-surface package API

## Decision Log

- 2026-05-19: Captured full-context refresh after re-reading the PDPP Core spec, Collection Profile, architecture notes, DTI alignment, reviewer onboarding, and recent RI owner handoffs. Current conclusion: the project has enough component designs, but needs a synthesis artifact before major implementation that maps connection/device/run/schedule/coverage to Core vs Collection Profile vs reference-only semantics.
- 2026-05-19: Linked the local collector durable work substrate research note. Current conclusion: large local backfills and stuck queues should be addressed through a promoted OpenSpec change for durable outbox, checkpoint, backlog, service lifecycle, and dashboard health semantics.
- 2026-06-01: Long RI-owner batches should use fewer, larger ABD lanes. The expensive part was not code volume; it was repeated worktree setup, report review, branch acceptance, validation routing, and cleanup. Prefer macro-lanes with self-contained acceptance packets, explicit no-human validation, and one owner merge pass over many small lanes that each rediscover context.
- 2026-06-01: Every delegated lane needs a cleanup contract at launch time. The packet should say whether the branch is expected to be merged, archived as evidence, or removed when patch-equivalent. After acceptance, run a cleanup pass that preserves dirty worktrees, active tmux sessions, and branches with unique commits; removes only merged or patch-equivalent branches; and records a manifest before deletion.
- 2026-06-01: Agent-facing surfaces should default to token-efficient discovery. If a compact schema or summary view exists, skill docs, MCP tool descriptions, and CLI guidance should teach agents to start there and opt into full schema only for deep inspection or backcompat.
- 2026-06-01: Reference heuristics are acceptable only when they are warning-only and visible. Any threshold that can block, grant, delete, compact, or hide data needs an explicit rationale, an owner-visible override or dry-run path, and a promotion path into OpenSpec if it becomes durable behavior.
- 2026-06-01: Prior-art research needs a durable corpus separate from design notes. Chat summaries and worker reports are not enough when research informs OpenSpec or implementation work; preserve a citeable research artifact under `docs/research/` or change-local `research/`, while design notes remain the queue for significant observations, open questions, and slow architecture review.
- 2026-06-01: Agent-facing usability must be validated as complete model-visible journeys, not inferred from individual tool payloads. For MCP and similar surfaces, add regression tests that consume only what the model can see (`content[]` text, not hidden structured payloads), extract the next handle, and complete the intended workflow.
- 2026-06-01: Human retest requests for public-reference fixes should be gated on live deployment evidence, not repository state. Before sending Simon/Claude/owner testers back through a flow, check the served `PDPP-Reference-Revision` or equivalent runtime signal and run one focused live probe against the fixed surface. A pushed commit or passing CI image build is not enough when the public instance may still be serving an older image.
