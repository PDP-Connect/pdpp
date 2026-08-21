## 1. Reproduction test (write first, before touching the connector)

- [x] Add `packages/polyfill-connectors/connectors/slack/scoped-archive-coverage.test.ts`: seed a base archive missing 2 channels, each recoverable from its own separate pre-existing scoped archive, drive the real connector via `runConnectorProtocolSubprocess` (`PDPP_SLACK_SKIP_SLACKDUMP=1`) with `messages`/`reactions`/`message_attachments` in scope, and assert each `(state_stream, stream)` DETAIL_COVERAGE pair appears exactly once with the summed `considered`.
- [x] Confirm the test fails against unmodified `connectors/slack/index.ts` (3 emissions of the `messages` pair: base + 2 scoped archives), then leave it in the suite.

## 2. Fix

- [x] Remove the messages self-coverage and message-family DETAIL_COVERAGE emission from inside `runRequestedStreams`.
- [x] Add `declareMergedMessageCoverage(deps, considered)`, gated internally on the message family being requested (mirrors the removed inline guard), emitting the self-coverage then delegating to the existing `declareMessageFamilyCoverage`.
- [x] Call `declareMergedMessageCoverage` once from `collect()`, after both the base-archive `runRequestedStreams` call and the conditional `mergeScopedMessageArchivePasses` fold, using the (possibly folded) `messageResult.considered`.

## 3. Existing test repair

- [x] Update `integration.test.ts`'s `"runRequestedStreams: archive message enumeration bounds both derived streams"` test, which asserted DETAIL_COVERAGE emission from inside `runRequestedStreams` directly — that emission moved to the caller, so assert on the returned `MessagesPassResult.considered` instead, and assert no DETAIL_COVERAGE is emitted from this call in isolation.

## 4. Validation

- [x] Run the new test; confirm GREEN with the fix applied.
- [x] Run the full `connectors/slack/**/*.test.ts` suite; confirm no regressions (201/201 pass).
- [x] Run `reference-implementation`'s `test/slack-collection-report.test.ts` (unaffected — projection layer, not connector).
- [x] `npm --prefix reference-implementation run typecheck` — clean.
- [x] `npm --prefix packages/polyfill-connectors run typecheck` — clean.
- [x] `npx biome check` on every changed file — clean (required extracting `declareMergedMessageCoverage` and gating the message-family check inside it, rather than an `if` in `collect()`, to stay under the cognitive-complexity ceiling).
- [x] `openspec validate fix-slack-scoped-archive-coverage-duplication --strict` — passes.
