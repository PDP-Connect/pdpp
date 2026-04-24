# OpenSpec Cleanup Audit

Date: 2026-04-24

## Structural State

- `openspec validate --all --strict` passes.
- Canonical specs are sparse: `reference-implementation-architecture` and `reference-implementation-governance` only.
- Active changes include completed implementation work that should now be archived into canonical specs.
- Supplemental design notes are valuable but overloaded: research, sprint briefs, open questions, status reports, connector-specific design, and implementation TODOs are mixed together.

## Active Change Recommendations

### Archive After Owner Review

- `harden-reference-boundaries`: marked complete; archive unless there is an unstated reason to keep it active.
- `rename-reference-implementation`: marked complete; archive unless a hidden rename follow-up remains.
- `add-reference-impl-logging`: implementation appears landed (`pino`, `pino-pretty`, structured Fastify logger, process handlers); audit final unchecked tasks, then archive.
- `add-lexical-retrieval-extension`: public docs, contract registration, reference route, tests, and dashboard usage appear landed; audit final shape, then archive.
- `implement-lexical-retrieval-extension`: implementation appears landed; archive with or immediately after the extension proposal.
- `add-semantic-retrieval-experimental-extension`: public docs, contract registration, route, sqlite-vec dependency, semantic tests, and dashboard helper appear landed; audit final shape, then archive.
- `implement-semantic-retrieval-experimental-extension`: implementation appears landed; archive with or immediately after the extension proposal.

### Keep Active

- `swap-sqlite-driver`: still the active crash/stability migration unless a later merge fully replaced the driver and query extraction requirements. It should stay active until the native-crash verification and query-surface extraction decision are closed.
- `add-polyfill-connector-system`: still an active product/runtime program. Keep active, but split future connector additions and open questions into smaller follow-up changes or root `design-notes/` entries.
- `reference-implementation-program`: effectively complete except broad storage abstraction. Recommended closeout: move broad storage abstraction into a follow-up design note or OpenSpec change, mark the program complete, then archive.

## Design-Note Triage Recommendations

### Promote Or Sprint Soon

- connector configuration, credential storage, and credential bootstrap automation
- partial-run semantics, gap recovery execution, cursor finality, and raw provenance capture
- semantic retrieval status/options if the current experimental extension is not the final intended contract
- RS API discoverability and capability discovery framing if more advertised capabilities are planned
- account risk from repeated automation and browser automation tool choice

### Keep As Connector-Specific Background

- connector notes such as `ynab.md`, `gmail.md`, `chatgpt.md`, `usaa.md`, `chase.md`, `amazon.md`
- platform-specific coverage notes and parser gap notes
- prior-art UI research notes, once their decisions are linked from a canonical design or archived change

### Convert To Implementation Backlog Or Follow-Up Changes

- concrete stream additions and connector coverage tasks in `add-polyfill-connector-system/tasks.md`
- Gmail attachment blob collection
- LLM-based fixture scrubber and connector-specific scrub rules
- query-surface dashboard and static SQL analyzer from `swap-sqlite-driver`

## Cleanup Order

1. Archive complete, low-risk historical changes first: `rename-reference-implementation`, `harden-reference-boundaries`.
2. Audit and archive shipped retrieval/logging changes.
3. Close `reference-implementation-program` by extracting the remaining broad-storage item into a follow-up.
4. Triage polyfill connector design notes using the new note statuses.
5. Re-run `openspec validate --all --strict` and keep `openspec list` small enough that every active change is genuinely actionable.
