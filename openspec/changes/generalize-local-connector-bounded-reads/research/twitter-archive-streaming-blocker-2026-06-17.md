# Twitter archive bounded-read design blocker

Status: blocked, deferred to a dedicated tranche
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
