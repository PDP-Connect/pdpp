# AGENTS.md

This repo is spec-driven. When an agent is asked to design, plan, refactor, or introduce a non-trivial feature, write it as an OpenSpec change *before* writing code, and keep the two in lockstep afterward.

If you are doing a trivial fix (typo, one-line bug, test tweak, comment), skip OpenSpec. Everything else: use it.

Do not commit private names, personal handles, private absolute paths, or third-party personal references in docs, code, fixtures, or reports; use role-neutral labels unless explicitly approved.

Read `openspec/README.md` before non-trivial planning work. It is the local rulebook for OpenSpec lifecycle, closeout, and the design-note intake lane.

For multi-agent work, worker handoffs, or parallel implementation lanes, read
`docs/agent-workstream-playbook.md` before assigning or accepting work. It is
the local playbook for worktrees, task packets, validation, reporting, and owner
merge gates.

Before writing or editing prose in any spec, design note, README, site copy,
operator/dashboard string, or release note, read
`docs/voice-and-framing.md`. It is the durable voice/framing guide that keeps
PDPP-as-protocol above OAuth/RAR, separates Core from Collection Profile from
reference implementation from operator console, and lists phrasings to avoid
(hosted-service semantics, cybersecurity framing, owner-voice drift, unqualified
connector claims, Vana/DTI overreach).

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
docs/
  research/                         # evidence base: web research, prior-art, deep findings (cite, don't restate)
  positioning/                      # canonical "where does PDPP sit / why not just X" stances; see docs/positioning/README.md
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

If the only remaining open task on an otherwise implemented and accepted change is an owner-only live verification (for example a production smoke, physical-device check, or live-credential pilot), the owner may convert that task into a `Residual Risks` entry in `proposal.md` or `design.md` and archive the change. Preserve the verification commitment, but do not keep the change active indefinitely on a step only the owner can perform.

## Small things

- Terse proposals beat padded ones. Look at `openspec/changes/reference-implementation-program/proposal.md` for tone.
- Requirements are normative (`SHALL`, `SHALL NOT`). Scenarios are evidence.
- If you change the protocol or a durable contract, update `openspec/specs/<capability>/spec.md` via a proper delta. Drive-by edits to that file are not OK.
- If you are proposing multiple loosely related things, split them into separate changes rather than fattening one proposal.

## Token-efficient agent work

Use these only when they materially reduce repeated exploration or browser work:

- Start by reading the latest handoff/reverse-handoff docs, `git status --short`, and recent commits before re-discovering context.
- Prefer compact machine-readable inspection over dashboard/browser spelunking. For run evidence, use `pnpm exec pdpp run timeline <run-id> --format json`; when owner auth is enabled, supply `PDPP_OWNER_SESSION_COOKIE` without printing its value.
- Batch repo/context searches with `rg`, `ctx_batch_execute`, or small scripts that print only the answer. Do not paste large logs, fixtures, timelines, or generated files into the chat when a filtered summary will do.
- When delegation is explicitly in scope, use low-cost subagents for bounded data gathering or isolated implementation lanes. Give them exact read/write scope, ask for a concise report under `tmp/workstreams/`, and close/reuse agents rather than spawning redundant ones.
- Before asking for another human live run, exhaust existing timeline events, fixtures, telemetry, container logs, and local reproducible checks. A new run should either validate a concrete fix or capture specifically missing evidence.
- Commit verified tranches as you go, but never use broad restore/checkout commands over files with uncommitted user or worker edits.

## Positioning

`docs/positioning/` holds the settled answers to the recurring "where does PDPP sit / why not just X" questions (OAuth, DTI/DTP, durable grants, persistence/self-sovereignty, why-now). When answering a reviewer, investor, or standards body on one of these, draw from here rather than re-deriving — and update the relevant position if the analysis advances. Each position cites evidence in `docs/research/` and follows the format in `docs/positioning/README.md` (asked-as / short answer / why it's true / what we do NOT claim / status). Spec *gaps* a position surfaces belong in an OpenSpec change, not in the position file.

## Design notes

Design notes are not official OpenSpec artifacts. Use them for requirements discovery: questions, research, options, and decisions that should not be forgotten but are not yet approved changes.

- Use `design-notes/` for cross-cutting intake and `openspec/changes/<change>/design-notes/` for notes local to one active change.
- Start new notes with the header template in `design-notes/README.md`.
- Promote the note into OpenSpec before implementation when the answer changes a protocol surface, reference contract, architecture boundary, security posture, storage model, user-facing behavior, or multi-step implementation tranche.
- When a note is decided, mark it decided/deferred/superseded and link to the artifact that absorbed it.

## If you are unsure

Ask the user whether this is a change-worthy piece of work before you invent scope. "I'd draft this as an OpenSpec change `add-X` — yes?" is a one-line question and saves a rewrite.
