## 1. Design

- [x] Pivot the registration decision to public self-registration as the reference default.
- [x] Capture required security, validation, rate-limit, and audit properties.

## 2. Implementation

- [x] Advertise `registration_endpoint` whenever DCR is enabled, independent of initial-access-token configuration.
- [x] Allow unauthenticated public-client registration while preserving rejection for invalid bearer tokens.
- [x] Add bounded rate limiting for unauthenticated registration attempts.
- [x] Teach `pdpp connect` to self-register a public client before starting agent connect when registration metadata is available.
- [x] Update reference CLI/docs so initial-access tokens are optional bootstrap controls, not the normal public path.
- [x] Add stranger-client tests proving public registration, strict metadata rejection, and traceable failures.

## 3. Checks

- [x] Run `openspec validate enable-public-client-self-registration --strict`.
- [x] Run targeted AS/metadata/CLI tests.
