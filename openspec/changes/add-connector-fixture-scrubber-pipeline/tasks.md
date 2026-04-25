## 1. Policy

- [x] Document raw and scrubbed fixture directory conventions.
- [x] Ensure raw fixture directories are ignored.
- [x] Define review criteria for committing scrubbed fixtures.

## 2. Scrubber

- [x] Extend the existing regex scrubber for common emails, phones, cards, account numbers, addresses, and names where deterministic patterns are reliable.
- [x] Add connector-specific scrub-rule entry points.
- [x] Add an LLM-assisted redaction mode for free-form text, with structured output and conservative failure behavior.
- [x] Add tests proving secrets are redacted and structure is preserved on representative fixtures.

## 3. Connector Adoption

- [x] Pilot on one browser connector and one API/local-file connector.
- [x] Convert at least one brittle synthetic parser test to use a scrubbed real-shape fixture.
- [x] Document how future workers capture, scrub, review, and commit fixtures.

## 4. Validation

- [x] Run connector parser tests affected by the pilot fixtures.
- [x] Run `pnpm --dir packages/polyfill-connectors run verify`.
- [x] Run `openspec validate add-connector-fixture-scrubber-pipeline --strict`.
- [x] Run `openspec validate --all --strict`.
