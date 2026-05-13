## Context

`@pdpp/remote-surface` should be shaped so OSS users who do not run the PDPP reference app or understand the reference `_ref` control plane can consume it after release prep. This change targets an almost push-button publishable architecture/package shape: installable from a packed artifact, typed, hygienic, host-neutral, and backed by release-readiness checks.

This change uses the read-only audit findings as input. It intentionally creates only OpenSpec artifacts; implementation must happen in a later coding tranche. It does not require publishing now, does not require flipping to `private: false`, and does not require fully polished launch docs/examples before release prep.

## Design Direction

The package boundary should be treated as the product. Source layout may remain convenient for maintainers, but the release-ready package shape must expose a narrow compiled API with declarations and clean dependency metadata. Consumers should not need a monorepo checkout, workspace protocol support, unpublished sibling packages, or PDPP app/runtime routes to evaluate the packed artifact.

The public API should translate reference-specific runtime concepts into host-neutral terms:

- `_ref` becomes an internal/reference host implementation detail, not a public remote-surface concept.
- `run_id` becomes a host-provided session or surface-instance identifier when needed.
- `interaction_id` becomes a host-provided prompt/action/request identifier when needed.
- Lease and store APIs describe surface/session lifecycle and persistence contracts rather than PDPP runtime rows or endpoint names.

Server-side APIs should be inversion-friendly. The package can provide interfaces, adapters, and validation helpers, but the host owns routing, authorization, persistence, and process lifecycle. Any PDPP-specific adapter must be explicitly labeled as reference-only and kept out of the default external consumer path.

## Package Quality Bar

Almost push-button publishability means a reviewer can install the package from its tarball and prove the public architecture without relying on hidden monorepo state. The implementation should add checks that answer:

- Does `npm pack --dry-run` include only intended publish artifacts?
- Are compiled JS, type declarations, source maps if intended, README, license, and package metadata present?
- Are raw private source, tests, fixtures, build caches, and internal audit artifacts absent unless deliberately public?
- Are all dependencies publishable semver dependencies rather than `workspace:*`, relative monorepo paths, or private package names?
- Do exported entrypoints load under the supported Node/module modes?
- Do TypeScript consumers receive declarations for every exported API?
- Does the package expose enough README guidance for an external reviewer to understand install shape, public entrypoints, and host integration responsibilities?
- Are polished docs, executable cookbook examples, registry metadata finalization, and `private: false` explicitly left for release preparation?

## Alternatives Considered

- Keep `@pdpp/remote-surface` permanently internal and publish the whole reference app instead. Rejected because the audit target is a genuinely standalone OSS package and external consumers should not inherit PDPP reference runtime coupling.
- Publish raw TypeScript source and ask consumers to compile. Rejected because it pushes repo-specific build assumptions and declaration generation onto consumers.
- Preserve PDPP names in the public API and explain them in README. Rejected because that makes the package look like a PDPP-only runtime component rather than a reusable remote-surface library.
- Fully prepare and publish the npm package in this change. Rejected because the user clarified that actual publication, the `private: false` switch, and polished launch documentation should wait for release prep.

## Scope

In scope:

- Package metadata, exports, build output, declarations, tarball contents, dependency hygiene, package-local tests, README, and publication checks.
- Host-neutral naming and API contracts for store, lease, surface/session lifecycle, and interaction/prompt flow.
- CI gates that validate the packed package, declarations, dependency hygiene, host-neutral public artifacts, and dry-run publication readiness.
- Minimal README updates needed to make the package boundary and external host responsibilities understandable.

Out of scope:

- Editing app/runtime code in this OpenSpec-only change.
- Changing PDPP protocol semantics.
- Creating a new hosted remote-surface service.
- Publishing the package to a registry.
- Flipping package metadata from `private: true` to `private: false`.
- Producing fully polished launch docs, cookbook examples, or marketing-ready README content.
- Archiving this change before implementation and owner acceptance.

## Acceptance Checks

- `openspec validate make-remote-surface-oss-publishable --strict`
- Package implementation later proves `npm pack --dry-run` or equivalent tarball inspection against an allowlist.
- Package implementation later proves external install/typecheck/import in a clean consumer fixture.
- Package implementation later proves no `workspace:*`, private package, `_ref`, `run_id`, or `interaction_id` leakage in public package artifacts except explicitly allowed reference-only adapter docs/tests.
- Package implementation later keeps actual registry publication and `private: false` as release-prep steps rather than acceptance criteria for this change.
