## Why

The reference implementation is now strong enough that the biggest remaining risk is drift at the boundaries: legacy web bridges can still teach connector-only or demo-shaped flows, and the native provider path can still leak connector semantics if the public contract is not kept source-first. This change keeps the reference forkable and truthful while the implementation continues to evolve, while leaving normative PDPP protocol semantics in the root spec files such as `spec-core.md`, `spec-auth-design.md`, and `spec-collection-profile.md`.

## What Changes

- Align the website bridge routes with the current reference contract instead of baking in connector-only assumptions.
- Continue hardening the native provider public boundary so native requests, grants, timelines, and owner access stay provider/source-first.
- Expand CLI and black-box tests around the current primary surfaces so future drift is caught quickly.
- Consolidate active execution planning into OpenSpec and stop relying on ad hoc inbox memos as the steering layer.

## Capabilities

### New Capabilities
- `reference-web-bridge-contract`: defines how `apps/web` may bridge into the reference implementation without teaching removed or non-primary contract surfaces.
- `reference-native-provider-boundary`: defines the public/native-vs-polyfill boundary the reference implementation must preserve.

### Modified Capabilities
- `reference-implementation-governance`: active execution planning for this work moves into OpenSpec-backed changes rather than new inbox memos.

## Impact

- `apps/web/src/app/api/*` bridge routes and the legacy demo shell
- `reference-implementation/server/*`, `reference-implementation/cli/*`, and `reference-implementation/test/*` where native/provider surfaces are enforced and proven
- `openspec/specs/reference-implementation-governance/spec.md`
- root PDPP spec files remain the normative source for protocol semantics referenced by this change
- active implementation planning for the reference implementation program
