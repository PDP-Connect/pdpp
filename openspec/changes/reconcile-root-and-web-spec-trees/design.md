# Design: Reconcile Root And Web Spec Trees

## Context

PDPP ships two trees of the same specs. The root `spec-*.md` files are what an implementer reads when forking the repository. The `apps/web/content/docs/spec-*.md` files are what an implementer (or LLM) reads on the public site. These are not the same content today, and the only thing keeping them aligned is human attention.

Bug-hunt v2 (`worktree-bughunt2-docs-spec-drift`) catalogued the drift: missing sections, missing status banners, normative-flavored extensions that exist only on the public site, and stale "superseded" warnings the public reader never sees. Commit `464e314` fixed the most visible mislabel (`spec-data-query-api` and the well-known/skills route family) but did not address the systemic drift driver: independent edits.

This change is a design/process intervention. It commits to a canonical-source strategy, names the publication contract, and demands a mechanical drift gate. It deliberately does not reconcile the corpus in the same change because (a) the reconciliation requires content judgement on every diverged section and (b) shipping the gate first means the reconciliation work has a passing target to converge on.

## Goals

1. There is one source-of-truth file per spec that has both a root and a web copy.
2. A future drift between the two trees fails CI / pre-commit, not a future bug-hunt.
3. The README's authority order matches what the gate enforces.
4. Web-only opt-in extension specs (lexical/semantic retrieval today) have an explicit, named home — they are not an unstated exception.
5. A public reader sees the same `Status:` / `Date:` posture as a forking implementer.

## Non-Goals

- Resolving every line-level diff between the current root and web copies. That is a follow-up implementation change.
- Designing or implementing `pnpm spec:sync` (a generator that rebuilds web copies from root sources). The detection gate is enough to enforce the invariant; the generator is a convenience that can land later.
- Adopting a third-party docs framework or moving the public site off Fumadocs.
- Changing the normative content of any spec.
- Touching the `well-known/skills` route family. That is a separate cleanup tracked elsewhere.

## Decision: Canonical Source

**Root `spec-*.md` files are canonical for every spec that has both a root and a web copy.**

Reasons:

- The README already declares this authority order. Reversing it would invalidate the README, the existing `reference-implementation-governance` capability, and the implicit contract with anyone who has already forked the substrate.
- The reference implementation, OpenSpec specs, and contract-generation tooling all live next to the root files. A forker who clones the repository should not have to start the web app to read normative protocol text.
- Root files carry `Status:` and `Date:` headers; web files use Fumadocs frontmatter. The root format is closer to a portable normative document; the web format is closer to a presentation layer. It is easier to project root → web than the reverse.
- LLM-facing surfaces (`llms.txt`, `llms-full.txt`) currently pull from the web tree; once the web tree is a derived copy, those surfaces inherit the normative content automatically.

Implication: any drift between a canonical root spec and its web copy is a defect in the web copy. The web copy is the publication artifact; the root file is the source.

## Decision: Web-Only Extension Specs

`spec-lexical-retrieval-extension` and `spec-semantic-retrieval-extension` exist only under `apps/web/content/docs/`. They contain normative-flavored language ("MUST advertise", "MUST NOT assume it exists") but are explicitly opt-in extensions that core does not require.

Two options were considered:

1. **Force every extension spec to have a root file.** Mechanically uniform, but it overstates the canonical authority of optional extensions and forces forkers who do not opt in to still read the file.
2. **Codify a small allowlist of web-only extension specs.** The allowlist is short (two entries today), explicit, and visible in the spec delta. Anyone proposing a third extension must add to the allowlist via OpenSpec, which is the right level of friction.

Option 2 wins. The allowlist is named in the spec delta below, not in code. The `pnpm spec:check` gate skips files that match the allowlist instead of demanding a root counterpart for them.

## Decision: Publication Contract (Status / Date Parity)

Web copies of canonical-root specs MUST surface the root `Status:` and `Date:` lines in a form a public reader can see. Fumadocs has a `<Callout>` primitive already used by the `spec-data-query-api` web copy after `464e314`. The same pattern applies to every web copy of a canonical-root spec.

Concretely: the first non-frontmatter element of any web copy of a canonical-root spec MUST be a Fumadocs callout (or equivalent fixed prefix) that contains the root's `Status:` and `Date:` text. The drift-check normalises this prefix when comparing bodies, so adding/removing the callout is not itself drift; missing the callout is a separate parity violation.

## Decision: Drift-Check Mechanism

The first implementation slice ships a `pnpm spec:check` script that:

1. Reads every `spec-*.md` at the repo root.
2. For each, locates the corresponding `apps/web/content/docs/<basename>.md`.
3. Strips the web copy's frontmatter and the leading Status/Date callout.
4. Strips the root's `Status:` / `Date:` header lines.
5. Normalises both for the trivial differences that are publication-format-only (e.g., heading level for the document title).
6. Compares the remaining body bytes. Any mismatch fails with a contextual diff.
7. Skips the named web-only-extension allowlist.
8. Reports root specs that have no web counterpart and web specs that have no root counterpart, distinguishing the allowlist case.

Where this gate runs:

- Local: a `lefthook` pre-commit hook calls `pnpm spec:check` whenever `spec-*.md` or `apps/web/content/docs/spec-*.md` is staged.
- CI: the same script runs in the existing web/types-check job (or a new `spec-check` job; implementation-time decision).

Both are deferred to the implementation change. This change only codifies the requirement.

## Alternatives Considered

- **Make web canonical, delete root.** Rejected. Forces a documentation framework dependency on every forker, contradicts the README, and orphans `pnpm reference-contract:check-generated` which assumes root invariants.
- **Generate web from root automatically (commit-time generator).** Possible long-term, but a generator without a check is a maintenance trap; a check without a generator already prevents drift. Land the check first, decide on a generator later when the corpus is reconciled.
- **Leave both trees as parallel sources and rely on review discipline.** This is the status quo; it is what produced the current drift. Rejected.
- **Promote the web copies into OpenSpec and leave root files as historical artifacts.** Rejected — OpenSpec is project-scoped and would compete with the protocol authority order, exactly what `reference-implementation-governance` already prohibits.

## Acceptance Checks

These belong in the implementation change's `tasks.md`, but to make this change auditable:

- A `pnpm spec:check` script exists and exits non-zero when a root canonical spec disagrees with its web copy in the body content.
- The script exits non-zero when a root canonical spec exists with no web counterpart (or vice versa, outside the allowlist).
- The script exits zero on a clean tree once the corpus has been reconciled.
- A pre-commit hook or CI step runs the script on relevant changes.
- The README's Authority order section either references this capability or remains semantically consistent with it.
- The Fumadocs callout pattern is documented somewhere a contributor adding a new spec can find it (e.g., a short note in `apps/web/content/docs/`).

The actual reconciliation of the existing root↔web corpus is also deferred to the implementation change. The implementation change should land the gate, then make the corpus pass it.

## Open Questions

- Should the gate also enforce a content hash in `spec-*.md` (root) so a web copy can declare which root revision it was published from? Useful for a future generator; not required for the first slice. Defer.
- Should we strip Markdown anchor IDs (`{#introduction}` style) before comparison? Probably yes, since the web Fumadocs build may add or strip these. Implementation-time call.
- Does `spec-reference-implementation-examples.md` need a web counterpart? The bug-hunt flagged this. It is in scope of "every root spec has a web copy unless allowlisted", so the implementation change must either add a web copy or remove the root file or allowlist it as root-only-reference. Decision deferred to implementation.
