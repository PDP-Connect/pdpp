# OpenSpec Usage

This repository uses OpenSpec as the durable planning and change-control layer for non-trivial project work.

OpenSpec is not the normative PDPP protocol spec. The root PDPP spec files remain authoritative for protocol semantics. Code and tests remain authoritative for current reference behavior. OpenSpec explains intended project changes, architecture boundaries, and reference-implementation decisions.

## Official Artifacts

Official OpenSpec artifacts are:

- `openspec/specs/**/spec.md` — canonical current capability specs.
- `openspec/changes/<change>/proposal.md` — why and what.
- `openspec/changes/<change>/design.md` — rationale, alternatives, tradeoffs, acceptance checks.
- `openspec/changes/<change>/tasks.md` — implementation checklist and validation.
- `openspec/changes/<change>/specs/**/spec.md` — requirement deltas.

Everything else is supplemental.

## Lifecycle

Use this flow for non-trivial durable work:

1. Create or update an OpenSpec change before implementation.
2. Validate the change with `openspec validate <change> --strict`.
3. Implement against `tasks.md`, updating artifacts when facts change.
4. Mark tasks honestly as work lands.
5. Verify the implementation.
6. Archive accepted changes so `openspec/specs/` becomes the current source of truth.

If a change is superseded or intentionally parked, say so in the change. Do not leave active changes ambiguous.

## Quality Bar

Specs use normative language and scenarios. Proposals stay short. Designs explain tradeoffs. Tasks are executable and verifiable. Open questions do not belong in spec files unless the requirement is explicitly to keep the question visible.

Before handing off OpenSpec-backed work, run:

```sh
openspec validate <change> --strict
openspec validate --all --strict
```

## Design Notes

Design notes are requirements-discovery artifacts, not official OpenSpec artifacts. Use them when an idea or unresolved question is important enough to preserve but not yet ready to become a proposed change.

Use `design-notes/` for cross-cutting intake. Use `openspec/changes/<change>/design-notes/` only for notes tightly scoped to that active change.

Promote a design note into OpenSpec when the decision would change a protocol surface, reference contract, architecture boundary, security posture, storage model, user-facing behavior, or multi-step implementation tranche.

## Closeout Checklist

For every completed tranche:

- The implementation and tests match the OpenSpec artifacts.
- `tasks.md` is checked or explicitly defers remaining work.
- Any learned discrepancy is folded back into `design.md` or the spec delta.
- Design notes are marked decided, deferred, superseded, or promoted.
- The change is archived when accepted.
