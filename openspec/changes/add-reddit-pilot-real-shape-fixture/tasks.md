## 1. Capture

- [ ] Run the v0.2.0 Reddit connector with `PDPP_CAPTURE_FIXTURES=1` against the owner account; confirm all seven streams emit records.
- [ ] Verify the raw run lands under `fixtures/reddit/raw/<runId>/records/*.jsonl` and `http/*.json`.

## 2. Redaction plan

- [ ] For every raw `records/<stream>.jsonl`, author a `<path>.redactions.json` plan per the structured-redaction contract (version, redactions[], each with `text`, `replacement`, `reason`).
- [ ] Replacements MUST use `[REDACTED_*]` placeholders; no free-form substitutions.
- [ ] Cover free-form `title`, `body`, `selftext`, `url` (when personal), and identifying permalink slugs. Leave stable IDs (`t3_*`, `t1_*`) and non-identifying subreddit names alone.
- [ ] Review the plan for false negatives — every span a human reader would consider identifying MUST have a redaction entry.

## 3. Scrub

- [ ] Run `pnpm exec tsx bin/scrub-fixtures.ts reddit <runId> --llm-redactions-dir ./local-redactions/reddit`.
- [ ] Confirm the scrubber exits 0 with every raw file accounted for (fail-closed mode catches missing plans).
- [ ] Rename the output directory to `fixtures/reddit/scrubbed/pilot-real-shape/` (matching the Amazon/GitHub pilot convention).

## 4. Review

- [ ] Eyeball the scrubbed `records/*.jsonl` for residual PII. A reviewer other than the capture author SHOULD sign off.
- [ ] Confirm every record still parses as JSON and preserves record key + schema-critical fields (`id`, `created_utc`, `kind`, `subreddit` where non-identifying).
- [ ] If any residual PII is found, add a deterministic rule to `connectors/reddit/scrub-rules.ts` or extend the redaction plan; do not hand-edit scrubbed output.

## 5. Tests

- [ ] Extend `connectors/reddit/integration.test.ts` with a `pilot-real-shape` block that reads every committed `fixtures/reddit/scrubbed/pilot-real-shape/records/<stream>.jsonl` line and asserts `validateRecord(stream, row).ok === true`.
- [ ] Add a shape-drift guard: assert every emitted record in the pilot has `fetched_at`, `created_utc`, `id`, and the stream-specific required fields.

## 6. Documentation

- [ ] Update `packages/polyfill-connectors/docs/connector-authoring-guide.md` §9.1 to reference the Reddit pilot as the records-stream shape example (alongside Amazon=DOM, GitHub=API JSON).
- [ ] Add a one-line note in the Reddit `index.ts` CHANGES section that the pilot fixture exists and where it lives.

## 7. Validation

- [ ] Run `pnpm --dir packages/polyfill-connectors run verify`.
- [ ] Run `pnpm --dir packages/polyfill-connectors test` and confirm the new pilot tests pass.
- [ ] Run `openspec validate add-reddit-pilot-real-shape-fixture --strict`.
- [ ] Run `openspec validate --all --strict`.
