# Tasks: publish-reference-browser-image

## 1. CI Matrix

- [x] 1.1 Add `reference-browser` entry to the `validate` and `publish`
  matrices in `.github/workflows/docker-images.yml`, with dual
  `cache-from` scopes (`reference-browser` + `reference`) so the
  `~300 MB` browser layer is reused rather than rebuilt.
- [x] 1.2 Add `reference-browser` entry to the `validate-release-images`
  and `publish-images` matrices in `.github/workflows/semantic-release.yml`
  with the matching `-release`-suffixed cache scopes.

## 2. Operator-Facing Pointers

- [x] 2.1 Update the `docker-compose.yml` warning comment to name
  `ghcr.io/vana-com/pdpp/reference-browser:main` as the published image
  operators can set via `PDPP_REFERENCE_IMAGE`.
- [x] 2.2 Add a browser-connector callout in `deploy/docker/README.md`
  Production section.

## 3. Gates

- [x] 3.1 `git diff --check` — no whitespace errors.
- [x] 3.2 YAML review: `docker-images.yml` and `semantic-release.yml` job
  names, matrix entries, and cache directives are consistent with existing
  entries.
- [x] 3.3 `node --test scripts/check-railway-template-artifacts.test.mjs`
  — passes (no assertions reference the new image name; no regression).
- [x] 3.4 Owner triggers first publish via
  `gh workflow run docker-images.yml -f image=reference-browser`
  and verifies `docker exec pdpp-reference-1 ls /opt/patchright-browsers`
  shows `chromium_headless_shell-1217` (Patchright 1.59.4, amd64). Archived as
  a residual live check because GHCR package inspection requires package access.

## Acceptance Checks

- `pnpm railway:template:test` — passes.
- `git diff --check` — clean.
- `openspec validate publish-reference-browser-image --strict` — passes.
