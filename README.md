# PDPP

PDPP is a protocol and reference implementation for user-controlled, purpose-bound access to personal data.

This repository contains three primary layers:

- **Normative PDPP specs** at the repo root in `spec-*.md`
- **Forkable reference implementation** in [`reference-implementation/`](reference-implementation/README.md)
- **Docs and illustrated surfaces** in `apps/web/`

## Repository guide

### Protocol specs

The root `spec-*.md` files are the normative protocol documents.

Start with:

- [`spec-core.md`](spec-core.md)
- [`spec-collection-profile.md`](spec-collection-profile.md)
- [`spec-architecture.md`](spec-architecture.md)
- [`spec-reference-implementation-examples.md`](spec-reference-implementation-examples.md)

### Reference implementation

The current executable reference lives in [`reference-implementation/`](reference-implementation/README.md).

It includes:

- authorization server and resource server
- Collection Profile runtime
- CLI
- manifests and sample connector paths
- black-box integration and conformance-style tests

The reference currently proves one shared substrate with two honest realizations:

- **native provider** access identified publicly with `provider_id`
- **polyfill/connector** access identified publicly with `connector_id`

### Website and docs

The canonical site lives in `apps/web/`.

It renders:

- `/docs` for the spec and reference docs
- `/` for the illustrated landing/reference story
- `/design` for the design workbench

The website is a downstream consumer of the reference implementation, not the implementation boundary itself.

## Quick start

Run the docs/site:

```bash
pnpm dev
```

Run the reference implementation server:

```bash
pnpm reference-implementation:server
```

Inspect the reference CLI:

```bash
pnpm reference-implementation:cli --help
```

Run the reference implementation tests:

```bash
pnpm reference-implementation:test
```

## Authority order

This repo uses a strict authority order:

1. **Root PDPP specs** define normative protocol semantics.
2. **Code and tests** define what the current reference implementation actually does.
3. **OpenSpec** defines project-level architecture and change planning.

OpenSpec in this repo is intentionally project-scoped. It does not replace or compete with the normative PDPP specs.

## OpenSpec

OpenSpec artifacts live in `openspec/`.

Current durable OpenSpec specs include:

- `reference-implementation-governance`
- `reference-implementation-architecture`

Use OpenSpec here for:

- reference-implementation architecture
- project-level boundary decisions
- multi-step implementation changes

Do not use it as a second copy of the PDPP protocol spec.
