## ADDED Requirements

### Requirement: Records-stream pilot fixtures SHALL pass LLM-assisted redaction review before commit
Connectors that emit records directly (JSONL streams without an intermediate DOM or HTTP-JSON shape) SHALL produce their committed pilot fixture through the LLM-assisted structured-redaction mode of the scrubber pipeline. Deterministic regex redaction alone is insufficient for free-form user-authored text in records.

#### Scenario: A records-stream connector captures real owner content
- **WHEN** a worker captures a raw records run for a connector whose emitted records contain free-form `title`, `body`, `selftext`, or user-authored URL fields
- **THEN** the committed pilot fixture SHALL be produced via `scrub-fixtures.ts --llm-redactions-dir <dir>` with a reviewed redaction plan for every raw file
- **AND** every replacement in the plan SHALL be a `[REDACTED_*]` placeholder
- **AND** a reviewer other than the capture author SHOULD sign off on the scrubbed output before commit

### Requirement: Records-stream pilot fixtures SHALL be schema-validated in tests
A committed records-stream pilot fixture SHALL be consumed by at least one integration test that asserts every row passes the connector's `validateRecord()` for its declared stream. This locks the real emitted-record shape against schema drift.

#### Scenario: A pilot fixture contains a record that fails its stream's zod schema
- **WHEN** the integration test replays `fixtures/<connector>/scrubbed/pilot-real-shape/records/<stream>.jsonl`
- **THEN** any row for which `validateRecord(stream, row)` returns `{ ok: false }` SHALL fail the test with the zod issues reported
- **AND** the test SHALL NOT silently skip or soft-fail when a fixture is absent — missing pilot files SHALL cause test failure
