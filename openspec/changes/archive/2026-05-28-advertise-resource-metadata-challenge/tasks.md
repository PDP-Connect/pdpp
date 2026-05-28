## 1. Challenge Header

- [x] 1.1 Add a small helper that resolves the RS protected-resource metadata URL only when the request origin is trusted.
- [x] 1.2 Attach the resolved metadata URL to RS requests before protected `/v1/**` route auth runs.
- [x] 1.3 Set `WWW-Authenticate: Bearer resource_metadata="..."`, `error.resource_metadata`, and `error.next_step` before `requireToken` returns HTTP 401.

## 2. Tests

- [x] 2.1 Add coverage for missing-token RS requests receiving the metadata challenge and body hints.
- [x] 2.2 Add coverage for explicit public RS origin being used in the metadata challenge and body hints.
- [x] 2.3 Add coverage that untrusted public host-derived requests omit the challenge and body hints.

## 3. Validation

- [x] 3.1 Run the focused provider metadata test file.
- [x] 3.2 Run the reference implementation verification suite.
- [x] 3.3 Run `openspec validate advertise-resource-metadata-challenge --strict`.
