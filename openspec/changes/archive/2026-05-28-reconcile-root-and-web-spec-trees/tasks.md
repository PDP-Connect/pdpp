# Tasks: Reconcile Root And Web Spec Trees

This change is governance only: it designs the canonical-source strategy, the publication contract, the web-only extension allowlist, and the drift-check requirement. It does NOT land the detection slice. Building `pnpm spec:check`, wiring it into lefthook/CI, and reconciling the corpus were deferred to the follow-up implementation change `implement-root-web-spec-check`.

## 1. Validate the OpenSpec change

- [x] 1.1 Run `openspec validate reconcile-root-and-web-spec-trees --strict` — must pass.
- [x] 1.2 Run `openspec validate --all --strict` — must pass.

## 2. Land the drift-check gate (implementation change — deferred)

These tasks are listed here so the follow-up change has a starting checklist. They are not part of this proposal's acceptance bar; they were implemented by `implement-root-web-spec-check`.

- [x] 2.1 Create `pnpm spec:check` script (new package or `apps/web` script) that compares each root `spec-*.md` against its web counterpart with normalised frontmatter / Status / Date / heading-level / anchor differences.
- [x] 2.2 Wire the script into `lefthook` pre-commit on changes to `spec-*.md` or `apps/web/content/docs/spec-*.md`.
- [x] 2.3 Wire the script into CI alongside the existing types-check / build steps.
- [x] 2.4 Encode the web-only-extension allowlist (`spec-lexical-retrieval-extension`, `spec-semantic-retrieval-extension`) in the script.
- [x] 2.5 Document the Status/Date callout pattern next to the docs corpus so contributors adding a new spec follow it without rediscovery.

## 3. Reconcile the existing corpus (implementation change — deferred)

- [x] 3.1 Decide a fate for `spec-reference-implementation-examples.md` (root only today): add a web copy, remove the root file, or allowlist as `reference-only`.
- [x] 3.2 Bring `apps/web/content/docs/spec-core.md` body content into parity with `spec-core.md`, including the AI-training consent text and the comparative-protocols-table phrasing flagged in the bug-hunt.
- [x] 3.3 Restore the missing sections in `apps/web/content/docs/spec-deferred.md` ("Active Erasure Signal", "Re-Interaction / Session Refresh", "Request-Side Freshness Requirements") and the "Wildcard consent expansion" heading.
- [x] 3.4 Add Status/Date callouts to every web copy of a canonical-root spec.
- [x] 3.5 Re-run `pnpm spec:check` and confirm exit zero.

## 4. README and authority-order alignment

- [x] 4.1 Update `README.md` Authority order section so it either cites this capability by name or, at minimum, names the web-only-extension allowlist concept so a forker is not surprised by `spec-lexical-retrieval-extension` and `spec-semantic-retrieval-extension`.
- [x] 4.2 Confirm the in-change `reference-implementation-governance` spec delta reflects the new requirements. Post-acceptance archive folding remains outside this change until the user asks to archive it.

## Acceptance checks (this change)

- `openspec validate reconcile-root-and-web-spec-trees --strict` passes.
- `openspec validate --all --strict` passes.
- The proposal, design, tasks, and spec delta are committed together.
- The follow-up implementation change `implement-root-web-spec-check` names the implemented gate, corpus reconciliation, and validation commands.
