## Context

The reference now supports CIMD URL-shaped `client_id` values. For those clients, the URL itself is the stable identity anchor the AS can evaluate. Metadata fields such as `client_name`, `client_uri`, and `logo_uri` are fetched from a document controlled by the client and are not independent proof of brand ownership.

The existing consent surface showed the resolved display name as "Requesting app" for every registration mode. That is acceptable for local pre-registered clients and DCR clients under the reference's current assumptions, but it is too strong for externally hosted CIMD documents.

## Decisions

- CIMD consent display SHALL show the `client_id` origin as the client identity.
- CIMD metadata-derived names and logos SHALL be described as self-described client metadata, not verified identity.
- The staged pending request SHALL carry `registration_mode` so the render path can apply this rule without guessing from display text.
- Consent-time and approval-time re-resolution SHALL call the CIMD-aware client resolver. A pending URL-shaped client_id must not display successfully and then fail approval because only persisted registered clients are queried.
- The IP guard SHALL normalize IPv4-mapped IPv6 before range checks and block additional non-public/special IPv4 ranges relevant to metadata fetch SSRF.

## Alternatives Considered

- **Hide CIMD `client_name` entirely.** Rejected because it harms local Claude Code/Codex usability and is stricter than needed. The claim can be useful if correctly attributed.
- **Treat same-origin PDPP-hosted CIMD documents as verified app names.** Rejected for now because the owner supplies the label, but the document still represents local-client setup metadata. A future trust registry can add a stronger verified signal.
- **Infer CIMD mode from `client_id` URL shape only.** Rejected because render logic should consume normalized AS facts, not duplicate registration-mode logic.

## Acceptance Checks

- A CIMD consent page shows the `client_id` origin as "Client identity" and the metadata name as "Self-described app name".
- A CIMD consent approval issues the same scoped grant/token as before.
- Pre-registered and DCR consent pages continue to show the registered display name as the requesting app.
- `isForbiddenIp()` rejects IPv4-mapped loopback/private/link-local/Cgnat/broadcast addresses and public IPv4-mapped addresses remain allowed.
- OpenSpec validates strictly.
