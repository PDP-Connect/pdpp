## ADDED Requirements

### Requirement: Sandbox dataset summary SHALL mount `ref.dataset.summary`

The website-hosted sandbox SHALL serve every public dataset-summary surface — both the public `GET /sandbox/_ref/dataset/summary` route and the sandbox dashboard data source's `getDatasetSummary` method — by mounting the canonical `ref.dataset.summary` operation through a sandbox fixture environment profile. It SHALL NOT construct the dataset-summary envelope through an independent website-local builder or local field mapping on any of those surfaces.

#### Scenario: Sandbox dataset-summary route

- **WHEN** `/sandbox/_ref/dataset/summary` is requested
- **THEN** the route SHALL execute the same `ref.dataset.summary` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Sandbox dashboard data source dataset-summary

- **WHEN** the sandbox dashboard data source's `getDatasetSummary` method is invoked
- **THEN** it SHALL execute the same `ref.dataset.summary` operation implementation used by the native reference host and the sandbox public route
- **AND** it SHALL NOT construct the dataset-summary envelope through a local mapping over a demo-shaped builder
- **AND** the resulting envelope SHALL be byte-equal to the envelope returned by the public `/sandbox/_ref/dataset/summary` route under the same fixture environment

#### Scenario: Parallel dataset-summary builder removal

- **WHEN** the sandbox dataset-summary surfaces are migrated to `ref.dataset.summary`
- **THEN** the website-local public builder that previously constructed the live-shaped dataset-summary response SHALL be deleted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the public route still returns a live-shaped `dataset_summary` envelope from the sandbox fixture profile
- **AND** the migration SHALL include a regression test pinning the dashboard data source's envelope to the canonical operation's envelope under the same fixture profile, so any future re-introduction of a parallel local mapping in the data source is caught by test failure
