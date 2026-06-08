## 1. OpenSpec

- [x] 1.1 Create proposal, design, and spec delta for loopback-native inference.
- [x] 1.2 Validate the OpenSpec change with `openspec validate infer-native-client-for-loopback-redirects --strict`.

## 2. Implementation

- [x] 2.1 Infer `application_type: "native"` from omitted-type loopback HTTP redirect metadata.
- [x] 2.2 Return the inferred application type in DCR registration responses.

## 3. Verification

- [x] 3.1 Add `/oauth/register` tests for omitted-type `127.0.0.1` and `localhost` redirects.
- [x] 3.2 Add a regression test proving explicit `web` plus loopback HTTP still rejects.
- [ ] 3.3 Run focused tests, typecheck, OpenSpec validation, and live DCR smoke after deploy.
