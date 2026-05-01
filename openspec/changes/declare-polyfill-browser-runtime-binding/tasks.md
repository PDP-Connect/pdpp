## 1. Manifest Contract

- [x] Add `runtime_requirements.bindings.browser.required` to browser-backed polyfill manifests.
- [x] Add manifest honesty coverage that scans connector code and manifests.
- [x] Update connector ecosystem docs to describe the shipped binding shape.

## 2. Runtime And Validation

- [x] Advertise `browser` in reference runtime available bindings.
- [x] Validate `runtime_requirements.bindings` shapes during connector registration.
- [x] Add validator coverage for accepted browser binding and rejected malformed binding declarations.

## 3. Validation

- [x] Run targeted polyfill manifest tests.
- [x] Run targeted reference manifest/runtime tests.
- [x] Run `openspec validate declare-polyfill-browser-runtime-binding --strict`.
