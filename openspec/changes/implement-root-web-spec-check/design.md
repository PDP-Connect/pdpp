## Context

`reconcile-root-and-web-spec-trees` made root `spec-*.md` files canonical for specs that also have public web copies. The implementation was deferred: the repo still lacks a gate that fails when the root and web docs drift.

The current web docs add publication wrappers: frontmatter, a public Status/Date callout, and sometimes a different heading level for the document title. The check must ignore those formatting differences while still catching body-content drift.

## Goals / Non-Goals

**Goals:**

- Add a deterministic `pnpm spec:check` command.
- Fail on root/web body drift, missing web counterparts, and unexpected web-only specs.
- Allow the two approved web-only extension specs.
- Wire the check into pre-commit and CI.
- Reconcile the existing corpus to a passing state.

**Non-Goals:**

- Do not change PDPP Core or Collection Profile semantics.
- Do not generate web docs automatically in this slice.
- Do not decide new web-only extension specs beyond the existing allowlist.

## Decisions

The script will live under repo tooling and run from the root via `pnpm spec:check`. Keeping it at the repo root lets it compare both root and web docs without coupling to the Next.js app build.

The comparison will normalize only publication-format differences: web frontmatter, leading Status/Date callout, root `Status:`/`Date:` header lines, the document-title heading level, and explicit Markdown anchor IDs. Anything else remains significant drift.

The web-only allowlist is embedded in the script as the current governance-approved set: `spec-lexical-retrieval-extension` and `spec-semantic-retrieval-extension`. Any new web-only file should fail until a future OpenSpec change extends the allowlist.

`spec-reference-implementation-examples.md` will be treated as `reference-only` in the script rather than published to the web tree. It is a repo-local implementer example surface, not a PDPP public spec.

## Risks / Trade-offs

- Normalization can hide too much if it becomes broad. Mitigation: keep normalization narrow and test by running against the reconciled corpus.
- CI/pre-commit cost grows with spec count. Mitigation: the corpus is small and the script uses synchronous local file reads only.
- Copying root text into web docs can accidentally lose web metadata. Mitigation: preserve frontmatter and Status/Date callouts while replacing only canonical body sections.
