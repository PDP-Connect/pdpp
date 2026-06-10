# Tasks: adopt-single-release-channel

## 1. Release configuration

- [x] 1.1 `.releaserc.yaml` releases from `main` only (no prerelease branch).
- [x] 1.2 `semantic-release.yml` triggers on push to `main` + `workflow_dispatch`; ref conditionals updated; concurrency and browser-download skips kept.
- [x] 1.3 Docker image tags publish `latest` instead of `beta` (validate + publish jobs).
- [x] 1.4 Version continuity: lane carries `git merge -s ours beta` so `v0.0.0` is reachable from `main`; next release computes `0.1.0` (graduation), no tag collision.

## 2. Retire beta machinery

- [x] 2.1 Delete `.github/workflows/beta-cadence.yml`.
- [x] 2.2 Delete `scripts/check-beta-cadence.mjs` and `scripts/check-beta-cadence.test.mjs`.
- [x] 2.3 Remove `release:cadence-check` / `release:cadence-check:test` scripts and their workflow step.

## 3. Policy and guards

- [x] 3.1 `publishConfig.tag` flips to `latest` in all three publishable packages; policy check enforces it.
- [x] 3.2 Doc-tag guard inverted: active install docs must NOT reference the retired `@beta` dist-tag.
- [x] 3.3 Policy check asserts single-channel shape (`.releaserc.yaml` has no prerelease/beta branch; workflow triggers on `main`).
- [x] 3.4 `check-dist-tag-posture.mjs` reframed for the transition window (placeholder `latest` until first stable release).

## 4. Surface sweep (`@beta` → plain)

- [x] 4.1 `packages/cli/src/package-info.js` (+ `.d.ts`): `PDPP_CLI_PACKAGE_SPECIFIER` = plain name, `versionPolicy: "latest"` (feeds AS discovery metadata `pdpp_agent_discovery.cli`).
- [x] 4.2 Console/site/operator-ui command libraries and dashboard surfaces.
- [x] 4.3 CLI help text, local-collector bin + committed dist remediation text.
- [x] 4.4 Docs: README, package READMEs, docs/, reference-implementation docs, site content, agent skills.
- [x] 4.5 Owner-journey harness manifest + scanner expectations updated; suites green.

## 5. Owner steps (after the first `main` release proves out)

- [ ] 5.1 Verify the first `main` release published 0.1.0 to `latest` for all three packages (`pnpm release:dist-tag-check` reports OK).
- [ ] 5.2 Deprecate the `0.0.0` bootstrap placeholders (`npm deprecate @pdpp/<pkg>@0.0.0 ...`).
- [ ] 5.3 Retire or repoint the npm `beta` dist-tag (`npm dist-tag rm <pkg> beta`).
- [ ] 5.4 Delete the `beta` git branch.
- [ ] 5.5 Configure npm trusted publishing for `@pdpp/mcp-server` if not already done (first publish gate, unrelated to channel).
