# Design: complete-explorer-slvp-ideal

## Goal

Define the Explorer SLVP ideal as one accepted product/contract target, replacing a backlog of `owner-decision-gated` Explorer items with a single coherent shape. The ideal is the records canvas an owner of a self-hosted reference instance uses to browse, search, and inspect their own records under an owner token — rendered with the editorial-minimalism and protocol-precision craft in `.impeccable.md`, and honest at every seam about what the read contract can and cannot prove.

This is a spec-and-target change. It ships no code. Its job is to draw the line between product-UI-only work and contract-gated work so implementation lanes can proceed without re-litigating scope, and to give acceptance criteria precise enough that a worker can prove a slice with tests plus one bounded browser pass.

## The product/contract line

The single most useful thing this change does is separate two layers that the Explorer backlog has been conflating.

### Layer 1 — product UI only (no contract change)

These are accepted as buildable today against the existing read contract. Most are already shipped; the spec records them as the SLVP floor so they are not re-opened:

- Explore as the single records canvas with recency / time-window / query lenses.
- Day-grouped feed sections, lens-aware section titles, connection display names on rows and in the peek panel.
- Connection facet chips keyed on concrete `connection_id`, with honest connector-scoped labeling when search hits lack identity.
- Honest peek-panel read URL matching the typed RS client's actual request.
- Partial-fan-in and capability-downgrade warnings surfaced, never swallowed.
- The presentation-only `record-kind` heuristic and structured card previews for rows whose body is in hand.
- Search/Explore/Timeline IA unification: Explore hosts the lenses, Timeline is an Explore time-window lens, `/dashboard/search` is spine-jump only.
- `/sandbox/explore` rendering the same view through the sandbox data source.

### Layer 2 — contract- or metadata-gated (needs a read-contract or manifest change first)

These cannot be built faithfully in UI alone, because the public read contract does not declare the information the design needs. Each is gated behind exactly one additive contract surface:

| Capability | Gating contract addition | Why UI alone is dishonest |
|---|---|---|
| Type-aware cards dispatched from declared types | `field_capabilities[].type` (this change) | A heuristic over inferred field names locks the dashboard into connector-specific guesses; a `currency` card over an unknown number is a claim the contract does not back. |
| Type-based facets | `field_capabilities[].type` (this change) | Facets must come from declared metadata, not hard-coded stream assumptions. |
| Photo / blob cards | declared `blob` field type (this change) + existing blob read path | Rendering a preview requires knowing a field is a blob and reading it grant-aware; guessing produces broken or unsafe affordances. |
| Honest corpus / activity summaries | `meta.window` aggregate metadata (this change) | "Spans N years" computed from a bounded recency sample is a false figure; an unbounded scan is too expensive for the empty-query load. |
| Grant-truthful field projection | existing `field_capabilities` grant-usability signal (already in contract) | Already available — this change requires the Explorer to *consume* it so projected-out fields are represented honestly rather than silently omitted. |
| Connection-scoped search (request-shape filter) | `expose-connection-identity-on-public-read` (separate, in-flight) | Owned by that change. This change stays forward-compatible: it reads concrete `connection_id` when present and post-filters honestly when absent. It does not redefine that contract. |

The declared `type` and `meta.window` additions are **reference read-contract** changes, not Core protocol changes. They are additive and optional; an undeclared manifest produces the current shape. Crucially, the sandbox demo manifests already carry `type`/`semantic_class` per field — so this change closes an existing live/sandbox asymmetry rather than inventing a new shape (`design-notes/explorer-record-kind-and-typed-manifest-2026-05-28.md`).

## Why `reference-implementation-architecture` and not a new capability

The Explorer surface is already a normative requirement in `reference-implementation-architecture` (`Reference dashboard exposes a records explorer surface`, with its full set of connection-identity, peek-URL, partial-fan-in, and grant-projection-chrome scenarios). `field_capabilities` and the record-list read are owned by the same capability. The SLVP ideal is a tightening and extension of an existing requirement, not a new capability. Minting a new capability would split one surface's invariants across two specs and violate the standing rule to prefer updating an existing capability (`AGENTS.md`). The MODIFIED requirement restates the existing scenarios verbatim and adds the SLVP-ideal scenarios so the honesty guarantees and the new target live in one place.

## Design direction (`.impeccable.md`)

The Explorer is the operator-console realization of the page whose brand line is "editorial minimalism with protocol precision, light mode, restrained craft." Concretely, for this surface:

- **Cards are typeset, not boxed.** Type-aware cards use a thin left-rail accent keyed to the record kind (the temperature duality: copper for human/message/person surfaces, cool blue for protocol/money/system surfaces) and lead with the record's identifying fact — amount and counterparty for money, author and body for a message, time and title for an event. No card-grid of identical tiles; a vertical, day-grouped feed with generous whitespace and a clear reading rhythm.
- **Protocol data is monospace.** The peek panel's `GET /v1/streams/<stream>/records/<id>` URL, `connection_id`, and record keys render in JetBrains Mono. This is the "this is real protocol data" signal, and it is the same URL the typed client issues.
- **The field-projection moment is the memorable detail.** Where the design's headline moment is "8 fields enter, 4 come out," the operator-console honest analogue is: fields the active token's grant projection withholds are shown *as withheld*, not silently dropped. The owner viscerally sees what projection does without the surface pretending to hold a client grant it does not have.
- **Honesty is the aesthetic.** Warnings (partial fan-in, hybrid downgrade), connector-scoped search labels, and "derived from a bounded sample" summary captions are first-class, calm, and precise — not error toasts. A surface that hides backend uncertainty behind a green status is off-brand here.
- **No AI slop.** No generic dashboard widgets, no decorative charts, no fake density. Every element is a record, a lens control, a facet chip, a warning, or a protocol fact.

## Acceptance criteria and browser-work short-circuit

Implementation workers SHALL prove each slice with the smallest sufficient check. A slice that is fully covered by `page.invariants.test.ts` / unit tests and a green type/build pass does NOT require a browser pass. Reserve live browser UAT for the single end-to-end journey below.

- **Product-UI-only slices** (typed-card dispatch given a typed fixture, IA unification, sandbox parity, grant-projection-honest rendering against a fixture, blob affordance against a `blob_ref` fixture): prove with `apps/web` + `apps/console` explorer/search/records tests, `page.invariants.test.ts` drift tests, `types:check`, and `check`. No browser pass required when the fixture exercises the behavior.
- **Contract slices** (`field_capabilities[].type`, `meta.window`): prove with `@pdpp/reference-contract` `verify` + `check:generated`, targeted reference-server `node --test` over the `GET /v1/streams` and record-list paths, and an assertion that an undeclared manifest yields the current shape.
- **Single browser UAT journey (run once, at the end):** owner opens `/dashboard/explore`, confirms typed cards render for a typed connection, two accounts of the same connector stay distinct, a withheld field shows as withheld, a blob record shows a grant-aware affordance, a `meta.window` summary reads honestly (or is absent without claiming a corpus figure), Timeline is reachable as an Explore lens, `/dashboard/search` jumps by id, and `/sandbox/explore` renders the seeded specimen. This is the only step that requires a browser.

## Alternatives considered

- **Ship typed cards on the heuristic alone (no contract change).** Rejected: `record-kind.ts` infers from field-name patterns and cannot distinguish a `currency` field from a generic number or a `blob` from a string. It is honest as a fallback but dishonest as the SLVP ideal, and it locks the dashboard into connector-specific heuristics (`design-notes/explorer-record-kind-and-typed-manifest-2026-05-28.md`).
- **Add a new `explorer` capability.** Rejected: splits one surface's invariants across two specs; the existing capability already owns the requirement.
- **Fold connection-scoped search into this change.** Rejected: it is already owned by `expose-connection-identity-on-public-read`. This change consumes that identity forward-compatibly and does not redefine it.
- **Require `/dashboard/records/*` → `/dashboard/connections/*` rename here.** Rejected: the existing spec explicitly defers the URL-prefix rename to its own change; pulling it in would fatten this proposal.
- **Make `meta.window` mandatory.** Rejected: a mandatory aggregate forces either an expensive scan or an estimate. Optional-and-omitted keeps the empty-query load cheap and the figures honest.

## Residual owner decisions

These are genuinely open and are recorded for the owner rather than pre-decided:

1. **Search ↔ Explore final shape.** This change fixes that `/dashboard/search` is spine-jump only and Explore owns record query. Whether `/dashboard/search` survives as a top-level nav entry or collapses into a command-palette / topbar jump is a navigation-chrome decision left open.
2. **`meta.window` priority and scope.** Whether to implement `meta.window` now (unblocking honest corpus/activity summaries) or defer it and keep summaries omitted in the interim. The spec makes it optional precisely so this can be sequenced independently.
3. **Declared-type vocabulary.** The exact `type` enum (`currency`, `timestamp`, `person`, `blob`, `text`, …) and whether it reuses or diverges from the sandbox manifests' existing `type`/`semantic_class` naming. The spec asserts the live manifest SHALL accept the sandbox's shape; the precise enum is an implementation decision to settle when the manifest type is aligned.
4. **Live browser UAT ownership.** The single end-to-end journey requires a live AS/RS; per the owner docket it is `owner-live-gated`. Whoever runs it should run it once, after the contract and UI slices land.

## Out of scope

- Any PDPP Core protocol change.
- Client-grant / field-projection chrome on the owner-token operator console (reserved for a future data-owner-facing surface).
- The `/dashboard/records/*` → `/dashboard/connections/*` URL-prefix rename (deferred to its own change by the existing spec).
- Redefining connection-scoped search request semantics (owned by `expose-connection-identity-on-public-read`).
