# Remote Surface Public Release Plan

Status: release-prep checklist
Owner: reference implementation owner
Created: 2026-05-21
Related: `openspec/changes/extract-remote-surface-substrate`, `openspec/changes/extract-remote-surface-streaming-architecture`, `openspec/changes/make-remote-surface-oss-publishable`

## Scope

`@pdpp/remote-surface` is extracted far enough to be treated as an OSS-candidate package boundary, but this document is not authorization to publish it.

The release-prep work may proceed without changing package semantics:

- Verify the package exports, declarations, tarball contents, clean-consumer install, and host-neutral README.
- Keep `private: true` until an explicit release gate.
- Keep PDPP reference routes, auth, run timelines, Docker/n.eko allocation, and connector handoff owned by the reference implementation.
- Treat n.eko/CDP backend adapters as backend contracts and reference-compatible implementations, not as a public control plane requirement.

## Current State

- `packages/remote-surface/package.json` has an explicit package boundary, export map, declaration output, and narrow file list.
- OpenSpec extraction changes are task-complete for the substrate, streaming architecture, and package publishability tranches.
- The README explains the host/package split, public exports, backend adapters, mobile IME helpers, and validation commands.
- Packed artifact checks already treat `_ref`, `run_id`, `interaction_id`, `workspace:`, and private package names as leakage signals that must be read before declaring completion.
- The package still has `private: true`, which is intentional until the owner approves package name, license, support posture, version, registry, and publish timing.

## Preflight Gates

Run these before preparing a release candidate:

```bash
pnpm --filter @pdpp/remote-surface verify
pnpm --dir packages/remote-surface pack --dry-run
pnpm --filter @pdpp/remote-surface run validate:package
openspec validate extract-remote-surface-substrate --strict
openspec validate extract-remote-surface-streaming-architecture --strict
openspec validate make-remote-surface-oss-publishable --strict
```

The package is not release-prep-ready unless all package-local checks pass and any full-suite failures are explicitly proven unrelated to the package boundary.

## Release-Candidate Gates

Before flipping `private: true` or publishing:

- Install the packed tarball in a clean external consumer.
- Import every documented export from the clean consumer.
- Typecheck the clean consumer against package declarations.
- Confirm there are no runtime `workspace:*` dependencies.
- Confirm the tarball contains only intended files: package metadata, README, license if present, compiled JS, declarations, and intentional runtime assets.
- Read every packed match for `_ref`, `run_id`, `interaction_id`, `PDPP`, `n.eko`, and `CDP`; accept only explicit boundary documentation or reference-compatible adapter notes.
- Confirm README examples describe host-owned routing, authorization, persistence, lifecycle, and process ownership without implying PDPP-specific infrastructure is required.
- Draft release notes that distinguish implemented exports from known limitations.

## Owner Release Gate

These decisions require owner approval and are not delegated:

- Whether to publish now, delay, or keep internal.
- Final package name and npm scope.
- License.
- Version and dist-tag.
- Registry.
- Support/security posture.
- Whether public examples may mention PDPP, n.eko, CDP, or reference app internals as story elements.
- Whether to flip `private: true` to `private: false`.

## Publication Gate

If owner approval is granted:

1. Create a release-candidate branch from a clean `origin/main`.
2. Flip `private` only in the release-candidate branch.
3. Re-run all preflight and release-candidate gates.
4. Publish through the same release mechanism approved for the package.
5. Verify npm install from a fresh project after publish.
6. Verify the package page metadata, dist-tag, and provenance/security posture.

## Rollback Gate

If a bad package is published:

- Deprecate the affected version with a precise reason.
- Publish a fixed version rather than deleting history, unless npm policy and incident severity require removal.
- Keep a release incident note with the package version, commit, registry action, observed failure, and remediation.
- Re-run clean-consumer validation before announcing recovery.

## Not In This Plan

- Publishing the package.
- Renaming the package.
- Changing license.
- Changing public API semantics.
- Moving reference-owned Docker/n.eko allocation into the package.
- Presenting the reference implementation's `_ref` routes or run timelines as public package contracts.
