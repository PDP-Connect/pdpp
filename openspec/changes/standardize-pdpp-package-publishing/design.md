## Context

`@pdpp/cli` is already published on npm. CI logs show the beta publication path
uses semantic-release with GitHub Actions OIDC and npm trusted publishing, not a
checked-in `NPM_TOKEN`. `@pdpp/local-collector` is ready to follow the same
release train, but it still needs first-package bootstrap/trust setup on the npm
side.

The release policy should optimize for good construction, not feature
accumulation: one release train, one authentication posture, one package
manifest contract, and one machine-checkable gate.

## Decisions

1. Use one lockstep monorepo version stream for publishable PDPP packages.

   `semantic-release` computes one repository version from Conventional
   Commits. Publishable package manifests keep `version: "0.0.0"` in git, and
   `@semantic-release/npm` writes the release version during CI publication.
   This avoids premature independent-versioning complexity while PDPP has a
   small set of tightly coupled packages.

   Counterargument: independent package versions would reduce noisy releases.
   Response: that is real, but not yet worth the operational complexity. The
   current package set is small and related; release notes already use
   Conventional Commit scopes for package-specific readability.

2. Use npm trusted publishing as the normal path.

   The release workflow grants `id-token: write` and lets
   `@semantic-release/npm` exchange the GitHub OIDC token with npm. The workflow
   must not use `NPM_TOKEN` or `NODE_AUTH_TOKEN` for normal publication.

   Counterargument: a classic automation token is easier to reason about.
   Response: long-lived publish tokens are exactly the avoidable secret surface
   trusted publishing removes. Token use remains allowed only for temporary
   owner-controlled bootstrap or emergency recovery.

3. Treat first package creation as an owner gate, not a CI invariant.

   npm package trust configuration is package-specific. A package that does not
   exist yet may need one owner-controlled bootstrap publish before trusted
   publishing can be configured. That bootstrap does not change the normal
   release policy.

   `@pdpp/cli` already proved the path, but that npm trust setup does not
   automatically cover `@pdpp/local-collector` or future packages.

4. Keep provenance disabled while the source repo is private.

   The manifests keep `publishConfig.provenance: false` while `vana-com/pdpp`
   is private. When the repository is public, provenance should be re-enabled
   as a separate release-hardening change.

5. Keep beta-to-stable promotion explicit.

   The current release train publishes prereleases from `beta`. Promotion to
   stable `latest` publication requires a separate release-readiness decision:
   docs/metadata must stop presenting the packages as beta, the npm packages
   must already be installable from beta, trusted publishing must be configured
   per public package, and provenance should be re-enabled once the source
   repository is public.

6. Enforce the policy with a checker in CI.

   Documentation is not enough. `pnpm release:policy-check` verifies the root is
   private, publishable package roots match `.releaserc.yaml`, publishable
   manifests have the required package metadata, every other package manifest
   is explicitly private and does not declare `publishConfig`, and the
   semantic-release workflow does not depend on npm tokens.

## Alternatives Considered

- **Independent package versions now.** More precise, but it requires a release
  orchestration layer we do not yet need and would complicate existing
  semantic-release behavior.
- **NPM_TOKEN in GitHub secrets.** Operationally familiar, but inferior to
  trusted publishing for normal CI releases.
- **Documentation-only policy.** Easier to land, but too easy to violate during
  future package extraction.

## Acceptance Checks

- `pnpm release:policy-check`
- `openspec validate standardize-pdpp-package-publishing --strict`
- `openspec validate publish-pdpp-local-collector --strict`
- Relevant package verifies continue to pass for publishable packages.
