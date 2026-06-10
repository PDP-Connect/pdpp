# reference-implementation-architecture (delta)

## ADDED Requirements

### Requirement: A published browser-capable reference image SHALL be available for in-container browser-backed connectors

CI SHALL build and publish `ghcr.io/vana-com/pdpp/reference-browser` from the
`reference-browser` Dockerfile target alongside every `reference` image
publication. The `reference-browser` image extends the `browsers` stage and
SHALL contain a working Patchright installation at
`PLAYWRIGHT_BROWSERS_PATH=/opt/patchright-browsers` so that browser-backed
connectors (ChatGPT, USAA, ...) can launch without a separate browser install
step when running collection inside the reference container.

The default `reference` image SHALL remain browser-free. Operators who run
browser-backed connectors inside the reference container SHALL opt in by setting
`PDPP_REFERENCE_IMAGE=ghcr.io/vana-com/pdpp/reference-browser:<tag>`.

#### Scenario: Browser-capable image contains Patchright browsers at the standard path

- **WHEN** an operator pulls `ghcr.io/vana-com/pdpp/reference-browser:main`
  and runs `docker exec <container> ls $PLAYWRIGHT_BROWSERS_PATH`
- **THEN** the output SHALL include a `chromium_headless_shell-*` directory
  corresponding to the pinned Patchright version

#### Scenario: Browser-capable image is published on the same tag schedule as the reference image

- **WHEN** a workflow dispatch or version tag triggers publication of
  `ghcr.io/vana-com/pdpp/reference:main`
- **THEN** `ghcr.io/vana-com/pdpp/reference-browser` SHALL receive the same
  `:main`, `:sha-*`, and version tags in the same CI run

#### Scenario: Default reference image remains browser-free

- **WHEN** an operator pulls the default `ghcr.io/vana-com/pdpp/reference:main`
  and runs `docker exec <container> ls /opt/patchright-browsers`
- **THEN** the directory SHALL NOT contain any browser binaries
- **AND** the image startup SHALL NOT be affected
