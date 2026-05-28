## Why

`reconcile-root-and-web-spec-trees` made root `spec-*.md` files canonical and required an automated drift gate, but explicitly deferred the implementation. Without that gate, root and web docs can continue to diverge silently.

## What Changes

- Add `pnpm spec:check` to compare canonical root specs with their web docs counterparts after normalising publication-only differences.
- Wire `spec:check` into pre-commit and CI.
- Encode the approved web-only extension allowlist.
- Reconcile the existing root/web docs corpus enough for the check to pass.
- Document the Status/Date callout pattern for web docs contributors.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-governance`: implements the root/web spec drift-check gate required by `reconcile-root-and-web-spec-trees`.

## Impact

- Root `spec-*.md` files and `apps/web/content/docs/spec-*.md` publication copies.
- `package.json` / workspace scripts.
- Lefthook and CI configuration.
- A new spec-check script under repo tooling.
