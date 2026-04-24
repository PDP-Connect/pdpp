## ADDED Requirements

### Requirement: Connector fixtures SHALL be privacy-scrubbed before commit
First-party connector fixtures derived from real owner captures SHALL be scrubbed before they are committed. Raw captures SHALL remain ignored or otherwise excluded from version control.

#### Scenario: A worker captures a real connector response
- **WHEN** a worker captures DOM, API JSON, JSONL, screenshots, or exported files from a real owner account
- **THEN** the raw capture SHALL NOT be committed
- **AND** any committed fixture derived from it SHALL pass the project scrubber pipeline or an equivalent reviewed redaction process

### Requirement: Scrubbed fixtures SHALL preserve parser-relevant structure
Scrubbed fixtures SHALL preserve the structural fields, selectors, object shapes, and non-sensitive values needed for parser regression tests while replacing private owner data with stable placeholders.

#### Scenario: A parser depends on a DOM selector
- **WHEN** a scrubbed HTML fixture is generated
- **THEN** the selector structure needed by the parser SHALL remain intact
- **AND** sensitive text content SHALL be replaced without breaking the parser's traversal path
