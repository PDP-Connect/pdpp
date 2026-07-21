## Why

H-E-B is correct and honest for the data it currently collects, but it is not
yet SLVP-ideal. The order list already carries a structured Next.js source
(`__NEXT_DATA__.props.pageProps.orders`) while the connector still derives
order values from rendered-card text. The terminal-page proof and a single
bounded mid-run repair path remain unproven or incomplete.

The owner report establishes that G1 alone is insufficient: making the orders
lane structured does not resolve terminal coverage honesty, session recovery,
complete status evidence, or live acceptance. This change makes the whole
connector-level ideal bar executable without inventing a protocol primitive
or silently expanding collection into catalog enrichment. (The item-source/
product-identity question this change originally also scoped in — an opt-in
authenticated order-item network-discovery mode and a resulting GTIN field —
has been deferred; see `tasks.md` sections 1 and 3.)

## What Changes

- Add H-E-B-only requirements for parsing H-E-B order-list `__NEXT_DATA__` as
  the preferred source, retaining the current DOM parser as a fail-safe
  fallback. Add only nullable order fields whose exact compatibility mapping
  against existing field names/meanings is decided in `design.md` and proven
  by semantic-equivalence tests; preserve all existing field names, meanings,
  and record identities.
- Replace the `pageNum > 1` terminal inference with `maxPage`-bounded
  completion: successful parsing through the source-advertised `maxPage` is
  normal completion, and any empty page at or before that bound, or missing
  or contradictory pagination metadata, fails closed. No speculative
  `maxPage + 1` request or live empty-terminal-page fixture is required.
- Use the runtime's existing trigger-kind/automation-mode metadata to gate
  mid-run repair: an unattended run latches `sessionRepairRequired` and defers
  affected/remaining detail work without interaction; an owner-started manual
  run may spend one shared run-scoped `manualAction` attempt, re-probe via
  `probeHebSession`, and retry only the affected detail once before latching.
- Add fixture, parser, schema, manifest, coverage, recovery, and owner-only
  live acceptance checks. Browser-capacity allocation is an external
  prerequisite owned by another lane and is not changed here.

## Capabilities

- Added: `polyfill-runtime` (H-E-B-connector-scoped requirements only; no
  requirement in this change applies to any other connector or a
  repository-wide structured-source, identifier, capture, pagination, or
  mid-run-repair policy)

## Impact

- `packages/polyfill-connectors/connectors/heb/`: structured source parsing
  with exact field-compatibility mappings, `maxPage` completion proof,
  manual-run-only bounded mid-run repair with unattended latch-only behavior,
  and focused tests/fixtures.
- `packages/polyfill-connectors/manifests/heb.json`: additive field
  declarations only after semantic-equivalence or named-field evidence, and
  identity-boundary wording after live evidence.
- No PDPP Core, Collection Profile, generic identifier ontology, external
  matcher, product catalog crawler, connector-specific owner UI, deployment,
  or live-data operation is part of this change.
