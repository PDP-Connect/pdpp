## 1. Spec

- [x] 1.1 Add OpenSpec proposal, design, tasks, and spec deltas.
- [x] 1.2 Validate with `openspec validate add-google-maps-data-portability-connector --strict`.

## 2. Manifest And Setup Contract

- [x] 2.1 Add a first-party `google_maps_data_portability` manifest with `setup.modality: provider_authorization`, Google Data Portability deployment config keys, documented Maps scopes, and honest public-listing/proof state.
- [x] 2.2 Register the manifest with the reference manifest registration path so Add source can render it from manifest/setup-plan data.
- [x] 2.3 Prove the shared setup planner classifies the source as provider authorization, reports deployment config blockers, and does not use source-specific UI branches.
- [x] 2.4 Add tests proving Gmail app passwords/static-secret setup do not apply to Google Maps Data Portability.

## 3. Provider Authorization

- [x] 3.1 Implement a Google Data Portability provider-auth exchanger using the existing provider-auth lifecycle seam.
- [x] 3.2 Persist provider tokens in the encrypted per-connection credential store, not process env and not owner-agent-visible state.
- [x] 3.3 Support repeated Google authorizations as separate connector instances with distinct connection ids and owner-visible labels.
- [x] 3.4 Handle partial-scope consent and denied consent as typed setup/coverage outcomes.

## 4. Archive Runtime

- [x] 4.1 Implement Data Portability archive initiation and cadence-safe polling into `archive_jobs`.
- [ ] 4.1a Implement signed-URL download and expiry handling after Google returns `COMPLETE`.
- [ ] 4.2 Parse documented Maps resource groups into manifest-declared streams.
- [ ] 4.3 Emit per-stream coverage for authorized, unavailable, denied, empty, and failed resource groups.
- [ ] 4.4 Preserve archive/source-file/export provenance on emitted records.
- [x] 4.5 Keep Timeline point/segment collection out of this connector until Google documents equivalent Data Portability resources.

## 5. Verification

- [x] 5.1 Add unit tests for provider-auth setup planning, exchanger calls, token secrecy, partial consent, and multi-account connection creation.
- [ ] 5.2 Add archive parser fixtures from documented or scrubbed Data Portability Maps samples.
- [x] 5.3 Add a black-box setup route test from manifest registration through provider-auth initiation/callback.
- [x] 5.4 Run focused package tests and OpenSpec validation.
- [x] 5.5 Record the live proof gap if Google OAuth app verification or owner-held credentials block full live validation.
