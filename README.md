# PDPP

PDPP is a protocol for user-controlled, purpose-bound access to personal data.
It defines how an owner authorizes a client to read a bounded, purpose-scoped
slice of their data, and how a source — a native provider or a polyfill
connector — is collected into a single queryable substrate.

This repository holds the normative protocol specification, a forkable
reference implementation, and supporting documentation.

## Specification

The protocol is defined by the `spec-*.md` files at the repository root. Not
every root spec carries the same authority: each file states its own status in
a header near the top, and that header governs. Two of them are the normative
protocol; the rest are informative rationale, illustrative examples, or
historical material superseded by the normative text. Where any downstream
document, example, or superseded spec disagrees with the normative specs, the
normative specs prevail.

**Normative** — the protocol itself. Read these to implement PDPP:

- [`spec-core.md`](spec-core.md) — core protocol: grants, sources, records, and the query surface (*Normative draft*). Core Section 8 is the authoritative definition of the resource-server query interface.
- [`spec-collection-profile.md`](spec-collection-profile.md) — how a source is declared and collected; a companion profile to Core (*Companion profile draft*)

**Informative** — rationale and context. These explain and situate the
protocol but define no conformance requirements of their own:

- [`spec-architecture.md`](spec-architecture.md) — the layered architecture and its boundaries (*Informative*)
- [`spec-auth-design.md`](spec-auth-design.md) — authorization and consent design (*Informative*)
- [`spec-connector-ecosystem.md`](spec-connector-ecosystem.md) — the connector model and runtime landscape (*Informative*)
- [`spec-change-tracking.md`](spec-change-tracking.md) — change-tracking design; the normative surface lives in Core (*Informative*)
- [`spec-deferred.md`](spec-deferred.md) — deferred and out-of-scope items (*Informative*)

**Illustrative** — worked examples, not a normative source for wire shapes:

- [`spec-reference-implementation-examples.md`](spec-reference-implementation-examples.md) — worked example sequences backing the reference implementation (*Illustrative*)

**Superseded** — retained for history only, not for implementation:

- [`spec-data-query-api.md`](spec-data-query-api.md) — the original read/query API design, *superseded* by Core Section 8. Retained for historical reference; do not implement from it.

Public source identity is normatively
`source: { kind: "provider_native" | "connector", id: string }`. Older docs may
call `source.id` a `provider_id` (native providers) or `connector_id` (polyfill
connectors).

## Reference implementation

[`reference-implementation/`](reference-implementation/README.md) is one
runnable implementation of the protocol — a forkable substrate, not the
protocol itself. It provides an authorization server and resource server, the
Collection Profile runtime, a CLI, sample connector manifests, and a black-box
conformance-style test suite.

To run it from the repository root:

```bash
pnpm install
pnpm dev                               # reference AS/RS + operator console
pnpm reference-implementation:server   # reference server only
pnpm reference-implementation:cli --help
pnpm reference-implementation:test     # reference implementation tests
```

For Docker, self-hosting, connector setup, and MCP-client wiring, see the
[self-host quickstart](docs/operator/selfhost-quickstart.md) and the
[reference implementation README](reference-implementation/README.md).

The public site (`apps/site/`) and operator console (`apps/console/`) are
downstream surfaces that explain and front the reference implementation; they
are not the protocol boundary. The durable boundary between them lives in the
`reference-surface-topology` capability spec
([`openspec/specs/reference-surface-topology/spec.md`](openspec/specs/reference-surface-topology/spec.md)).

## Authority order

This repository uses a strict authority order:

1. **Root PDPP specs** (`spec-*.md`) define the protocol. The two normative
   specs (`spec-core.md`, `spec-collection-profile.md`) define protocol
   semantics; the other root specs are informative, illustrative, or
   superseded, as each file's status header states.
2. **Code and tests** define what the reference implementation actually does.
3. **OpenSpec** (`openspec/`) defines project-level architecture and change
   planning.

Public web spec pages are downstream copies of the root specs; `pnpm spec:check`
enforces parity. OpenSpec is intentionally project-scoped and does not replace
or compete with the normative specs.

## Participate

- **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md) — the spec-first
  workflow, test expectations, and pull-request conventions.
- **Maintainers:** [`MAINTAINERS.md`](MAINTAINERS.md) — active maintainers and
  their scopes. Root specification maintainers act as editors for the current
  draft.
- **Changes:** non-trivial protocol, contract, or architecture changes are
  proposed as OpenSpec changes before implementation. See
  [`openspec/README.md`](openspec/README.md).
- **Code of Conduct:** [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — the
  Contributor Covenant, which all participants agree to uphold.
- **Security:** [`SECURITY.md`](SECURITY.md) — how to report a vulnerability
  privately.

## Governance & stewardship

PDPP is developed in the open and is **proposed to LFDT Labs (Linux Foundation
Decentralized Trust) as the lab _PDP-Connect_**. The goal is a neutral,
vendor-independent home for the protocol specification and its reference
implementation.

- **Maintainers.** The current maintainer roster and each maintainer's scope are
  listed in [`MAINTAINERS.md`](MAINTAINERS.md). For the root protocol
  specifications, active maintainers act as editors for the current draft.
  Maintainer changes are proposed through public pull request.
- **Spec-first change process.** Non-trivial protocol, contract, or architecture
  changes are written up as OpenSpec changes and reviewed **before**
  implementation, so the rationale, tasks, and requirement deltas are auditable
  by reviewers, forkers, and a standards body. See
  [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`openspec/README.md`](openspec/README.md).
- **Open participation.** All changes to the protocol text, the reference
  implementation, and the site go through public pull requests under the
  Developer Certificate of Origin (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

## License

This repository uses a three-license split:

- **Code, packaged software, and generated artifacts** — Apache-2.0
  ([`LICENSE`](LICENSE), plus per-package `LICENSE` files such as
  `reference-implementation/LICENSE`).
- **Protocol specification text** (all root `spec-*.md` files and their
  mirrored site pages) — Community Specification License 1.0
  ([`LICENSE-specs`](LICENSE-specs)).
- **User-facing documentation prose** outside the specification — CC BY 4.0
  ([`LICENSE-docs`](LICENSE-docs)).

Third-party files carrying their own file-local license notice are governed by
that notice.
