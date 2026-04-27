# Reconcile Root And Web Spec Trees

## Why

The repository keeps two parallel copies of every PDPP spec: the root `spec-*.md` files and the public docs copies under `apps/web/content/docs/spec-*.md`. They have diverged because each is hand-edited.

Concrete drift observed in the `worktree-bughunt2-docs-spec-drift` audit:

- `spec-core.md` and `apps/web/content/docs/spec-core.md` differ by ~439 diff lines, including normative-flavored AI-training consent text the public site is missing.
- `spec-deferred.md` carries three sections ("Active Erasure Signal", "Re-Interaction / Session Refresh", "Request-Side Freshness Requirements") that the web copy never shows.
- Every root spec carries `Status:` and `Date:` headers; every web copy strips them.
- `spec-data-query-api` shipped with a "Superseded" banner missing from the web copy until commit `464e314` patched the public mislabel by hand.
- `spec-lexical-retrieval-extension` and `spec-semantic-retrieval-extension` exist only as web copies, contradicting the README authority statement that root specs define normative semantics.
- `spec-reference-implementation-examples.md` exists only at the root and is absent from the web nav.

The README still asserts a strict authority order ("Root PDPP specs define normative protocol semantics"), but in practice the public site is what most readers consume, and there is no mechanical guard preventing the two trees from drifting again. Manual fixes (like `464e314`) are necessary but not sufficient.

This change picks a canonical-source strategy, captures it in `reference-implementation-governance`, and lays out a first implementation slice that catches drift mechanically without rewriting the spec corpus in the same lane.

## What Changes

- Declare the **root `spec-*.md` files canonical** for any spec that exists at both the root and under the web docs tree, consistent with the README authority order. Web copies are derived publication artifacts, not parallel sources.
- Recognize that some specs are intentionally **web-only opt-in extensions** (`spec-lexical-retrieval-extension`, `spec-semantic-retrieval-extension`) and codify a single rule for handling them: a web-only extension spec is allowed only if it is explicitly listed as such in this capability and is opt-in (not depended on by core).
- Require a `pnpm spec:check` script and a corresponding lefthook/CI gate that fails when any root `spec-*.md` listed as canonical drifts from its `apps/web/content/docs/<same-name>.md` counterpart in the parts that must match (body content normalised for the web's frontmatter and Status/Date callouts).
- Require the web copy of a canonical-root spec to surface the root's `Status:` and `Date:` (e.g. via a Fumadocs callout) so a public reader sees the same normative posture a forking implementer sees.
- Require any new spec proposal to declare its canonical home (`root`, `web-only-extension`, or `reference-only`) in `proposal.md`, so the gate knows where to look.
- Defer the actual content reconciliation (line-level merge of the diverged copies) and the `pnpm spec:sync` generator to a follow-up implementation change. This change is governance + a first detection slice only.

## Capabilities

### Modified

- `reference-implementation-governance` — adds requirements covering canonical source-of-truth for root vs web spec copies, the publication contract (Status/Date parity), the web-only-extension allowlist, and the drift-check gate.

### Added

None.

### Removed

None.

## Impact

- **Affected docs:** `README.md` Authority order (clarification only — no semantic change), eventual `apps/web/content/docs/spec-*.md` rebuild step (deferred).
- **Affected code:** new `pnpm spec:check` script (deferred to implementation change). No runtime behavior changes.
- **Affected processes:** worker task packets that touch `spec-*.md` must run `pnpm spec:check` as part of their validation matrix once it lands.
- **Risk:** if the canonical decision is later reversed (web becomes canonical), the requirements here would need to be modified. The decision is reversible and contained to one capability.
- **Migration:** none for this change. The follow-up implementation change will handle the one-time content reconciliation and either commit a generator or commit the regenerated web copies.
