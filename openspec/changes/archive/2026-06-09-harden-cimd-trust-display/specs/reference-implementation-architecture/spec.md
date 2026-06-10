## ADDED Requirements

### Requirement: CIMD consent display SHALL distinguish origin identity from client-authored display claims

When a pending consent request uses a client resolved through Client ID Metadata Documents, the reference consent display SHALL present the `client_id` origin as the client identity. Metadata document fields such as `client_name`, `client_uri`, and `logo_uri` SHALL be presented only as self-described client metadata unless a separate server-side trust registry verifies them.

#### Scenario: CIMD client name is self-described

- **WHEN** a CIMD client metadata document identifies the client as `https://client.example/oauth/client.json`
- **AND** the document sets `client_name` to `Claude`
- **THEN** the consent display SHALL show `https://client.example` as the client identity
- **AND** it SHALL label `Claude` as self-described client metadata rather than verified identity.

#### Scenario: Registered clients keep registered display

- **WHEN** a pre-registered or dynamically registered public client requests consent
- **THEN** the consent display SHALL continue to use the server-resolved registered client display metadata as the requesting app identity.

### Requirement: CIMD pending consent re-resolution SHALL use the CIMD-aware client resolver

The reference authorization server SHALL re-resolve pending consent clients through the same CIMD-aware client resolution path used at request initiation and token exchange.

#### Scenario: CIMD consent approval succeeds after display

- **WHEN** a URL-shaped CIMD `client_id` request has been staged for consent
- **AND** the owner approves the pending consent
- **THEN** the AS SHALL resolve the client through CIMD metadata
- **AND** it SHALL issue the scoped grant/token when the request is otherwise valid.

### Requirement: CIMD metadata fetch IP filtering SHALL reject mapped and non-public addresses

Before fetching an external CIMD metadata document, the reference SHALL reject DNS results that resolve to loopback, private, link-local, multicast, unspecified, broadcast, carrier-grade NAT, or IPv4-mapped IPv6 forms of those addresses.

#### Scenario: IPv4-mapped loopback is rejected

- **WHEN** CIMD DNS resolution returns `::ffff:127.0.0.1`
- **THEN** the reference SHALL reject the metadata fetch before issuing HTTP.

#### Scenario: CGNAT and broadcast IPv4 are rejected

- **WHEN** CIMD DNS resolution returns `100.64.0.1` or `255.255.255.255`
- **THEN** the reference SHALL reject the metadata fetch before issuing HTTP.
