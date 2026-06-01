## Why

The connector fixture scrubber pipeline shipped with three pilot shapes: a browser DOM capture (Amazon), an API JSON capture (GitHub), and the records-stream shape. Reddit is the records-stream connector — a JSONL stream emitted directly from `runConnector()` with no intermediate DOM or stored HTTP-JSON layer — and until now had no committed `pilot-real-shape` fixture. Its tests used only synthetic in-test listings, so no committed artifact locked the v0.2.0 emitted-record shape against schema drift.

The established `pilot-real-shape` convention (see `src/pilot-fixture-test-helper.ts` and the committed GitHub pilot) is a **synthetic-but-shape-real** fixture: real field shapes and representative non-identifying values, with `[REDACTED_*]` placeholders wherever a real capture would carry owner identity. The GitHub records pilot (`fixtures/github/scrubbed/pilot-real-shape/records/*.jsonl`) is exactly this — e.g. `id:"555555"`, `topics:["testing","fixtures","synthetic"]`, `owner_login:"[REDACTED_LOGIN]"`. It is committed, PII-free, and requires no live owner sitting. The only invariant the pilot test enforces is that every committed row passes the connector's live `validateRecord()`.

This change closes the no-human-prep gap: it commits a synthetic-but-shape-real Reddit records pilot across all six streams, wires the shared pilot test, and documents the records-stream shape alongside Amazon (DOM) and GitHub (API JSON). A separate, clearly-labeled live-gated follow-up (below) can later use a real owner capture to calibrate or revise the synthetic fixture if higher fidelity is wanted. It SHALL NOT replace `pilot-real-shape/` with real owner rows; any real capture requires owner credentials, local review, and LLM-assisted redaction if it is retained as a separate scrubbed run.

Note: an earlier draft of this proposal asserted "a 2026-04-25 raw Reddit run exists locally." That is not true — there is no `fixtures/reddit/raw/` run on disk, and `fixtures/*/raw/` is gitignored by design. The 2026-04-30 owner capture attempt recorded in `tasks.md` was blocked by a Reddit login/Cloudflare challenge. The synthetic-but-shape-real path does not depend on that capture.

## What Changes

- Author a synthetic-but-shape-real Reddit records pilot at `fixtures/reddit/scrubbed/pilot-real-shape/records/{submitted,comments,saved,upvoted,downvoted,hidden}.jsonl`. Every row is PII-free, uses `[REDACTED_*]` placeholders where identity would appear, and passes the connector's live `validateRecord()` for its stream.
- Wire `connectors/reddit/pilot-fixture.test.ts` via the shared `registerPilotFixtureTests({ connector: "reddit", validateRecord })` helper, matching GitHub.
- Document the records-stream pilot shape in the connector authoring guide §9.1, naming Amazon (DOM), GitHub (API JSON), and Reddit (records-stream) as the three per-shape references.
- Add a `FIXTURES` note in the Reddit `index.ts` header pointing at the committed pilot and the drift-lock test.
- Generalize the governance capability so the records-stream pilot path is satisfied by a synthetic-but-shape-real committed fixture, and the LLM-assisted-redaction requirement applies specifically when a connector uses or retains a separate **real owner capture** of free-form user-authored text.

### Out of scope (live-gated owner follow-up)

Running a reviewed real owner capture is a separate sitting that needs owner credentials and is not required to lock the shape. Its exact owner packet lives in `tasks.md §5`. It can calibrate the synthetic pilot or produce a separately named scrubbed run, but it does not replace `pilot-real-shape/` with real owner rows and does not block this change.

## Capabilities

### Modified Capabilities

- `reference-implementation-governance`: extend the `pilot-real-shape` policy to cover records-stream JSONL (not just DOM and API JSON), preserve the synthetic committed-pilot boundary, and scope the LLM-assisted-redaction requirement to separate real-owner-capture evidence specifically.

## Impact

- `packages/polyfill-connectors/fixtures/reddit/scrubbed/pilot-real-shape/records/*.jsonl` (new, committed, synthetic-but-shape-real)
- `packages/polyfill-connectors/connectors/reddit/pilot-fixture.test.ts` (new, one-line helper wiring)
- `packages/polyfill-connectors/connectors/reddit/index.ts` (header `FIXTURES` note only)
- `packages/polyfill-connectors/docs/connector-authoring-guide.md` (§9.1 pilot-real-shape + records-stream reference)
- No runtime, schema, or manifest changes.
