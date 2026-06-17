# Twitter archive bounded-read design blocker

Status: RESOLVED 2026-06-17 — streaming implemented (see Resolution). Original blocker analysis preserved below as history.
Date: 2026-06-17

## Decision

`twitter_archive` is not converted to streaming in this tranche. The safe bounded-memory work landed for iMessage and Slack; Twitter remains open because a quick hand-rolled streaming parser would be lower-confidence than the existing whole-file parser.

## Current Shape

`connectors/twitter_archive/index.ts` reads `tweets.js`/`tweet.js` and `direct-messages.js` with `readFile(path, "utf8")`, then `stripJsArchive(text)` strips the `window.YTD... = ` assignment wrapper and `JSON.parse`s the result into a full in-memory array. The emit loops already process entries one at a time; the unbounded piece is the load/parse step.

This is a real source-size-to-heap hazard: a heavy Twitter/X archive can be hundreds of MB, and the current path can hold both the raw string and parsed array at once.

## Why This Is Blocked

1. The files are JavaScript assignments, not JSON. A streaming implementation needs a prefix-stripping transform before any JSON array parser.
2. `packages/polyfill-connectors` does not currently include a streaming JSON parser dependency. Hand-rolling a tokenizer for nested objects, escaped strings, brackets, and unicode would be brittle.
3. The current fixtures are in-code arrays, not on-disk `window.YTD... = [...]` archive files. A streaming-equivalence gate needs real file-shaped fixtures before replacing the known-correct parser.

## Required Future Tranche

- Choose a vetted streaming JSON parser dependency or explicitly justify a custom parser.
- Add small scrubbed on-disk `tweets.js` and `direct-messages.js` fixtures with assignment prefix/suffix and escaped text cases.
- Prove streaming equivalence: same emitted records, cursor advancement, and missing-file behavior.
- Keep the existing pure record builders (`unwrapTweetEntry`, `buildTweetRecord`, etc.) where possible; only replace the load path.

## Resolution (2026-06-17)

All four "required future tranche" items were completed in this tranche. The blocker's three reasons were each retired by a vetted dependency rather than a hand-rolled tokenizer:

1. **JS-assignment prefix.** The wrapper LHS (`window.YTD.<name>.partN =`) is a member-access assignment that never contains a `[`. The streaming reader buffers leading chunks only until the first `[` (the array opener), then feeds the remainder to the parser. The trailing `;`/whitespace is handled by detecting parser completion via the public `isEnded` flag: a `write()` that throws while `isEnded` is true is the benign assignment terminator; a throw while not ended is a genuine malformed-archive error. Implemented in `stripAssignmentPrefix` + `streamJsArchive` in `connectors/twitter_archive/archive-stream.ts`.

2. **No streaming JSON parser dependency.** Added **`@streamparser/json@^0.0.22`** to `packages/polyfill-connectors` — a vetted (High source reputation), **dependency-free**, fully spec-compliant streaming parser (`JSON.parse`-equivalent). With `paths: ['$.*']` it emits each top-level array element via `onValue`, and `keepStack: false` nulls each emitted element out of the containing array (verified empirically: the parent retains only `null` pointer slots, never the per-element payload). This is the same "stream a huge export incrementally" shape as the internal `apple_health` reference. Escaped strings, nested objects/arrays, brackets-in-strings, and unicode are handled natively by the parser — the original "brittle hand-rolled tokenizer" concern does not arise.

3. **In-code-only fixtures.** Added on-disk archive fixtures under `connectors/twitter_archive/__fixtures__/archive-files/`: real `window.YTD... = [...]` `tweets.js` and `direct-messages.js` with escaped quotes/backslashes/newlines/brackets and accented+emoji+`☃` unicode; a legacy flat `tweet.js`; and an empty-array `tweets.js`.

**Equivalence proof.** `archive-stream.test.ts` deep-equals the streamed entries against an inline whole-file `JSON.parse(strip(...))` oracle over the same bytes; a 3000-element re-serialized fixture proves cross-chunk strings/objects are not corrupted at `createReadStream` highWaterMark boundaries; an end-to-end subprocess test (`runConnectorProtocolSubprocess` with `TWITTER_ARCHIVE_DIR`) asserts the emitted RECORD ids/fields, incremental-cursor skipping, STATE cursors, and that a missing archive dir yields `SKIP_RESULT` (not failure). The pure record builders (`unwrapTweetEntry`, `buildTweetRecord`, `unwrapDmConversation`, `buildDmRecord`, cursor helpers) are unchanged; only the load path was replaced. The now-superseded whole-file `stripJsArchive` helper and its `*_JS_TEXT` fixtures were removed.

**Guard.** Both `twitter_archive` `readFile` exceptions were removed from `local-source-bounded-read-guard.ts`; the guard still passes (no remaining whole-file read in the connector). The guard test gained a positive assertion that `twitter_archive/index.ts` no longer imports/awaits `readFile` and that the streaming helper uses `createReadStream` + `@streamparser/json`, and the removed-exception negative control was repointed at the still-present WhatsApp per-export read.

**Memory bound.** Process memory is now bounded by the parser window plus the current element plus an O(element-count) array of `null` pointers (tens of MB worst case for a multi-hundred-MB archive), rather than the raw file string plus the full parsed object array. This satisfies the spec requirement that source bytes do not become process heap before record-level bounds apply.
