## Context

The official OpenSpec workflow is intentionally small:

- create a proposal that captures why and what
- add requirement deltas, design rationale, and tasks
- implement against those artifacts
- archive completed work so `openspec/specs/` becomes the current source of truth

That maps well to PDPP's needs, but it does not fully answer a separate owner workflow: during implementation, we discover high-stakes questions that are not yet ready to become a spec change. Those questions still need capture, triage, and closeout.

## Decision

Use OpenSpec for durable target-state changes. Use design notes for requirements discovery.

The split is:

- OpenSpec is for changes we are proposing to make, implementing, or preserving as durable capability knowledge.
- Design notes are for questions, research, options, and synthesis that may later become OpenSpec changes or root PDPP spec edits.
- Design notes never outrank OpenSpec specs, root PDPP specs, code, or executable tests.

## Local Extensions

This repository allows two non-official note locations:

- `openspec/changes/<change>/design-notes/` for notes tightly scoped to an active change.
- `design-notes/` for cross-cutting intake that is not yet owned by a specific OpenSpec change.

Both are explicitly supplemental. They are not official OpenSpec artifacts and should not be treated like requirement deltas.

## Lifecycle

Design-question lifecycle:

1. Capture the question in a note with status, owner, stakes, current leaning, and promotion trigger.
2. If the question controls a durable contract, architecture boundary, public behavior, or multi-step tranche, promote it into an OpenSpec change before implementation.
3. If the question changes normative PDPP behavior, update the root PDPP spec through the appropriate spec process and let OpenSpec reference it.
4. Once decided, either link to the OpenSpec/root-spec change that absorbed it or mark it deferred/superseded.

OpenSpec change lifecycle:

1. Active changes should be either proposed, in implementation, ready to archive, or explicitly parked.
2. Completed and accepted changes should be archived promptly so canonical specs do not lag.
3. Stale or superseded changes should not remain active without a status note explaining why.
4. `tasks.md` must reflect actual status before handoff.

## Quality Bar

Specs:

- normative language (`SHALL`, `SHALL NOT`, `MUST`, `MAY`)
- at least one scenario per requirement
- no task lists or implementation journals in spec files
- no duplication of root PDPP protocol semantics

Proposals:

- concise why/what/impact
- explicit scope and non-goals
- no speculative implementation diary

Designs:

- alternatives considered
- tradeoffs and failure modes
- acceptance checks that prove the important invariants

Tasks:

- small enough to implement and verify
- checked as work lands
- include reproducible validation steps

Design notes:

- one question or decision cluster per note
- status and owner up front
- clear promotion trigger
- decision log when the question changes state

## Non-Goals

- Moving all existing historical design notes in this change.
- Rewriting existing large program changes into smaller changes in this pass.
- Replacing OpenSpec with a separate planning system.
- Making design notes official OpenSpec artifacts.

## Audit Findings

As of this change, `openspec validate --all --strict` passes. The structural weakness is lifecycle hygiene, not parser validity:

- only two canonical specs exist, while many completed or partially-complete changes remain active
- `reference-implementation-program` is effectively complete except one broad deferred item
- `harden-reference-boundaries` and `rename-reference-implementation` are marked complete and should be archived or explicitly retained
- lexical and semantic retrieval have both proposal and implementation changes active, so their completion/archive state needs a dedicated follow-up audit
- polyfill connector notes contain valuable requirements discovery, but many open-question notes lack a uniform status/promotion lifecycle

This change establishes the rules for the follow-up audit; it does not perform the full triage.
