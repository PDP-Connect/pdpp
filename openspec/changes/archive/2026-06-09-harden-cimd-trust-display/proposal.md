## Why

CIMD client metadata is client-authored. A URL-shaped `client_id` gives the owner an origin to evaluate, but `client_name` and `logo_uri` are only self-description; rendering them as ordinary app identity invites impersonation.

The CIMD network guard also needs to reject IPv4-mapped IPv6 and additional non-public IPv4 ranges before fetching metadata.

## What Changes

- Consent display for CIMD clients distinguishes the verified identity anchor (`client_id` origin) from self-described `client_name` and `logo_uri` claims.
- Approval-time client re-resolution uses the same CIMD-aware resolution path as PAR/token exchange so staged CIMD requests do not fail after display.
- CIMD DNS/IP filtering blocks IPv4-mapped IPv6 addresses, broadcast IPv4, and carrier-grade NAT ranges.
- Tests cover the trust-display contract, CIMD approval path, and IP guard bypasses.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: harden CIMD consent display provenance and CIMD metadata fetch IP filtering.

## Impact

- Affected runtime: reference authorization server CIMD resolver, consent display helpers, and CIMD SSRF guard.
- Affected tests: CIMD guard tests and hosted consent/PDPP integration coverage.
- No wire-format breaking change for clients. Consent HTML copy changes for CIMD requests.
