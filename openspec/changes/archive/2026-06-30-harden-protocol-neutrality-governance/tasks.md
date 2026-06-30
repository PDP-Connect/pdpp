## 1. Spec Prose

- [x] Add vendor-neutrality and implementation-independence prose to Core introduction/conformance.
- [x] Add a concise Section Map for Core Sections 4 through 8.
- [x] Add a concise governance section with contribution workflow, active maintainer/editor records, spec-text license, and software-license posture.
- [x] Keep the site copy mirror of Core in sync.
- [x] Add active maintainer/editor records.
- [x] Align software package metadata to Apache-2.0.

## 2. Site And Example Cleanup

- [x] Replace stale `pdpp.vana.*` public-site metadata and examples with `pdpp.dev`.
- [x] Replace the stale `vana collect` CLI example with `pdpp collect`.

## 3. Validation

- [x] Run `openspec validate harden-protocol-neutrality-governance --strict`.
- [x] Run `pnpm spec:check`.
- [x] Run a site typecheck or nearest equivalent check for touched site files.
- [x] Grep affected files for stale domains and old CLI example text.
