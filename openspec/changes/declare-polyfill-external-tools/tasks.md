## 1. Manifest Contract

- [x] Add `runtime_requirements.external_tools` to the Slack manifest.
- [x] Add static manifest honesty coverage for known external tool references.
- [x] Update connector ecosystem docs and the existing design note.

## 2. Validation

- [x] Validate `runtime_requirements.external_tools` shapes during connector registration.
- [x] Add registry validator coverage for accepted and rejected external tool declarations.

## 3. Checks

- [x] Run targeted polyfill manifest tests.
- [x] Run targeted reference manifest tests.
- [x] Run `openspec validate declare-polyfill-external-tools --strict`.
