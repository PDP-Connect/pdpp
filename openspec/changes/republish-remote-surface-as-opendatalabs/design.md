# Design — Republish Remote Surface As OpenDataLabs

## Context

`@pdpp/remote-surface` was extracted in two prior changes (`extract-remote-surface-substrate`, `extract-remote-surface-streaming-architecture`) and hardened for OSS shape by `make-remote-surface-oss-publishable`. Those changes deliberately deferred three decisions to the owner:

1. The public package identity.
2. The license file and license posture.
3. Whether the legacy reference-shaped server/lease APIs may continue to live in the default import path or must be quarantined behind an explicit subpath.

`/tmp/pdpp-remote-surface-oss-polish-plan.md` enumerates the remaining release blockers and groups them into worker-safe lanes (A1–A7), owner-decision lanes (B1–B6), human UX lanes (C), and local-automation lanes (D). The owner has now answered the identity, scoping, and license questions in this change's proposal:

- Identity → `@opendatalabs/remote-surface`. PDPP is one consumer; the substrate is reusable.
- Reference scope → PDPP/reference-only concepts (`_ref`, `run_id`, `interaction_id`) must not appear in the default external consumer surface; they move behind a clear `/reference` subpath.
- License → Apache-2.0 for code and reference implementations, CC-BY-4.0 for documentation. Community-Spec-1.0 is held in reserve for formal-spec artifacts and is not adopted by this change.

This change is the durable record of those decisions and the requirement deltas they imply. Implementation lanes are tracked in `tasks.md`; nothing is renamed or published from inside this change.

## Design Direction

### Package identity

- `package.json` `name` becomes `@opendatalabs/remote-surface`. The version stays `0.0.1` and `private: true` until release prep.
- README masthead, exports table, install snippet, and `Minimal Consumer Shape` example use `@opendatalabs/remote-surface` exclusively. The string `@pdpp/remote-surface` should not survive in README, `dist/**`, or generated declarations.
- In-repo importers (`apps/web`, `reference-implementation`, `packages/polyfill-connectors`, scripts under `packages/remote-surface/scripts/`) migrate to the new specifier. The legacy specifier is deleted from the workspace, not aliased — the prior name was an internal artifact, not a published contract.
- Tarball validator (`packages/remote-surface/scripts/validate-package.mjs`) compares `package.json#name` against `@opendatalabs/remote-surface` and fails closed if the name drifts back.

### Reference subpath isolation

The current `dist/server/`, `dist/protocol/`, `dist/leases/`, and `dist/testing/` paths ship `_ref`, `run_id`, and `interaction_id` symbols that exist solely to keep the PDPP reference runtime compiling. They are gated by an allowlist in `validate-package.mjs`, not removed. That is the right gate for now but the wrong default for a `@opendatalabs/*` package.

- A new `./reference` subpath is added to `exports`. `StreamingSessionStore`, `BrowserSurfaceLeaseManager` legacy fields, `reference-wire-fixtures`, and any other surface that contains `_ref` / `run_id` / `interaction_id` move to `src/reference/**`.
- Default `./server` exports re-shape to the host-neutral `SurfaceSessionStore` / `SurfaceLeaseManager` surface only. Any reference-runtime convenience is imported from `@opendatalabs/remote-surface/reference`.
- `validate-package.mjs` reference-token allowlist shrinks to `dist/reference/**`. A token appearing anywhere else is a build error.
- During the transition (one internal cycle), the `./server` entrypoint MAY re-export from `./reference` with `/** @deprecated use @opendatalabs/remote-surface/reference */` jsdoc. The owner decides the deprecation horizon (see Owner Decisions Still Needed).

### License posture

- `packages/remote-surface/LICENSE` is added with the Apache-2.0 text. `package.json#license` flips from `ISC` to `Apache-2.0`. `package.json#files` and the validator's `allowedPackageFilePatterns` both include `LICENSE`.
- `reference-implementation/LICENSE` mirrors Apache-2.0 (reference implementations follow the same license as the code packages).
- A documentation license file (`LICENSE-docs` at the repo root, CC-BY-4.0) covers `docs/**`, `design-notes/**`, and any user-facing prose that ships alongside the substrate. The package itself does not ship docs in the tarball; docs licensing protects the public site and the reference reading experience.
- Community-Spec-1.0 is NOT adopted by this change. If formal specifications become independent artifacts later (e.g. a Disclosure Spine spec, a Collection Profile spec), they MAY adopt Community-Spec-1.0 in a separate change. This change records the reservation only.

### Publish-readiness metadata

`package.json` gains the metadata required for a credible npm landing once the owner names the public repo and contact:

- `repository` (git URL of the public OpenDataLabs source of truth, once chosen).
- `bugs` (issue tracker URL).
- `homepage` (project landing or README anchor).
- `keywords` (descriptive — e.g. `remote-surface`, `browser`, `neko`, `cdp`, `streaming`, `clipboard`, `ime`).
- `publishConfig.access: "public"`.
- `publishConfig.provenance: true` (commented placeholder; depends on the publishing pipeline picked by `standardize-pdpp-package-publishing`).
- `engines.node` (commit to the Node major(s) PDPP supports — owner picks).

These fields are required to be present in the spec sense; the actual values are stubbed in code lanes once the owner answers.

### Sequencing

1. This change is accepted as the OpenSpec record of the rename + reference-subpath + license direction.
2. Worker lanes (A1 reference-subpath split, A2 LICENSE addition, A4 manifest metadata, plus a new rename lane) execute under `make-remote-surface-oss-publishable` and this change in concert.
3. `standardize-pdpp-package-publishing` lands; `scripts/check-package-release-policy.mjs` is taught about `@opendatalabs/remote-surface`.
4. Owner answers the four open questions below; metadata stubs are filled in.
5. Release prep flips `private: false` and publishes. Not in scope here.

## Alternatives Considered

- **Keep the `@pdpp/*` scope.** Rejected: it embeds a host-implementation name in the substrate's identity and would confuse non-PDPP consumers about the boundary. The whole point of the extraction work was to make the substrate host-agnostic.
- **Dual-publish under both scopes.** Rejected: doubles the surface area to maintain and forces every reference-compatibility decision to be made twice. The legacy name has never been published, so there is no installed-base obligation.
- **Move PDPP/reference adapters into a separate `@pdpp/remote-surface-reference` package.** Considered. Defer: the `/reference` subpath inside the same package is lighter, keeps the reference compatibility tests next to the substrate, and lets the boundary be enforced by validator instead of dependency graph. A second-package split MAY be revisited if reference-only code outgrows a single subpath.
- **Adopt MIT instead of Apache-2.0 for code.** Rejected by the owner direction; Apache-2.0 is preferred for the patent-grant posture in standards-adjacent infrastructure.
- **Adopt Community-Spec-1.0 in this change.** Rejected: no formal-spec artifact ships from this package today. Reserving the license for future formal specs avoids licensing prose that does not yet correspond to any artifact.

## Scope

In scope:

- Spec deltas to `reference-implementation-architecture` capturing the OpenDataLabs identity, reference-subpath isolation rule, license posture, and metadata gates.
- Co-sequencing notes against `make-remote-surface-oss-publishable` and `standardize-pdpp-package-publishing`.

Out of scope:

- Actually renaming files, editing `package.json`, moving source under `src/reference/`, or updating importers (worker lanes).
- Choosing the public OpenDataLabs repo URL, the security disclosure contact, the supported Node majors, or the deprecation horizon for legacy server-path reference re-exports (owner decisions).
- Publishing the package.
- Switching `private` from `true` to `false`.
- Documentation cookbook content beyond the README updates needed to advertise the new name and `/reference` subpath.
- Formal specification artifacts (Disclosure Spine, Collection Profile spec) — they get their own license/identity decisions later.

## Acceptance Checks

- `openspec validate republish-remote-surface-as-opendatalabs --strict` passes.
- `proposal.md`, `design.md`, and `tasks.md` exist; `specs/reference-implementation-architecture/spec.md` contains only `## ADDED Requirements` or `## MODIFIED Requirements` deltas (no task lists, no questions).
- Spec deltas explicitly name `@opendatalabs/remote-surface`, the `./reference` subpath, Apache-2.0 for code, and CC-BY-4.0 for docs.
- Owner-only follow-ups appear in `tasks.md` as flagged, unticked items so workers know not to invent answers.

## Owner Decisions Still Needed

1. **Public repo URL.** Confirms `repository`, `bugs`, `homepage` values and the `LICENSE` file copyright holder line.
2. **Security disclosure contact.** Blocks `SECURITY.md` and the README "Reporting vulnerabilities" section.
3. **Supported Node majors.** Drives `engines.node`.
4. **Reference-subpath deprecation horizon.** How long the `/server` re-export of `/reference` symbols survives (one internal cycle, two, indefinite).
5. **`reference-implementation/LICENSE` posture.** Confirm Apache-2.0 mirror (the proposal assumes yes; owner should sign off explicitly since the reference is more than just code).
6. **Community-Spec-1.0 reservation.** Confirm we are deferring formal-spec licensing rather than declining it. Affects future spec changes only.
