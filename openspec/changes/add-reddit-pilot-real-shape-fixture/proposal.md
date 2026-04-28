## Why

The connector fixture scrubber pipeline shipped with two pilot shapes: a browser DOM capture (Amazon) and an API JSON capture (GitHub). Reddit is now the third distinct shape — a records-level JSONL stream emitted directly from `runConnector()` — and has no committed real-shape fixture. Its integration tests use synthetic listings, which miss drift between the hand-crafted shapes and what Reddit's old-reddit JSON actually serves.

A 2026-04-25 raw Reddit run exists locally. The deterministic scrubber catches `/u/<user>` mentions and the shared PII defaults, but Reddit bodies and titles contain identifying free-form user-authored text that deterministic rules cannot safely classify. Per the already-shipped scrubber pipeline, this is exactly the case its LLM-assisted structured-redaction mode is designed for.

Committing a reviewed Reddit pilot fixture would (a) lock the v0.2.0 emitted-record shape against regression, (b) give integration tests a real-shape ground truth matching the Amazon/GitHub pilots, and (c) prove the LLM-redaction mode end-to-end on a records-stream shape.

## What Changes

- Capture a fresh real Reddit run with the v0.2.0 connector (`PDPP_CAPTURE_FIXTURES=1`).
- Author an LLM redaction plan covering every raw `records/*.jsonl` row — every free-form `title`, `body`, `selftext`, `url`, and any `permalink` whose slug carries identifying text.
- Run the scrubber with `--llm-redactions-dir` to produce `fixtures/reddit/scrubbed/pilot-real-shape/records/{submitted,comments,saved,upvoted,downvoted,hidden}.jsonl`.
- Review the scrubbed output by eye; commit only after reviewer sign-off.
- Add a `pilot-real-shape` integration test that reads the committed JSONL and asserts every row passes `validateRecord()` for its stream.
- Document the Reddit pilot in the connector authoring guide alongside the Amazon and GitHub pilots, so future connectors have a records-stream reference.

## Capabilities

### Modified Capabilities

- `reference-implementation-governance`: extend the scrubbed-fixture policy to cover records-stream JSONL, not just DOM and API JSON.

## Impact

- `packages/polyfill-connectors/fixtures/reddit/scrubbed/pilot-real-shape/**` (new, committed)
- `packages/polyfill-connectors/connectors/reddit/integration.test.ts` (new pilot-real-shape test block)
- `packages/polyfill-connectors/docs/connector-authoring-guide.md` (records-stream pilot reference)
- No runtime or manifest changes.
