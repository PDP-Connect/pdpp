# Tasks — Republish Remote Surface As OpenDataLabs

> **Worker safety.** Tasks 1–6 are mechanical and safe for worker lanes once this change is accepted. Tasks 7 are owner-only; do not invent answers. Validate the OpenSpec change at every step; do not begin code lanes before §0 is green.

## 0. OpenSpec Capture

- [ ] 0.1 Author `proposal.md`, `design.md`, `tasks.md`, and `specs/reference-implementation-architecture/spec.md` for `republish-remote-surface-as-opendatalabs`.
- [ ] 0.2 Run `openspec validate republish-remote-surface-as-opendatalabs --strict`; resolve any reported issues.
- [ ] 0.3 Commit OpenSpec artifacts on the working branch; record the commit hash in the workstream report under `tmp/workstreams/`.

## 1. Package Identity Rename (worker lane, after §7.1)

- [ ] 1.1 Set `packages/remote-surface/package.json#name` to `@opendatalabs/remote-surface`.
- [ ] 1.2 Update README masthead, exports table, install snippet, and `Minimal Consumer Shape` example to use `@opendatalabs/remote-surface`.
- [ ] 1.3 Migrate every in-repo importer of `@pdpp/remote-surface` (`apps/web`, `reference-implementation`, `packages/polyfill-connectors`, scripts) to the new specifier. Delete the legacy name; do not alias.
- [ ] 1.4 Teach `packages/remote-surface/scripts/validate-package.mjs` to assert `package.json#name === "@opendatalabs/remote-surface"`.
- [ ] 1.5 Run `pnpm --filter @opendatalabs/remote-surface verify`; commit when green.

## 2. Reference Subpath Split (worker lane)

- [ ] 2.1 Move `StreamingSessionStore` and its types from `src/server/streaming-session-store.ts` to `src/reference/streaming-session-store.ts`.
- [ ] 2.2 Move `BrowserSurfaceLeaseManager` legacy fields containing `_ref` / `run_id` / `interaction_id` to `src/reference/browser-surface-leases.ts`.
- [ ] 2.3 Move `reference-wire-fixtures.ts` from `src/testing/` to `src/reference/` (or its packed equivalent under `dist/reference/`); keep it in the `files` allowlist only via the `./reference` subpath.
- [ ] 2.4 Add `./reference` to `package.json#exports`; expose `types` + `import` for the moved surfaces.
- [ ] 2.5 In `src/server/index.ts`, re-export the moved symbols with `/** @deprecated use @opendatalabs/remote-surface/reference */` jsdoc for the deprecation horizon answered in §7.4.
- [ ] 2.6 Shrink the reference-token allowlist in `scripts/validate-package.mjs` so `_ref`, `run_id`, and `interaction_id` are only permitted under `dist/reference/**`. Any match outside that path fails the validator.
- [ ] 2.7 Run `pnpm --filter @opendatalabs/remote-surface verify`; commit when green.

## 3. License Files (worker lane, after §7.5)

- [ ] 3.1 Add `packages/remote-surface/LICENSE` with the Apache-2.0 text and the copyright line confirmed in §7.5.
- [ ] 3.2 Flip `packages/remote-surface/package.json#license` from `ISC` to `Apache-2.0`.
- [ ] 3.3 Add `LICENSE` to `package.json#files` and to `allowedPackageFilePatterns` in `scripts/validate-package.mjs`.
- [ ] 3.4 Add `reference-implementation/LICENSE` (Apache-2.0 mirror).
- [ ] 3.5 Add repo-root `LICENSE-docs` containing the CC-BY-4.0 text; link it from `docs/` and `design-notes/` indexes so prose contributors see the license.
- [ ] 3.6 Confirm the packed tarball contains `LICENSE`; re-run `pnpm --filter @opendatalabs/remote-surface validate:package`.

## 4. Publish-Readiness Metadata (worker lane, after §7.1, §7.2, §7.3)

- [ ] 4.1 Fill in `repository`, `bugs`, `homepage` in `packages/remote-surface/package.json` using the values from §7.1.
- [ ] 4.2 Add `keywords` (suggested seed: `remote-surface`, `browser`, `neko`, `cdp`, `streaming`, `clipboard`, `mobile-ime`, `webrtc`).
- [ ] 4.3 Add `publishConfig.access: "public"`; add a commented `publishConfig.provenance: true` placeholder.
- [ ] 4.4 Add `engines.node` using the major(s) from §7.3.
- [ ] 4.5 Document the supported runtime contract (Node major, ESM-only, browser API surface) in the README "Supported runtime assumptions" paragraph.

## 5. Release-Policy Wiring (worker lane, gated on `standardize-pdpp-package-publishing`)

- [ ] 5.1 After `standardize-pdpp-package-publishing` lands, add `@opendatalabs/remote-surface` to `scripts/check-package-release-policy.mjs` so it is gated by the same `0.0.0` / OIDC / provenance rules as the rest of the publishable packages.
- [ ] 5.2 Add a CI step (or extend the existing one) that runs `pnpm --filter @opendatalabs/remote-surface verify` against every PR.

## 6. Acceptance Checks (local automation)

- [ ] 6.1 `openspec validate republish-remote-surface-as-opendatalabs --strict` passes.
- [ ] 6.2 `openspec validate --all --strict` passes (no collateral damage to sibling changes).
- [ ] 6.3 After §1, repo grep for `@pdpp/remote-surface` returns zero matches outside this change's artifacts and the archived prior changes.
- [ ] 6.4 After §2, `dist/server/**`, `dist/protocol/**`, `dist/leases/**`, `dist/testing/**` are scanned for `_ref`, `run_id`, `interaction_id`; zero matches.
- [ ] 6.5 After §3, `npm pack` output for the package contains `LICENSE`.
- [ ] 6.6 After §4, `package.json` round-trips through validator with `repository`, `bugs`, `homepage`, `keywords`, `publishConfig.access`, and `engines.node` set to concrete values.

## 7. Owner Decisions (not for workers)

- [ ] 7.1 Public repo URL for `@opendatalabs/remote-surface` (used in `repository`, `bugs`, `homepage`).
- [ ] 7.2 Security disclosure contact (drives `SECURITY.md` + README contact section).
- [ ] 7.3 Supported Node major(s) (drives `engines.node`).
- [ ] 7.4 Deprecation horizon for the `./server` re-export of `./reference` symbols (one internal cycle, two, or indefinite).
- [ ] 7.5 Copyright holder line for `LICENSE` and `reference-implementation/LICENSE` (e.g. "Copyright 2026 OpenDataLabs" or a personal name).
- [ ] 7.6 Confirm `reference-implementation/LICENSE` is Apache-2.0 (the design assumes yes).
- [ ] 7.7 Confirm Community-Spec-1.0 is reserved (not declined) for future formal-spec artifacts.

## Acceptance checks

Reproducible verification:

```sh
cd <repo-root>
openspec validate republish-remote-surface-as-opendatalabs --strict
openspec validate --all --strict
# After §1 and §2 lanes execute (separate change-acceptance step):
rg -n "@pdpp/remote-surface" --glob '!openspec/changes/archive/**'   # expect zero hits
rg -n "_ref|run_id|interaction_id" packages/remote-surface/dist --glob '!dist/reference/**'  # expect zero hits
pnpm --filter @opendatalabs/remote-surface verify
```
