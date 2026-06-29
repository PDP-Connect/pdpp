## 1. Contract

- [x] 1.1 Add an OpenSpec requirement for native loopback port variance.
- [x] 1.2 Validate the OpenSpec change strictly.

## 2. Implementation

- [x] 2.1 Add a shared redirect-matching helper for registered redirect URIs.
- [x] 2.2 Apply the helper to hosted MCP authorization-code entry points.
- [x] 2.3 Keep token exchange bound to the exact authorization-request redirect.

## 3. Tests

- [x] 3.1 Cover portless CIMD loopback metadata with runtime-port authorization.
- [x] 3.2 Cover path mismatch rejection.
- [x] 3.3 Cover token exchange exact-redirect binding.

## 4. Validation

- [x] 4.1 Run focused hosted MCP OAuth tests.
- [x] 4.2 Run focused CIMD tests if touched.
- [x] 4.3 Run `openspec validate accept-native-loopback-redirect-port --strict`.
- [x] 4.4 Run `openspec validate --all --strict`.
- [x] 4.5 Run `git diff --check`.
