## Why

Browser-backed polyfill connectors currently declare network access but do not declare that they require browser automation. That makes manifests look less invasive than the runtime behavior and weakens Docker/host-browser setup honesty.

## What Changes

- Add a coarse `runtime_requirements.bindings.browser` manifest binding for connectors that acquire a browser.
- Validate runtime requirement binding declarations at connector registration.
- Add a manifest honesty test that fails when a connector uses browser runtime code without declaring the binding.
- Update connector ecosystem documentation to point at the shipped binding shape.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`

## Impact

- Polyfill connector manifests for browser-backed connectors.
- Reference connector-manifest validator.
- Reference runtime available bindings.
- Polyfill connector manifest tests.
