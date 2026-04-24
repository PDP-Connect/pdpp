# AGENTS.md

This repo is spec-driven. When an agent is asked to design, plan, refactor, or introduce a non-trivial feature, write it as an OpenSpec change *before* writing code, and keep the two in lockstep afterward.

If you are doing a trivial fix (typo, one-line bug, test tweak, comment), skip OpenSpec. Everything else: use it.

Read `openspec/README.md` before non-trivial planning work. It is the local rulebook for OpenSpec lifecycle, closeout, and the design-note intake lane.

## When OpenSpec applies

Write a change proposal when any of these are true:

- You are introducing a new capability, new dependency, or new architectural boundary.
- You are changing a durable contract (schemas, wire formats, endpoints, grant shapes, manifest fields).
- You are modifying behavior that a reviewer (standards body, engineer forking this repo, a future you) should be able to audit after the fact.
- The user asks you to "write it up," "propose," "plan," "design," or "spec it out."

If none of the above apply, just do the work.

## Where things live

```
openspec/
  specs/                            # durable capability specs (merged truth)
    <capability>/spec.md
  changes/                          # in-flight proposals
    <change-name>/
      proposal.md                   # why + what changes + impact
      design.md                     # design rationale (optional but expected for non-trivial changes)
      tasks.md                      # numbered, checkboxed task list
      specs/<capability>/spec.md    # spec delta: ADDED / MODIFIED / REMOVED Requirements
      design-notes/                 # optional non-canonical notes tightly scoped to the change
design-notes/                       # cross-cutting non-canonical question intake
```

Capability names mirror existing folders under `openspec/specs/`. Prefer updating an existing capability over minting a new one.

## Shape of a change

- **`proposal.md`** — short. `## Why`, `## What Changes`, `## Capabilities` (Modified / Added / Removed), `## Impact`. No novel prose; state the facts.
- **`design.md`** — rationale, alternatives considered, what is and isn't in scope, acceptance checks. This is where you *show* the thinking; it's how reviewers evaluate the decision without reading every line of code.
- **`tasks.md`** — numbered sections, checkbox items. Each checkbox is small enough to do in one commit. Include an "Acceptance checks" section with reproducible steps.
- **`specs/<capability>/spec.md`** — the capability-spec **delta**. Use `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`. Every Requirement needs at least one `#### Scenario:` with `**WHEN** / **THEN**` phrasing. Follow the shape already present in `openspec/specs/reference-implementation-architecture/spec.md`. **Do not put task lists in spec files.**

## Validating

Always run before handing back:

```
openspec validate <change-name> --strict
```

A valid change is the minimum bar. An invalid change is not ready for review.

## Archiving

When a change is fully implemented and accepted, the Requirement deltas in `changes/<name>/specs/<cap>/spec.md` get folded into `specs/<cap>/spec.md` and the change folder moves to `openspec/changes/archive/`. Don't archive work yourself unless the user asks.

## Small things

- Terse proposals beat padded ones. Look at `openspec/changes/reference-implementation-program/proposal.md` for tone.
- Requirements are normative (`SHALL`, `SHALL NOT`). Scenarios are evidence.
- If you change the protocol or a durable contract, update `openspec/specs/<capability>/spec.md` via a proper delta. Drive-by edits to that file are not OK.
- If you are proposing multiple loosely related things, split them into separate changes rather than fattening one proposal.

## Design notes

Design notes are not official OpenSpec artifacts. Use them for requirements discovery: questions, research, options, and decisions that should not be forgotten but are not yet approved changes.

- Use `design-notes/` for cross-cutting intake and `openspec/changes/<change>/design-notes/` for notes local to one active change.
- Start new notes with the header template in `design-notes/README.md`.
- Promote the note into OpenSpec before implementation when the answer changes a protocol surface, reference contract, architecture boundary, security posture, storage model, user-facing behavior, or multi-step implementation tranche.
- When a note is decided, mark it decided/deferred/superseded and link to the artifact that absorbed it.

## If you are unsure

Ask the user whether this is a change-worthy piece of work before you invent scope. "I'd draft this as an OpenSpec change `add-X` — yes?" is a one-line question and saves a rewrite.
