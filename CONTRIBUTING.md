# Contributing to PDPP

Thanks for your interest in PDPP. This project is a protocol plus a forkable
reference implementation, so contributions range from protocol-text edits to
reference-implementation code, connectors, docs, and the public site.

This guide applies to human and AI contributors alike. It distills the durable
conventions for working in this repo: the spec-first workflow for protocol and
contract changes, test expectations, and pull-request conventions.

## Ground rules

- **No personal data in the repo.** Do not commit private names, personal
  handles, private absolute paths, or third-party personal references in docs,
  code, fixtures, or reports. Use role-neutral labels (`the owner`, `an
  operator`, `your-pdpp-host.example.com`) unless a real value is explicitly
  approved.
- **Respect the authority order.** This repo has a strict authority order:
  1. Root PDPP specs (`spec-*.md`) define normative protocol semantics.
  2. Code and tests define what the current reference implementation actually
     does.
  3. OpenSpec (`openspec/`) defines project-level architecture and change
     planning.

  Public web spec pages are downstream copies of the root specs; `pnpm
  spec:check` enforces parity. OpenSpec is project-scoped and does not replace
  or compete with the normative PDPP specs.
- **Mind the voice.** Before writing or editing prose in any spec, design note,
  README, site copy, operator/dashboard string, or release note, read
  [`docs/reference/voice-and-framing.md`](docs/reference/voice-and-framing.md). It keeps
  PDPP-as-protocol above OAuth/RAR, separates Core from Collection Profile from
  reference implementation from operator console, and lists phrasings to avoid.

## AI assistance

Building with AI is welcome. If AI helped meaningfully, add an `Assisted-by: AI`
trailer to the commit so reviewers can calibrate their scrutiny; a local hook can
add it for you (`.github/hooks/prepare-commit-msg`). It is vendor-neutral and sits
alongside your DCO sign-off. We review contributions on whether they are good, not
how they were made.

## Spec-first workflow (OpenSpec)

This repo is spec-driven. When you are asked to design, plan, refactor, or
introduce a non-trivial feature, write it as an OpenSpec change **before**
writing code, and keep the two in lockstep afterward.

Read [`openspec/README.md`](openspec/README.md) before non-trivial planning
work — it is the local rulebook for the OpenSpec lifecycle, closeout, and the
design-note intake lane.

### When OpenSpec applies

Write a change proposal when any of these are true:

- You are introducing a new capability, new dependency, or new architectural
  boundary.
- You are changing a durable contract (schemas, wire formats, endpoints, grant
  shapes, manifest fields).
- You are modifying behavior a reviewer (standards body, a forker, a future
  you) should be able to audit after the fact.
- The request asks you to "write it up," "propose," "plan," "design," or "spec
  it out."

In one line: **OpenSpec is for design and contract decisions** — the choices a
future reviewer, forker, or standards body must be able to audit.

Do **not** open a change for work that carries no durable design decision:

- Typos, comment edits, formatting, or a one-line bug fix.
- A localized refactor or test tweak that preserves behavior and touches no
  contract.
- Dependency bumps, lockfile churn, or CI/tooling config with no protocol
  impact.
- Anything you could describe as "just fix it" without needing to explain a
  tradeoff.

For those, skip OpenSpec and just do the work — a stray proposal for a minor fix
is noise that dilutes the changes that actually record a decision.

### Shape of a change

Changes live under `openspec/changes/<change-name>/`:

- **`proposal.md`** — short. `## Why`, `## What Changes`, `## Capabilities`
  (Modified / Added / Removed), `## Impact`. State facts, no novel prose.
- **`design.md`** — rationale, alternatives considered, what is and isn't in
  scope, acceptance checks. This is where you *show* the thinking.
- **`tasks.md`** — numbered sections with checkbox items, each small enough for
  one commit. Include an "Acceptance checks" section with reproducible steps.
- **`specs/<capability>/spec.md`** — the capability-spec **delta**, using
  `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED
  Requirements`. Every Requirement needs at least one `#### Scenario:` with
  `**WHEN** / **THEN**` phrasing. Requirements are normative (`SHALL`, `SHALL
  NOT`); scenarios are evidence. Do not put task lists in spec files.

Capability names mirror existing folders under `openspec/specs/`. Prefer
updating an existing capability over minting a new one. If you are proposing
multiple loosely related things, split them into separate changes.

### Validating a change

Always run before handing back:

```bash
openspec validate <change-name> --strict
```

A valid change is the minimum bar; an invalid change is not ready for review.

### Changing the protocol

If you change the protocol or a durable contract, update
`openspec/specs/<capability>/spec.md` via a proper delta. Drive-by edits to
capability spec files are not OK. When a change is fully implemented and
accepted, its Requirement deltas fold into the durable `specs/<cap>/spec.md`
and the change folder moves to `openspec/changes/archive/` — don't archive
work yourself unless asked.

### Closeout, and where post-merge steps live

A change's `tasks.md` is for **implementation** work a contributor can finish
and tick as it lands — code, tests, spec deltas. It is **not** an issue tracker.
Post-merge steps that are not part of the change's implementation — a live
production deploy, an acceptance pass, a migration to run against real data — do
**not** belong as open checkboxes in `tasks.md`. Those boxes rarely get ticked
(they depend on a deployment, not the merge), so they leave the change
pseudo-active forever and the folder rots. Record such residual work in the
**issue tracker** and, per `openspec/README.md`'s closeout checklist, note it as
a residual risk in the change — then let the change be archived. A `✓ Complete`
change should not stay active more than one merge cycle just because a live
follow-up step is outstanding.

To catch changes that have effectively landed but are still sitting active, run:

```bash
pnpm openspec:archive-check
```

It lists changes under `openspec/changes/` that look archive-due — all
implementation tasks done, or the code they reference already exists on `main`.
It's a **non-blocking reminder** (also wired as a pre-push warning and a
report-only CI job), not a gate: folding a change's spec deltas into
`openspec/specs/` and archiving it is a maintainer step, so the check never
fails a build or a push.

## Building and testing

Install dependencies with `pnpm install` from the repo root (this is a pnpm
workspace).

Common commands:

```bash
pnpm dev                              # reference AS/RS + operator console
pnpm reference-implementation:server  # reference server only
pnpm reference-implementation:cli --help
pnpm reference-implementation:test    # reference implementation tests
pnpm spec:check                       # root-spec / web-spec parity
```

See the [self-host quickstart](docs/operator/selfhost-quickstart.md) and the
[reference implementation README](reference-implementation/README.md) for the
full local, Docker, and connector workflows.

Test expectations:

- The reference implementation is validated with black-box, integration, and
  conformance-style tests. New behavior should come with tests that exercise
  the observable contract, not just internal helpers.
- Some conformance proofs are env-gated (for example the Postgres runtime and
  scheduler proofs). Run the relevant gated tests when you touch the code they
  cover; the README documents how to bring up the profile-gated Postgres
  service and run those proofs.
- Prefer captured fixtures over live credential/probe cycles when reproducing
  connector behavior.

## Pull request conventions

- **Branch and PR.** All changes to protocol text, the reference
  implementation, and the site go through public pull requests. Non-trivial
  protocol, reference-contract, or architecture changes are tracked with an
  OpenSpec change before implementation.
- **Conventional Commits.** Commit messages follow
  [Conventional Commits](https://www.conventionalcommits.org/). `fix:` creates
  a patch release and `feat:` creates a minor release; commits that do not
  follow the format do not release. Breaking-change markers are reserved for
  the intentional 1.0 milestone. See
  [`docs/reference/package-release-policy.md`](docs/reference/package-release-policy.md).
- **Keep specs and code in lockstep.** If your PR implements an OpenSpec
  change, the change artifacts and the code should land together and stay
  consistent.
- **CI and merge gate.** Every pull request must pass the CI checks before it
  can merge. Run the reference-implementation tests and `pnpm spec:check`
  locally before pushing so CI is a confirmation, not a surprise.

## Developer Certificate of Origin (DCO)

Contributions to this project require a **Developer Certificate of Origin**
sign-off. The DCO is a lightweight statement that you wrote the contribution or
otherwise have the right to submit it under the project's licenses. It is *not*
a copyright assignment. The full text is at
[developercertificate.org](https://developercertificate.org/).

To sign off, add a `Signed-off-by` trailer to each commit message with your real
name and email:

```
Signed-off-by: Jane Doe <jane.doe@example.com>
```

Git adds this automatically when you commit with the `-s` flag:

```bash
git commit -s -m "feat: add the thing"
```

The name and email in the sign-off must match the commit author. By signing off,
you certify the statements in the DCO for that contribution. Pull requests whose
commits are not signed off will be asked to add the sign-off before merge (you
can amend existing commits with `git rebase --signoff <base>`).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it. Report unacceptable behavior through the
private channel described in [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Governance

Maintainers and their scopes are listed in [`MAINTAINERS.md`](MAINTAINERS.md).
For root protocol specifications, active maintainers act as editors for the
current draft. Maintainer changes are proposed through pull request. This
project is proposed to LFDT Labs as the lab **PDP-Connect**; see the
"Governance & stewardship" section of the [README](README.md) for the stewardship
model.

## If you are unsure

Ask whether a piece of work is change-worthy before inventing scope. "I'd draft
this as an OpenSpec change `add-X` — yes?" is a one-line question that saves a
rewrite.
