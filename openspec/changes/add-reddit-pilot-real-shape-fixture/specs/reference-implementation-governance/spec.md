## ADDED Requirements

### Requirement: Records-stream connectors SHALL commit a schema-locking pilot fixture
A connector that emits records directly as a JSONL stream (no intermediate DOM or stored HTTP-JSON shape) SHALL commit a `pilot-real-shape` fixture under `fixtures/<connector>/scrubbed/pilot-real-shape/records/<stream>.jsonl` covering each stream it declares. The committed fixture SHALL be PII-free. It MAY be a hand-authored synthetic-but-shape-real record set — real field shapes and representative non-identifying values, with `[REDACTED_*]` placeholders where a real capture would carry owner identity — or a reviewed real owner capture produced per the redaction requirement below.

#### Scenario: A records-stream connector ships a synthetic-but-shape-real pilot
- **WHEN** a connector emits records directly as JSONL and commits a synthetic-but-shape-real pilot fixture
- **THEN** the committed fixture SHALL contain no real owner PII
- **AND** every identity-bearing field that a real capture would populate SHALL use a `[REDACTED_*]` placeholder or a representative non-identifying value
- **AND** no `fixtures/<connector>/raw/` directory SHALL be committed

### Requirement: Real-owner-capture pilot fixtures SHALL pass LLM-assisted redaction review before commit
When a committed pilot fixture is derived from a **real owner capture** whose records contain free-form user-authored text (`title`, `body`, `selftext`, or user-authored URL fields), that fixture SHALL be produced through the LLM-assisted structured-redaction mode of the scrubber pipeline. Deterministic regex redaction alone is insufficient for free-form user-authored text in records.

#### Scenario: A records-stream connector commits a fixture from real owner content
- **WHEN** a worker captures a raw records run for a connector whose emitted records contain free-form `title`, `body`, `selftext`, or user-authored URL fields, and commits the resulting scrubbed records as the pilot fixture
- **THEN** the committed pilot fixture SHALL be produced via `scrub-fixtures.ts --llm-redactions-dir <dir>` with a reviewed redaction plan for every raw file
- **AND** every replacement in the plan SHALL be a `[REDACTED_*]` placeholder
- **AND** a reviewer other than the capture author SHOULD sign off on the scrubbed output before commit

### Requirement: Records-stream pilot fixtures SHALL be schema-validated in tests
A committed records-stream pilot fixture SHALL be consumed by at least one integration test that asserts every row passes the connector's `validateRecord()` for its declared stream. This locks the real emitted-record shape against schema drift.

#### Scenario: A pilot fixture contains a record that fails its stream's zod schema
- **WHEN** the integration test replays `fixtures/<connector>/scrubbed/pilot-real-shape/records/<stream>.jsonl`
- **THEN** any row for which `validateRecord(stream, row)` returns `{ ok: false }` SHALL fail the test with the zod issues reported
- **AND** the test SHALL NOT silently skip or soft-fail when a fixture is absent — missing pilot files SHALL cause test failure
