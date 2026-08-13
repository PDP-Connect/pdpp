## MODIFIED Requirements

### Requirement: Source webhook ingress uses a PDPP-specific signed envelope

The reference implementation SHALL authenticate source webhook callbacks using three required request headers with a defined signing scheme.

Required headers:

| Header | Format | Purpose |
|---|---|---|
| `PDPP-Webhook-Timestamp` | Decimal integer string of Unix epoch seconds | Replay-protection timestamp |
| `PDPP-Webhook-Event-Id` | Non-empty opaque string | Idempotency key component |
| `PDPP-Webhook-Signature` | `sha256=<lowercase-hex>` | HMAC-SHA256 authenticity |

The signed material SHALL be `"${event_id}.${timestamp}.${body}"` where `event_id` is the value of the `PDPP-Webhook-Event-Id` header, `timestamp` is the value of the `PDPP-Webhook-Timestamp` header, and `body` is the raw UTF-8 request body. The expected signature SHALL be `sha256=` followed by the lowercase hex encoding of `HMAC-SHA256(secret, signed_material)` where `secret` is the per-source HMAC secret. Signature comparison SHALL use a timing-safe equality check.

HTTP header names are case-insensitive. The header names above are the canonical documentation casing; adapters MAY receive or normalize them in lowercase.

These header names are intentionally PDPP-prefixed rather than the Standard Webhooks v1 names (`webhook-id`, `webhook-timestamp`, `webhook-signature`). Standard Webhooks v1 is the right choice for the outbound client-event-subscription delivery direction (where the reference is the sender). Source webhook ingress is the receiver direction: the reference accepts callbacks from source platforms with their own signing schemes, and standardizing inbound header names would require every source platform to adopt PDPP header names. PDPP-prefixed names correctly signal that this is a reference-specific adapter contract, not a PDPP Core protocol surface.

#### Scenario: All required headers are present and signature matches

- **WHEN** a caller posts a request with valid `PDPP-Webhook-Timestamp`, `PDPP-Webhook-Event-Id`, and `PDPP-Webhook-Signature` headers
- **AND** the signature matches `sha256=hex(HMAC-SHA256(secret, "${event_id}.${timestamp}.${body}"))` using the configured per-source secret
- **AND** the timestamp is within the accepted tolerance window
- **THEN** the reference SHALL proceed to idempotency checking and payload processing

#### Scenario: A required header is absent or blank

- **WHEN** any of `PDPP-Webhook-Timestamp`, `PDPP-Webhook-Event-Id`, or `PDPP-Webhook-Signature` is absent or blank
- **THEN** the reference SHALL reject the request with HTTP 401 before processing the body
- **AND** the error code SHALL identify which header is missing (`missing_timestamp`, `missing_event_id`, or `missing_signature`)

#### Scenario: The signature does not match

- **WHEN** the `PDPP-Webhook-Signature` header is present but does not match the expected HMAC for the given body, event id, timestamp, and per-source secret
- **THEN** the reference SHALL reject the request with HTTP 401 and error code `invalid_signature`
