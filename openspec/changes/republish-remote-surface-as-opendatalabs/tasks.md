# Tasks — Republish Remote Surface As OpenDataLabs

> **Worker safety.** Tasks 1–6 are mechanical and safe for worker lanes once this change is accepted. Tasks 7 are owner-only; do not invent answers. Validate the OpenSpec change at every step; do not begin code lanes before §0 is green.

## 0. OpenSpec Capture

- [x] 0.1 Author `proposal.md`, `design.md`, `tasks.md`, and `specs/reference-implementation-architecture/spec.md` for `republish-remote-surface-as-opendatalabs`.
- [x] 0.2 Run `openspec validate republish-remote-surface-as-opendatalabs --strict`; resolve any reported issues.
- [x] 0.3 Commit OpenSpec artifacts on the working branch; record the commit hash in the workstream report under `tmp/workstreams/`.

## 1. Package Identity Rename (worker lane, after §7.1)

- [x] 1.1 Set `packages/remote-surface/package.json#name` to `@opendatalabs/remote-surface`.
- [x] 1.2 Update README masthead, exports table, install snippet, and `Minimal Consumer Shape` example to use `@opendatalabs/remote-surface`.
- [x] 1.3 Migrate every in-repo importer of `@pdpp/remote-surface` (`apps/web`, `reference-implementation`, `packages/polyfill-connectors`, scripts) to the new specifier. Delete the legacy name; do not alias.
- [x] 1.4 Teach `packages/remote-surface/scripts/validate-package.mjs` to assert `package.json#name === "@opendatalabs/remote-surface"`.
- [x] 1.5 Run `pnpm --filter @opendatalabs/remote-surface verify`; commit when green. (Note: `verify`'s clean-consumer step hits a pre-existing pnpm 10.33 minimumReleaseAge supply-chain policy quirk in this local environment, independent of the rename; typecheck, lint, tests, build, npm pack, and packed-artifact boundary assertions all pass.)

## 2. Reference Subpath Split (worker lane)

- [ ] 2.1 Move `StreamingSessionStore` and its types from `src/server/streaming-session-store.ts` to `src/reference/streaming-session-store.ts`.
- [ ] 2.2 Move `BrowserSurfaceLeaseManager` legacy fields containing `_ref` / `run_id` / `interaction_id` to `src/reference/browser-surface-leases.ts`.
- [ ] 2.3 Move `reference-wire-fixtures.ts` from `src/testing/` to `src/reference/` (or its packed equivalent under `dist/reference/`); keep it in the `files` allowlist only via the `./reference` subpath.
- [ ] 2.4 Add `./reference` to `package.json#exports`; expose `types` + `import` for the moved surfaces.
- [ ] 2.5 In `src/server/index.ts`, re-export the moved symbols with `/** @deprecated use @opendatalabs/remote-surface/reference */` jsdoc for the deprecation horizon answered in §7.4.
- [ ] 2.6 Shrink the reference-token allowlist in `scripts/validate-package.mjs` so `_ref`, `run_id`, and `interaction_id` are only permitted under `dist/reference/**`. Any match outside that path fails the validator.
- [ ] 2.7 Run `pnpm --filter @opendatalabs/remote-surface verify`; commit when green.

## 3. License Files (worker lane — placeholder copyright holder permitted while `private: true`; final holder line gated on §7.5 before public publish)

- [x] 3.1 Add `packages/remote-surface/LICENSE` with the Apache-2.0 text. Until the owner confirms the final holder line in §7.5, use the placeholder `"Copyright [year] OpenDataLabs contributors"`. Replace with the final holder line before flipping `private: false`.
- [x] 3.2 Flip `packages/remote-surface/package.json#license` from `ISC` to `Apache-2.0`.
- [x] 3.3 Add `LICENSE` to `package.json#files` and to `allowedPackageFilePatterns` in `scripts/validate-package.mjs`.
- [x] 3.4 Add `reference-implementation/LICENSE` (Apache-2.0 mirror, same holder line as §3.1).
- [x] 3.5 Add repo-root `LICENSE-docs` containing the CC-BY-4.0 text; link it from `docs/` and `design-notes/` indexes so prose contributors see the license. (Note: link-from-indexes step is deferred to a docs lane; the file is present and referenced from the package README.)
- [x] 3.6 Confirm the packed tarball contains `LICENSE`; re-run `pnpm --filter @opendatalabs/remote-surface validate:package`. (`npm pack` output verified to contain `LICENSE` and `SECURITY.md`; see §1.5 note for the clean-consumer caveat.)

## 4. Publish-Readiness Metadata (worker lane — owner inputs resolved in §7)

- [x] 4.1 Fill in `packages/remote-surface/package.json` with the resolved owner values: `"repository": { "type": "git", "url": "git+https://github.com/vana-com/remote-surface.git" }`, `"bugs": { "url": "https://github.com/vana-com/remote-surface/issues" }`, `"homepage": "https://github.com/vana-com/remote-surface#readme"`.
- [x] 4.2 Add `keywords` (suggested seed: `remote-surface`, `browser`, `neko`, `cdp`, `streaming`, `clipboard`, `mobile-ime`, `webrtc`).
- [x] 4.3 Add `publishConfig.access: "public"`; add a commented `publishConfig.provenance: true` placeholder. (Implemented as `publishConfig.access: "public"` only; provenance posture is handled by `standardize-pdpp-package-publishing` and the JSON manifest cannot carry a comment, so the placeholder is deferred to that lane.)
- [x] 4.4 Add `"engines": { "node": ">=24" }` for the 2026 Active LTS line.
- [x] 4.5 Document the supported runtime contract (`Node >=24`, ESM-only, browser API surface) in the README "Supported runtime assumptions" paragraph.
- [x] 4.6 Add `SECURITY.md` and a README "Reporting vulnerabilities" paragraph that route security reports to `security@vana.org`.

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

## 7. Owner Decisions

### Resolved (worker lanes apply verbatim)

- [x] 7.1 Public repo URL → `https://github.com/vana-com/remote-surface`. Manifest values are spelled out in §4.1.
- [x] 7.2 Security disclosure contact → `security@vana.org`. §4.6 wires `SECURITY.md` and the README contact section.
- [x] 7.3 Supported Node major(s) → `engines.node: ">=24"` (2026 Active LTS line for this new package; rationale in design.md).
- [x] 7.6 `reference-implementation/LICENSE` is Apache-2.0 (mirror of package code license; collapsed into §3.4).
- [x] 7.7 Community-Spec-1.0 is reserved (not declined) for future formal-spec artifacts; recorded in the spec deltas.

### Deferred (release-management, MUST be answered before public npm publish; non-blocking for this change and for worker lanes §1–§6)

- [ ] 7.4 Reference-subpath deprecation horizon for the `./server` re-export of `./reference` symbols. Workers ship the `@deprecated` jsdoc immediately with a placeholder horizon ("removed in the first post-publish minor"); owner tightens the horizon during release prep.
- [ ] 7.5 Final `LICENSE` copyright holder line for `packages/remote-surface/LICENSE` and `reference-implementation/LICENSE`. While the package is `private: true`, workers MAY land Apache-2.0 boilerplate with a placeholder holder ("Copyright \[year] OpenDataLabs contributors"). An explicit, owner-accepted holder line MUST be in place before the `private: false` flip and the npm publish.

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
