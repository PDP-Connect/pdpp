## 1. Contract

- [x] Add the filesystem/local-DB bounded-read requirement to `local-agent-collector-completeness`.
- [x] Add a manifest- or registry-driven regression guard for local connector whole-file and unbounded `.all()` reads.
- [x] Add reviewed exceptions for small per-artifact reads with explicit reasons.

## 2. High-Risk Connectors

- [x] Convert `imessage` local database reads from unbounded `.all()` to row iteration.
- [x] Convert `twitter_archive` archive parsing away from whole-file array materialization. Done: `connectors/twitter_archive/archive-stream.ts` streams `tweets.js`/`tweet.js`/`direct-messages.js` with `createReadStream` + the vetted dependency-free `@streamparser/json` parser (`paths: ['$.*']`, `keepStack: false` releases each emitted element). The two `readFile` exceptions were removed from the guard and it still passes. On-disk fixtures with escaped/nested/unicode cases under `__fixtures__/archive-files/`; streaming-equivalence, chunk-boundary, legacy-fallback, empty/missing/malformed, and end-to-end subprocess tests in `archive-stream.test.ts`. The prior blocker is resolved; see `research/twitter-archive-streaming-blocker-2026-06-17.md` (Resolution section).
- [x] Convert large Slack dump row reads to row iteration or document bounded query exceptions.

## 3. Validation

- [x] Run targeted polyfill connector tests for changed connectors.
- [x] Run `pnpm --filter @pdpp/polyfill-connectors typecheck`.
- [x] Run `openspec validate generalize-local-connector-bounded-reads --strict`.
