## ADDED Requirements

### Requirement: SKIP_RESULT diagnostics SHALL propagate to the run timeline as bounded owner evidence

When a connector emits a `SKIP_RESULT` message that carries a `diagnostics` value, the reference runtime SHALL forward a bounded, redacted projection of that value to the `run.stream_skipped` spine event payload and to the corresponding `known_gap` entry. The runtime SHALL apply the same secret-redaction policy it uses for other connector-authored gap strings, and SHALL bound nested string length, nested array length, nested object depth, and total JSON size before persistence.

The propagated diagnostic SHALL be treated as connector-authored, untrusted evidence. It SHALL be visible only on owner/control-plane surfaces and SHALL NOT be exposed through grant-scoped `/v1` data, search, schema, or blob APIs.

#### Scenario: Connector emits SKIP_RESULT with a structured diagnostics object

- **WHEN** a connector emits `SKIP_RESULT` whose `diagnostics` is a JSON object describing the failure (for example, `{ phase, diag: { url, title }, artifact: { candidates: [...] }, error }`)
- **THEN** the persisted `run.stream_skipped` event SHALL include `data.diagnostics` containing the bounded, redacted projection of that object
- **AND** the corresponding `known_gap` SHALL include a `diagnostics` field with the same bounded payload.

#### Scenario: SKIP_RESULT diagnostics contains a secret-like value

- **WHEN** a string leaf in the connector-authored diagnostics matches the reference runtime's secret-redaction policy (for example `password=…`, `token=…`, a six-digit OTP)
- **THEN** the persisted projection SHALL contain the redacted replacement rather than the original value.

#### Scenario: SKIP_RESULT diagnostics exceeds the size cap

- **WHEN** a connector emits `SKIP_RESULT.diagnostics` whose bounded JSON projection exceeds the runtime's diagnostic size cap
- **THEN** the persisted projection SHALL be replaced with a sentinel object `{ "truncated": true, "reason": "size_overflow" }` (or an equivalent shape that signals truncation)
- **AND** the rest of the `SKIP_RESULT` (stream, reason, message, recovery hint, known gap) SHALL still propagate normally.

#### Scenario: SKIP_RESULT diagnostics is not an object

- **WHEN** a connector emits `SKIP_RESULT` whose `diagnostics` value is an array, string, number, or boolean
- **THEN** the runtime SHALL drop the `diagnostics` field from the persisted payload
- **AND** SHALL NOT reject the `SKIP_RESULT` message for that reason.

#### Scenario: Client-token read cannot access SKIP_RESULT diagnostics

- **WHEN** a grant-scoped client token reads records, search results, schema, blobs, or other `/v1` resources within its grant
- **THEN** `SKIP_RESULT.diagnostics` projections from run timelines SHALL NOT be included in the response
- **AND** the client SHALL NOT receive a URL or object identifier that grants access to those diagnostics.
