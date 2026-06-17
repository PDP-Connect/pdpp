## Context

`bound-codex-collector-memory` fixed the incident class that caused a Codex collector to peak around 1.4-1.8 GB RSS. The same audit found the fix is complete for `codex` and `claude_code`, but the class-level problem remains:

- `twitter_archive` reads an entire JavaScript archive file and parses it into an in-memory array.
- `imessage` materializes all matching `chat.db` rows with `.all(since)`.
- `slack` uses `.all()` against slackdump SQLite rows that can represent long workspaces.
- `apple_health` already streams `export.xml` and is the internal reference shape.

The SLVP-ideal rule is not "patch whichever connector caused the last OOM." It is a shared construction boundary: local connectors may hold bounded previews, row-sized records, or explicitly capped cardinality maps, but must not let source bytes or unbounded database rows become process heap before record-level bounds apply.

## Design

### Source-class contract

The rule applies to connectors that read owner-controlled files, directories, exported archives, or local databases through the polyfill runtime filesystem binding.

Allowed patterns:

- `createReadStream`, `readline`, streaming XML/JSON/CSV parsing, or equivalent bounded parsers.
- SQLite row iteration (`.iterate()`) for user-data tables.
- Whole-file reads for explicitly bounded, small per-artifact files with a test-visible allowlist reason.
- In-memory aggregation maps bounded by record cardinality and explicit caps/eviction, not by source byte size.

Disallowed patterns:

- `await readFile(...)` or `readFileSync(...)` on stream-eligible user data before parser or record bounds.
- `.all()` on unbounded local database queries.
- Full archive arrays for exports that can grow with user history.

### Guard shape

Replace the Codex/Claude-only grep guard with a manifest-driven source-class guard in `packages/polyfill-connectors/src`. The guard should discover filesystem/local-DB connectors from manifests or an explicit registry and assert:

- no unapproved whole-file reads of stream-eligible user data;
- no unapproved `readFileSync`;
- no unbounded `.all()` on local databases;
- every exception has a connector, file, pattern, and reason.

This guard is not a substitute for behavioral tests. It catches class drift cheaply, while connector-specific tests prove equivalence and memory bounds.

### Implementation sequence

1. `imessage`: convert `.all(since)` to `.iterate(since)`. This is the lowest-risk high-value fix because the existing loop already emits row by row.
2. Guard test: expand the bounded-read regression guard so future connectors cannot regress silently.
3. `twitter_archive`: replace whole-file `tweets.js` parsing with a streaming parser or bounded chunk reader that emits records without retaining the full archive array.
4. `slack`: convert large slackdump row reads to an iterator path; keep `.all()` only for bounded lookup tables if needed.
5. Lower-risk connectors (`google_maps`, `whatsapp`, `ical`, `usaa`, `chase`) either migrate to streaming where practical or receive explicit allowlist reasons for small per-artifact reads.

### Non-goals

- No RS API or MCP changes.
- No new user-visible connector states.
- No promise that a connector can parse infinite inputs; the requirement is that process memory is bounded by parser windows, emitted records, and explicit cardinality caps rather than raw source bytes.

## Acceptance Checks

- The generalized guard fails on an unallowlisted `readFile`/`readFileSync` or unbounded `.all()` in a filesystem/local-DB connector.
- `imessage` tests pass with row iteration.
- `twitter_archive` fixtures produce equivalent records without a full archive array.
- Slack dump tests pass after iterator conversion or documented bounded exceptions.
- `pnpm --filter @pdpp/polyfill-connectors typecheck` passes.
- `openspec validate generalize-local-connector-bounded-reads --strict` passes.

## Risks

- Streaming Twitter archive JavaScript is more complex than row iteration. If the implementation would be brittle, the correct first tranche is `imessage` + guard + explicit Twitter TODO, not an unsafe parser rewrite.
- Grep-like guards can produce false positives. Keep a small reviewed allowlist with reasons rather than weakening the rule.
- Some connectors read individual user files that are usually small but not formally bounded. Those should be documented honestly and migrated later if real fixtures prove large-memory risk.
