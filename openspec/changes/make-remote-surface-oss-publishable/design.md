## Context

`@pdpp/remote-surface` should be consumable by OSS users who do not run the PDPP reference app or understand the reference `_ref` control plane. A package at 95%+ SLVP quality must be installable, typed, documented, testable from the packed artifact, and honest about its public host integration contract.

This change uses the read-only audit findings as input. It intentionally creates only OpenSpec artifacts; implementation must happen in a later coding tranche.

## Design Direction

The package boundary should be treated as the product. Source layout may remain convenient for maintainers, but the published package must expose a narrow compiled API with declarations and clean dependency metadata. Consumers should not need a monorepo checkout, workspace protocol support, unpublished sibling packages, or PDPP app/runtime routes to evaluate the package.

The public API should translate reference-specific runtime concepts into host-neutral terms:

- `_ref` becomes an internal/reference host implementation detail, not a public remote-surface concept.
- `run_id` becomes a host-provided session or surface-instance identifier when needed.
- `interaction_id` becomes a host-provided prompt/action/request identifier when needed.
- Lease and store APIs describe surface/session lifecycle and persistence contracts rather than PDPP runtime rows or endpoint names.

Server-side APIs should be inversion-friendly. The package can provide interfaces, adapters, and validation helpers, but the host owns routing, authorization, persistence, and process lifecycle. Any PDPP-specific adapter must be explicitly labeled as reference-only and kept out of the default external consumer path.

## Package Quality Bar

SLVP readiness means a reviewer can install the package from its tarball and prove the public story without relying on hidden monorepo state. The implementation should add checks that answer:

- Does `npm pack --dry-run` include only intended publish artifacts?
- Are compiled JS, type declarations, source maps if intended, README, license, and package metadata present?
- Are raw private source, tests, fixtures, build caches, and internal audit artifacts absent unless deliberately public?
- Are all dependencies publishable semver dependencies rather than `workspace:*`, relative monorepo paths, or private package names?
- Do exported entrypoints load under the supported Node/module modes?
- Do TypeScript consumers receive declarations for every exported API?
- Do README examples typecheck or execute in a package-consumer fixture?

## Alternatives Considered

- Keep `@pdpp/remote-surface` internal and publish the whole reference app instead. Rejected because the audit target is a genuinely standalone OSS package and external consumers should not inherit PDPP reference runtime coupling.
- Publish raw TypeScript source and ask consumers to compile. Rejected because it pushes repo-specific build assumptions and declaration generation onto consumers.
- Preserve PDPP names in the public API and explain them in README. Rejected because that makes the package look like a PDPP-only runtime component rather than a reusable remote-surface library.

## Scope

In scope:

- Package metadata, exports, build output, declarations, tarball contents, dependency hygiene, package-local tests, README, and publication checks.
- Host-neutral naming and API contracts for store, lease, surface/session lifecycle, and interaction/prompt flow.
- CI gates that validate the packed package and documentation examples.

Out of scope:

- Editing app/runtime code in this OpenSpec-only change.
- Changing PDPP protocol semantics.
- Creating a new hosted remote-surface service.
- Archiving this change before implementation and owner acceptance.

## Acceptance Checks

- `openspec validate make-remote-surface-oss-publishable --strict`
- Package implementation later proves `npm pack --dry-run` or equivalent tarball inspection against an allowlist.
- Package implementation later proves external install/typecheck/import in a clean consumer fixture.
- Package implementation later proves no `workspace:*`, private package, `_ref`, `run_id`, or `interaction_id` leakage in public package artifacts except explicitly allowed reference-only adapter docs/tests.
