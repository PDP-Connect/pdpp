# Tasks: Reconcile Root And Web Spec Trees

This change is governance only: it designs the canonical-source strategy, the publication contract, the web-only extension allowlist, and the drift-check requirement. It does NOT land the detection slice. Building `pnpm spec:check`, wiring it into lefthook/CI, and reconciling the corpus are all deferred to a follow-up implementation change so the gate lands first and the corpus has a passing target.

## 1. Validate the OpenSpec change

- [x] 1.1 Run `openspec validate reconcile-root-and-web-spec-trees --strict` — must pass.
- [x] 1.2 Run `openspec validate --all --strict` — must report 34 passed / 0 failed (33 prior + this one).

## 2. Land the drift-check gate (implementation change — deferred)

These tasks are listed here so the follow-up change has a starting checklist. They are not part of this proposal's acceptance bar; they belong to the next OpenSpec change (e.g., `implement-root-web-spec-check`).

- [ ] 2.1 Create `pnpm spec:check` script (new package or `apps/web` script) that compares each root `spec-*.md` against its web counterpart with normalised frontmatter / Status / Date / heading-level / anchor differences.
- [ ] 2.2 Wire the script into `lefthook` pre-commit on changes to `spec-*.md` or `apps/web/content/docs/spec-*.md`.
- [ ] 2.3 Wire the script into CI alongside the existing types-check / build steps.
- [ ] 2.4 Encode the web-only-extension allowlist (`spec-lexical-retrieval-extension`, `spec-semantic-retrieval-extension`) in the script.
- [ ] 2.5 Document the Status/Date callout pattern next to the docs corpus so contributors adding a new spec follow it without rediscovery.

## 3. Reconcile the existing corpus (implementation change — deferred)

- [ ] 3.1 Decide a fate for `spec-reference-implementation-examples.md` (root only today): add a web copy, remove the root file, or allowlist as `reference-only`.
- [ ] 3.2 Bring `apps/web/content/docs/spec-core.md` body content into parity with `spec-core.md`, including the AI-training consent text and the comparative-protocols-table phrasing flagged in the bug-hunt.
- [ ] 3.3 Restore the missing sections in `apps/web/content/docs/spec-deferred.md` ("Active Erasure Signal", "Re-Interaction / Session Refresh", "Request-Side Freshness Requirements") and the "Wildcard consent expansion" heading.
- [ ] 3.4 Add Status/Date callouts to every web copy of a canonical-root spec.
- [ ] 3.5 Re-run `pnpm spec:check` and confirm exit zero.

## 4. README and authority-order alignment

- [ ] 4.1 Update `README.md` Authority order section so it either cites this capability by name or, at minimum, names the web-only-extension allowlist concept so a forker is not surprised by `spec-lexical-retrieval-extension` and `spec-semantic-retrieval-extension`.
- [ ] 4.2 Confirm `openspec/specs/reference-implementation-governance/spec.md` (post-archive) reflects the new requirements.

## Acceptance checks (this change)

- `openspec validate reconcile-root-and-web-spec-trees --strict` passes.
- `openspec validate --all --strict` passes with one additional change validated.
- The proposal, design, tasks, and spec delta are committed together on `worktree-design-root-web-spec-sync`.
- The final report at `tmp/workstreams/worktree-design-root-web-spec-sync-report.md` names the change, the canonical strategy, the validation commands, and the deferred implementation work.
