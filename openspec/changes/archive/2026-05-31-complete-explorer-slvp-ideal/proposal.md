## Why

The reference dashboard's records explorer (`/dashboard/explore`) is shipped and honest, but it is not the SLVP ideal. The owner docket places "Explorer design SLVP ideal" at direct priority 0 and records that the landed work "closed safe UI/IA slices" while "the ideal Explorer depends on read-contract and manifest capabilities that are not fully present yet" (`docs/reference-implementation-owner-docket.md`). The current surface dispatches record cards from a presentation-only heuristic (`apps/web/src/app/dashboard/lib/record-kind.ts`) because the public read contract carries no declared field *type*. The designer's type-aware cards, type facets, blob/photo previews, and grant-truthful field projection therefore cannot be built faithfully yet (`design-notes/explorer-record-kind-and-typed-manifest-2026-05-28.md`).

The result is a backlog of `owner-decision-gated` Explorer items with no single accepted target: typed manifest schemas, connection-scoped search, blob/photo cards, grant/field projection truthfulness, Search/Explore/Timeline IA unification, sandbox parity, and live browser UAT. This change defines the SLVP ideal as one coherent product/contract target and draws the line between what is product-UI-only and what needs a read-contract or manifest change first.

This change does not ship code. It defines the requirement target, the prerequisite contract additions, and acceptance criteria precise enough that implementation workers can short-circuit unnecessary browser work.

## Framing

The Explorer is an **operator-console** surface (`/dashboard/**`), addressed to the owner of a self-hosted reference instance under an owner token. It is not PDPP Core, not the Collection Profile, and not a hosted service. It reads only through the existing public PDPP read contract and the existing `_ref` connection-summary surface. The one additive contract change this proposal introduces — a declared field `type` on stream metadata — is a **reference-implementation read-contract** addition, not a Core protocol change. Grant/field-projection chrome is explicitly reserved for a future data-owner-facing surface that holds a real client-scoped grant; the owner-token operator console SHALL NOT invent it.

## What Changes

- **MODIFY** the existing `Reference dashboard exposes a records explorer surface` requirement to define the SLVP-ideal target: type-aware record cards dispatched from declared field types (with the existing heuristic as an explicit fallback), a unified Search/Explore/Timeline information architecture, honest sandbox/live parity, and blob/photo card affordances — each constrained so the surface never claims a backend behavior the contract does not support.
- **ADD** a reference read-contract requirement: stream metadata `field_capabilities` entries SHALL carry an additive, optional declared presentation `type` (e.g. `currency`, `timestamp`, `person`, `blob`, `text`), sourced from the manifest, so the Explorer can dispatch cards and facets from a declared type instead of a heuristic. This aligns the live `ConnectorManifest` with the typed shape the sandbox demo manifests already encode.
- **ADD** a reference read-contract requirement: the record-list read MAY expose bounded `meta.window` aggregate metadata (`total`, `earliest_at`, `latest_at`) so the Explorer can render honest corpus/activity summaries without an expensive full fan-out scan.
- **ADD** an operator-console requirement: the Explorer SHALL consume the existing `field_capabilities` grant-usability signal to represent fields hidden by projection honestly, rather than silently omitting them — without introducing client-grant chrome.
- **ADD** an information-architecture requirement: Search, Explore, and Timeline SHALL present one coherent owner mental model — Explore is the records canvas (recency / time-window / query lenses), `/dashboard/search` is reserved for spine artifact jumps, and Timeline is an Explore lens, not a competing surface.
- **ADD** a sandbox-parity requirement fixing the accepted asymmetry: `/sandbox/explore` SHALL render the same Explorer view through the sandbox data source, and any live/sandbox divergence (e.g. illustrative read URLs, seeded data) SHALL be intentional and labeled, not an accidental gap.
- Capture acceptance criteria that let a worker prove each slice with tests and a single bounded browser pass, and that mark which slices are product-UI-only (no contract change) versus contract-gated.

## Capabilities

### Modified

- `reference-implementation-architecture` — the records-explorer requirement gains the SLVP-ideal target (typed cards, IA unification, sandbox parity, blob affordances) under the existing honesty and connection-identity invariants.

### Added

- `reference-implementation-architecture` — declared field `type` on `field_capabilities`; optional `meta.window` record-list aggregate metadata; grant-projection-honest field representation in the Explorer; Search/Explore/Timeline IA unification; sandbox/live Explorer parity.

### Removed

- None.

## Impact

- **Affected specs:** `openspec/specs/reference-implementation-architecture/spec.md` (records-explorer requirement and read-contract metadata).
- **Affected code (implementation, downstream of this change):** `apps/web/src/app/dashboard/explore/**`, `apps/web/src/app/dashboard/lib/record-kind.ts`, `record-preview.ts`, `timeline-summaries.ts`, the shared `explore-data-assembler.ts`, the dashboard shell/subnav, `apps/console` mirrors, `apps/web/src/app/sandbox/explore/**`, and — for the declared `type` and `meta.window` additions — the reference manifest type, the `_ref`/`GET /v1/streams` metadata path, and `@pdpp/reference-contract`.
- **Coordination:** the declared `type` addition overlaps the typed-manifest gap captured in `design-notes/explorer-record-kind-and-typed-manifest-2026-05-28.md`; this change is its promotion into OpenSpec. Connection-scoped search remains owned by `expose-connection-identity-on-public-read`; this change consumes that identity when present and stays forward-compatible, but does not redefine it.
- **Out of scope:** the `/dashboard/records/*` → `/dashboard/connections/*` URL-prefix rename (already deferred to its own change by the existing spec), any Core protocol change, and any client-grant/field-projection UI on the operator console.
