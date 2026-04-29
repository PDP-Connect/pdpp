## ADDED Requirements

### Requirement: Sandbox dataset summary SHALL mount `ref.dataset.summary`

The website-hosted sandbox SHALL serve `GET /sandbox/_ref/dataset/summary` by mounting the canonical `ref.dataset.summary` operation through a sandbox fixture environment profile. It SHALL NOT construct the public dataset-summary response through an independent website-local builder.

#### Scenario: Sandbox dataset-summary route

- **WHEN** `/sandbox/_ref/dataset/summary` is requested
- **THEN** the route SHALL execute the same `ref.dataset.summary` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel dataset-summary builder removal

- **WHEN** `/sandbox/_ref/dataset/summary` is migrated to `ref.dataset.summary`
- **THEN** the website-local public builder that previously constructed the live-shaped dataset-summary response SHALL be deleted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped `dataset_summary` envelope from the sandbox fixture profile
