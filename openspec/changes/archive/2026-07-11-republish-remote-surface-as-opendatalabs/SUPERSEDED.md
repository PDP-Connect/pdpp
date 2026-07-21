# Superseded

This change is **superseded**, not completed as written.

## What this change proposed

Publish the in-monorepo `packages/remote-surface` package to npm as
`@opendatalabs/remote-surface` — flipping `private: false`, wiring it into the
monorepo's `scripts/check-package-release-policy.mjs`, carrying its `LICENSE`
inside the monorepo, and releasing it from the PDPP repo. The 8 remaining open
tasks (§4.3, §5.1, §7.4, §7.5, §8.1–8.4) all describe that publish-from-monorepo
path.

## What actually happened

Remote-surface was **extracted into its own repository** (`vana-com/remote-surface`)
and now publishes itself to npm from there via its own semantic-release CI. The
in-monorepo `packages/remote-surface` copy was **deleted** from PDPP in
`6bce99a0f fix(build): remove retired remote-surface workspace copy (#298)`
(2026-07-11). PDPP now consumes `@opendatalabs/remote-surface` as an ordinary
published dependency (`apps/console` depends on `^0.4.0`).

So the *goal* — remote-surface is a standalone, public `@opendatalabs/remote-surface`
package that PDPP consumes — was achieved, but by a cleaner route than this change
described. The remaining open tasks are obsolete: there is no in-monorepo package
manifest to flip, no monorepo `packages/remote-surface/LICENSE`, and no monorepo
release-policy entry to add, because the package no longer lives here.

## Where the truth now lives

- Durable spec: `openspec/specs/reference-implementation-architecture/spec.md`
  (the "Remote surface package SHALL remain a standalone published dependency"
  requirement and neighbors) was reconciled to describe remote-surface as an
  external published dependency PDPP consumes.
- The package's own publication, license, and release policy are owned by the
  `vana-com/remote-surface` repository, not PDPP.
