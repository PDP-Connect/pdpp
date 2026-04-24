## Why

OpenSpec is now the durable planning layer for this repository, but the repository is using it unevenly:

- active change directories include completed, stale, and exploratory work side by side
- supplemental `design-notes/` are useful, but their lifecycle is not disciplined enough
- open questions discovered during implementation can become long-lived steering documents without a promotion or closeout rule
- agents need one repo-local rulebook that distinguishes official OpenSpec artifacts from exploratory requirements-discovery notes

Official OpenSpec already gives us the right spine: propose, plan with requirement deltas, implement against the plan, then archive into canonical specs. This change makes the repository's local usage stricter and more explicit without inventing a competing process.

## What Changes

- Document how this repo uses OpenSpec as a lifecycle, not just as a folder convention.
- Define a disciplined intake lane for design questions that are important but not yet ready to become protocol/spec changes.
- Clarify that design notes are non-canonical requirements-discovery artifacts, whether they live under a change-local `design-notes/` directory or the root `design-notes/` intake area.
- Add closeout rules for active OpenSpec changes: implemented and accepted changes should be archived; superseded changes should be marked or removed; long-lived programs should keep their remaining tasks honest.
- Add quality criteria for specs, proposals, designs, tasks, and design notes.

## Capabilities

### Modified Capabilities

- `reference-implementation-governance`: tighten the repository's OpenSpec and design-note usage rules so future agents have less room to drift.

## Impact

- `AGENTS.md`
- `openspec/README.md`
- `design-notes/README.md`
- `openspec/specs/reference-implementation-governance/spec.md` after archival

No runtime behavior changes.
