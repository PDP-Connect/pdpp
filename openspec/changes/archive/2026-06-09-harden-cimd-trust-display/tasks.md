## 1. Consent Trust Display

- [x] 1.1 Persist/render the resolved client registration mode on pending consent requests.
- [x] 1.2 Render CIMD `client_id` origin as the identity anchor and metadata display as self-description.
- [x] 1.3 Re-resolve pending consent clients through the CIMD-aware resolver at consent display and approval time.

## 2. SSRF Guard

- [x] 2.1 Normalize IPv4-mapped IPv6 addresses before forbidden-range checks.
- [x] 2.2 Block broadcast IPv4 and CGNAT ranges for CIMD metadata fetches.

## 3. Verification

- [x] 3.1 Add focused tests for CIMD trust display and approval.
- [x] 3.2 Add focused tests for the IP guard bypasses.
- [x] 3.3 Run focused tests and `openspec validate harden-cimd-trust-display --strict`.
