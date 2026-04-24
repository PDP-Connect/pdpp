## Context

The current PDPP reference has crossed the threshold where it is believable as a forkable substrate, but several edges still create avoidable ambiguity:

- `apps/web` still contains a legacy demo bridge that assumes connector-first grant requests and query flows.
- The native-provider path is materially better than before, but it still sits on top of connector-shaped storage and can regress if the public contract is not explicitly protected.
- We have an OpenSpec governance spec now, but the active execution work is still scattered across inbox memos.

This change is project-scoped. Normative PDPP semantics remain in the root protocol specs, especially `spec-core.md`, `spec-auth-design.md`, and `spec-collection-profile.md`; this design only describes how the reference implementation should stay aligned with them.

The goal of this tranche is not to widen the provider-connect profile. It is to keep the existing reference honest while making the project easier to steer autonomously.

## Goals / Non-Goals

**Goals:**
- Make the web bridge source-aware and aligned with the current `reference-implementation` contract.
- Preserve a provider/source-first native public contract even while connector-shaped storage remains internal.
- Use CLI/tests as the primary truth-serum for the public/reference contract.
- Move active planning for this work into OpenSpec.

**Non-Goals:**
- Building a control plane or dashboard.
- Expanding the provider-connect profile beyond the currently supported PAR + consent flow.
- Renaming or modernizing every historical legacy demo artifact in one pass.
- Replacing SQLite or introducing a generalized remote persistence layer.

## Decisions

### Decision: Treat `apps/web` bridge routes as reference consumers, not contract shapers
The bridge routes in `apps/web` should consume the real AS/RS surfaces and remain explicit about their legacy/demo role where applicable.

Alternatives considered:
- Keep the bridges loosely aligned and rely on comments alone.
  - Rejected because that allows drift to remain load-bearing.
- Remove the bridge layer entirely now.
  - Rejected because the legacy demo still uses it and we do not need that larger deletion to improve truthfulness immediately.

### Decision: Keep the native public contract provider/source-first while leaving connector-shaped storage internal
The native path should continue to speak in terms of `provider_id` and `source`, while internal storage remains connector-keyed only through structured `storage_binding` details rather than a separate scalar native storage field.

Alternatives considered:
- Rename every connector-shaped internal column and table now.
  - Rejected as premature and higher risk than needed for public-contract honesty.
- Leave the public/native boundary informal.
  - Rejected because it invites regression and makes the reference less forkable.

### Decision: OpenSpec replaces new inbox memos for active execution planning
The new governance spec is only useful if current work actually moves into OpenSpec changes instead of continuing to accumulate temporary planning files.

Alternatives considered:
- Keep using inbox memos alongside OpenSpec.
  - Rejected because that recreates the duplicate-truth problem OpenSpec was meant to solve.

## Risks / Trade-offs

- [Legacy demo remains present] → Keep the bridge changes small and explicit; improve truthfulness without turning this tranche into a full demo rewrite.
- [Native/public boundary still sits on connector-shaped internals] → Protect the public contract with black-box tests and avoid exposing storage identifiers.
- [OpenSpec change drifts from code] → Use concrete tasks tied to code/test surfaces and update task state as implementation lands.
