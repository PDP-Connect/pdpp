## Why

The Explorer's typed-card path is shipped, tested, and accepted (`openspec/changes/archive/2026-05-31-complete-explorer-slvp-ideal`), but on live data it is dormant. The reference server reads a declared presentation `type` from a stream manifest and surfaces it as `field_capabilities[].type` (`reference-implementation/server/index.js:1874-1882`); the Explorer prefers that declared type over its heuristic when dispatching record cards (`apps/web/src/app/dashboard/lib/record-kind.ts:222-240`); and the contract, server, and UI are all proven green. The single missing link is that **no first-party polyfill manifest declares a presentation `type`** — `grep x_pdpp_type packages/polyfill-connectors/manifests/` returns zero matches. Only the sandbox demo manifests carry it (`apps/web/src/app/sandbox/_demo/data-source.ts:238-242`), so typed cards render in `/sandbox/explore` but fall to the one-line heuristic in `/dashboard/explore` on real connections.

The SLVP owner audit (`tmp/workstreams/ri-explorer-slvp-owner-audit-v1-report.md`) named this the single biggest reason to withhold a >95% "the Explorer looks like the design" claim, and correctly diagnosed it as a manifest-typing gap, not a UI gap. The designer mock (`PDPP Explorer.html`, now located — see `design.md`) confirms the design is fully type-driven: every card kind is dispatched from declared schema field types, not connector branching.

This change closes the root cause for a narrow, owner-decidable pilot: declare presentation types on **two flagship live-shaped connectors** — one money-shaped (`chase`), one message-shaped (`gmail`) — so typed money and message cards render on real data through the already-accepted path. It is the smallest tranche that converts "typed cards work in tests and sandbox" into "typed cards work on real connections," without a 30-connector rollout and without any new contract noun.

## What Changes

- **ADD** declared presentation `type` (`x_pdpp_type` on existing `schema.properties`) to the pilot fields of two first-party manifests:
  - `chase` `transactions` — `amount` → `currency`, `date` → `timestamp`, `name` → `text` (so the row dispatches a `money` card).
  - `gmail` `messages` — `from_name` → `person`, `subject` → `text`, `snippet` → `text`, `date` → `timestamp` (so the row dispatches a `message` card).
- **ADD** a no-runtime-risk evidence harness that loads the **real committed manifests** through the live `GET /v1/streams/:stream` path and asserts (a) the pilot fields surface `field_capabilities[].type`, (b) every other capability flag is byte-identical to the pre-pilot manifest, and (c) the surfaced types drive the expected `record-kind` dispatch (`money` for chase, `message` for gmail) through the real `classifyRecordKind` consumer.
- **ADD** an architecture requirement: flagship first-party manifests selected for the typed-card pilot SHALL declare presentation types on the small set of fields the design dispatches from, mirroring the existing "honest semantic field coverage" requirement — additive, presentation-only, never altering grant/filter/retrieval semantics.
- The declared `type` field on `field_capabilities`, the record-card dispatch contract, and the sandbox/live parity requirement are **already accepted** by the archived change; this change does not re-open them. It implements them on real connectors and adds the durable requirement that the pilot connectors carry the declarations.

This change does not roll out types to all connectors, does not add card kinds, does not add a view switcher or grant-projection toggle, and does not introduce any new RS, `_ref`, or manifest contract field.

## Capabilities

### Modified

- `reference-implementation-architecture` — adds a requirement that flagship first-party manifests in the typed-card pilot declare presentation types, so the accepted typed-card path is live on real data rather than dormant.

### Added

- None. The read-contract `field_capabilities[].type`, the record-card dispatch behavior, and sandbox/live parity are already accepted in the archived `complete-explorer-slvp-ideal` change.

### Removed

- None.

## Impact

- **Affected specs:** `openspec/specs/reference-implementation-architecture/spec.md` (one new requirement under the records-explorer / first-party-manifest family).
- **Affected manifests (committed):** `packages/polyfill-connectors/manifests/chase.json`, `packages/polyfill-connectors/manifests/gmail.json` — additive `x_pdpp_type` keys on existing schema properties only.
- **Affected tests (new):** an evidence harness proving the real-manifest → `field_capabilities[].type` → `record-kind` path end-to-end. Location chosen during implementation to sit beside the existing `reference-implementation/test/rs-streams-field-declared-type.test.js` and the web `record-kind.test.ts`.
- **No runtime, server, or contract code changes.** The server already reads `x_pdpp_type`; this change only feeds it real declarations and proves the path.
- **Coordination:** consumes the accepted `field_capabilities[].type` contract from `complete-explorer-slvp-ideal`. Connection-scoped search remains owned by `expose-connection-identity-on-public-read` and is untouched here.
- **Out of scope:** all other connectors, new card kinds, the per-stream view switcher, the grant-projection/`redacted_reason` toggle, Postgres `meta.window` parity, and any browser/UAT pixel evidence (captured as a follow-up runbook in `design.md`, not produced in this worktree).
