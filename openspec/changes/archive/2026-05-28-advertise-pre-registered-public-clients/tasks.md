## 1. Metadata Contract

- [x] Add `pdpp_pre_registered_public_clients` to AS metadata operation inputs and builder output.
- [x] Update the public reference contract schema for the extension.

## 2. Reference Wiring

- [x] Populate advertised clients from configured pre-registered public clients.
- [x] Ensure public forwarded metadata exposes client IDs when DCR is not publicly available.

## 3. Docs And Tests

- [x] Add metadata tests for public-client discovery in disabled and dynamic registration modes.
- [x] Update spec docs to describe the extension and its security boundary.

## 4. Checks

- [x] Run targeted provider metadata tests.
- [x] Run targeted reference validation.
- [x] Run `openspec validate advertise-pre-registered-public-clients --strict`.
