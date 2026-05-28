## Why

Four polyfill connectors (Slack, Gmail, Codex, YNAB) have independently converged on the same per-record fingerprint cursor to suppress no-op record emits from sources that re-derive full records each run (archive rebuilds, full-collection refetches, file-mtime triggers, aggregate re-derivation). Live history shows the cost of leaving this unguarded: Slack `workspace` accumulated 31,160 versions for a single record with only 253 distinct payloads; Codex `sessions`, Gmail `threads`, YNAB `payee_locations`, and Gmail `labels` show the same shape.

The runtime byte-equivalence backstop fixed by `repair-record-version-noop-detection` catches duplicate writes a connector author missed, but it cannot catch records whose semantic shape did not move but whose stringified output did (key order, derived-field recompute), records whose run-clock fields advance every run, or records the connector should not have emitted at all. The wasted work is in scrape/parse, not just storage.

The connector authoring guide does not currently mention per-record fingerprints. New connectors will keep introducing the same class of bug. The four existing in-repo implementations are near-duplicates and worth factoring before a fifth is written.

## What Changes

- Add a small opt-in primitive under `packages/polyfill-connectors/src/` that encodes the repeated pattern: stable per-record fingerprint, tolerant decode of prior cursor state, gate the emit, carry forward skipped fingerprints, track seen IDs, prune stale IDs at run boundary, expose prior state for connector-specific derived-field policies.
- Migrate the Slack connector — the cleanest existing implementation — to the shared primitive with zero intended behavior change. Slack's `emitWithFingerprint`, `pruneStaleFingerprints`, and `readPriorFingerprintMap` retire in favor of the helper.
- Add a focused test that any fingerprinted stream can call to prove idempotency, source-change emit, source-delete prune, and tolerant decode of legacy/malformed state.
- Update the polyfill connector authoring guide to describe the primitive: when to use it, when not to (cursor-perfect sources), how to declare run-clock exclusions, and that the runtime byte-equivalence check remains a backstop, not a substitute.

The primitive lives in the authoring layer. It does not modify PDPP Core, the Collection Profile, or runtime storage. It does not introduce a public wire field, a content-hash column, or cross-connection dedupe. Existing connectors (Gmail, Codex, YNAB) are not forced to migrate in this tranche; they keep working as-is.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- New: `packages/polyfill-connectors/src/fingerprint-cursor.ts` and a focused idempotency test.
- Modified: `packages/polyfill-connectors/connectors/slack/index.ts`, `packages/polyfill-connectors/connectors/slack/parsers.ts`, `packages/polyfill-connectors/connectors/slack/fingerprint.test.ts` (import-path updates and helper renames only).
- Modified docs: `packages/polyfill-connectors/docs/connector-authoring-guide.md` §6.
- Out of scope: forced migration of Gmail / Codex / YNAB; a fully generic conformance harness driving arbitrary connectors against fixtures; any change to PDPP Core, Collection Profile, public record shape, or storage schema.
