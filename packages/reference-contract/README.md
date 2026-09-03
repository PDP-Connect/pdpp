# @pdpp/reference-contract

Single source of truth for the PDPP reference-implementation wire contract.

## Why this package

This package holds:

- JSON-Schema-first route manifests for every public and reference-only route
- reusable common schemas (ids, cursors, freshness, errors)
- typed helpers used by the CLI, dashboard, tests, and agent-facing tooling
- builders for common request shapes (device authz, PAR, records queries)

It is JSON-Schema-first so the same schemas drive request validation in the
reference server, OpenAPI emission, and client-side query building.

## Contents

- `src/common/` — shared JSON-Schema fragments (ids, cursors, freshness, errors)
- `src/public/` — public PDPP route manifests
- `src/reference/` — reference-only `/_ref` route manifests
- `src/openapi/` — pure OpenAPI document builder for the reference implementation
- `src/builders/` — request builders

## Development status

This package was scaffolded in W0 of the reference-implementation execution
plan. Route manifests, validators, and generated artifacts are filled in across
W1–W2 of that plan.

The reference implementation and its generated OpenAPI and route-document
artifacts are now canonical in `PDP-Connect/data-connect`. This package does
not write those retired outputs into this repository.
