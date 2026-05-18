## 1. Package Boundary

- [x] 1.1 Inventory current `@pdpp/remote-surface` package metadata, exports, build outputs, declaration generation, tarball contents, README, tests, and dependencies without editing app/runtime code.
- [x] 1.2 Define the intended public entrypoints and ensure they are represented through package `exports`, `types`, and compiled artifacts.
- [x] 1.3 Exclude private/raw source, package-local tests, fixtures, build caches, and internal audit artifacts from the published tarball unless a file is intentionally public.
- [x] 1.4 Ensure the tarball includes the intended README, license, package metadata, compiled JS, declarations, and any required runtime assets.
- [x] 1.5 Keep actual registry publication and the `private: false` package switch out of this implementation tranche; `private: true` may remain until release prep.

## 2. Dependency Hygiene

- [x] 2.1 Replace public package `workspace:*`, relative monorepo, or private dependency leakage with publishable semver dependencies or bundled/internalized code where appropriate.
- [x] 2.2 Add a package validation check that fails when public package metadata references unpublished workspace-only dependencies.
- [x] 2.3 Verify the packed package can install in a clean consumer fixture without the monorepo workspace.

## 3. Host-Neutral API

- [x] 3.1 Audit exported names, types, README examples, and packed declarations for PDPP-specific `_ref`, `run_id`, and `interaction_id` leakage.
- [ ] 3.2 Rename or wrap public API concepts so external consumers see host-neutral surface/session/prompt/action terminology.
- [ ] 3.3 Keep any PDPP reference adapter explicitly labeled as reference-only and outside the default external consumer path.
- [ ] 3.4 Add compatibility or migration notes where existing internal users need mapping from PDPP reference terms to host-neutral terms.

## 4. Server Store and Lease Neutralization

- [ ] 4.1 Redesign server store interfaces around host-owned persistence and lifecycle concepts rather than PDPP runtime rows or `_ref` endpoints.
- [ ] 4.2 Redesign lease APIs around generic surface/session acquisition, renewal, release, cancellation, and expiry semantics.
- [ ] 4.3 Ensure hosts can provide authorization, routing, persistence, and process lifecycle without importing PDPP reference runtime code.
- [ ] 4.4 Add package-local tests that exercise the store and lease contracts through a non-PDPP host fixture.

## 5. README and External Consumer Story

- [x] 5.1 Update the README enough for an external consumer to understand the intended npm package boundary, public entrypoints, host responsibilities, and current pre-release status.
- [ ] 5.2 Document minimal installation shape, minimal client usage, minimal server host integration, lifecycle, store/lease adapter contracts, and supported runtime assumptions without requiring polished launch prose.
- [x] 5.3 Mark PDPP reference integration as an adapter/example rather than the default public contract.
- [x] 5.4 Defer fully polished docs, cookbook examples, and exhaustive executable documentation validation to release prep unless a minimal example is needed to prove the package contract.

## 6. Publication and CI Checks

- [x] 6.1 Add tarball hygiene validation that compares packed files against an allowlist or explicit denylist.
- [x] 6.2 Add declaration validation for every exported entrypoint.
- [x] 6.3 Add clean-consumer install/import/typecheck validation from the packed artifact.
- [ ] 6.4 Add CI gating for package tests, lint/typecheck, dependency leakage, host-neutral artifact scans, clean-consumer validation, and publication dry run.
- [x] 6.5 Define the release-prep command path and document how maintainers run a dry run before publishing without requiring the publish command to run in this change.
- [x] 6.6 Add an explicit release-prep follow-up for flipping `private: false`, final registry metadata, polished docs/examples, and actual publication.

## 7. Acceptance Checks

- [x] 7.1 Run package-local tests for `@pdpp/remote-surface`.
- [x] 7.2 Run package typecheck and declaration validation.
- [x] 7.3 Run tarball inspection and dependency leakage checks.
- [x] 7.4 Run clean external consumer install/import/typecheck from the packed artifact.
- [x] 7.5 Grep packed public artifacts for `_ref`, `run_id`, `interaction_id`, `workspace:`, and private package names; read any matches before reporting completion.
- [x] 7.6 Confirm `private: true` remains allowed until release prep and no task treats actual npm publication as required for this change.
- [x] 7.7 Run relevant CI-equivalent checks.
- [x] 7.8 Run `openspec validate make-remote-surface-oss-publishable --strict`.
- [ ] 7.9 Run `openspec validate --all --strict`.
