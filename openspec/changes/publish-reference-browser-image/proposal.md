# Proposal: publish-reference-browser-image

## Why

The June-6 image-slimming change made the default `reference` image
browser-free (the `browsers` Dockerfile stage was retained but its output was
never wired into CI publication). Deployments that run browser-backed
connectors (ChatGPT, USAA, ...) inside the reference container hit a silent
hard failure at Patchright launch: "Executable doesn't exist at
`/opt/patchright-browsers/...`". The fix took four days to diagnose because
the image advertised no build-time signal that browsers were absent.

The `reference-browser` Dockerfile target exists and has always been
correct; it was simply never added to the CI publish matrix.

## What Changes

1. `docker-images.yml` — add `reference-browser` to the `validate` and
   `publish` job matrices, publishing
   `ghcr.io/vana-com/pdpp/reference-browser:<same tags>` on
   `workflow_dispatch` and tag pushes. Main-branch pushes only validate
   (same gating as every other image). Cache hint: pull from both the
   `reference-browser` scope and the `reference` scope so the shared base
   layers and the `~300 MB` browser layer survive across builds.

2. `semantic-release.yml` — add `reference-browser` to the
   `validate-release-images` and `publish-images` job matrices with the
   same scope-sharing cache strategy (scope suffix `-release`).

3. `docker-compose.yml` — update the warning comment to name the published
   image operators can set via `PDPP_REFERENCE_IMAGE`.

4. `deploy/docker/README.md` — add a visible note in the Production section
   explaining how to opt in to the browser-capable image.

## Non-Changes

- The `reference` image stays browser-free; no existing deployment is broken.
- Railway-core, Fly.io, and quickstart paths are unaffected.
- No new Dockerfile stages or changes to the `reference-browser` target itself.
- `.env.docker` and gitignored override files are not modified.
