## 1. Manifest Semantics

- [x] Audit supported connector manifests for readable natural-language fields missing `query.search`.
- [x] Add missing lexical and semantic declarations for owner-visible natural-language fields.
- [x] Add `x_pdpp_role` declarations across supported connector streams.
- [x] Add manifest-honesty tests for search affordance coverage and role coverage.

## 2. Schema Projection

- [x] Project `schema.properties[field].x_pdpp_role` into reference `field_capabilities[field].role`.
- [x] Preserve role flags in compact schema output.
- [x] Preserve role flags in MCP schema compaction.
- [x] Update focused compact formatter tests.

## 3. Authoring Guidance

- [x] Add prior-art research to the corpus.
- [x] Add or update the connector authoring guide with a short checklist, examples, and anti-patterns.
- [x] Link the guide from the relevant contributor entry point.

## 4. Validation

- [x] Run new manifest-honesty tests.
- [x] Run polyfill connector typecheck.
- [x] Run existing manifest-honesty tests.
- [ ] Run package-level polyfill connector tests with dependencies installed. Full suite currently reaches unrelated iMessage harness failure.
- [x] Run MCP schema-token tests with package dependencies installed.
- [x] Run MCP server test suite.
- [x] Run reference implementation typecheck.
- [x] Run direct reference compact field formatter check.
- [x] Run `openspec validate complete-connector-semantic-affordances --strict`.
- [x] Run `git diff --check`.
