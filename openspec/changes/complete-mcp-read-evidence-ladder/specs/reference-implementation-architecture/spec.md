## MODIFIED Requirements

### Requirement: Resource Server Search Exposes Proven Match Windows

The resource server SHALL expose bounded search match-window evidence when it
can identify the text field and character window that caused a search hit. The
resource server SHALL NOT fabricate a match window when the backend cannot prove
the matched field.

#### Scenario: Lexical search matches a text field

- **WHEN** lexical search matches a granted text-like field
- **THEN** the search hit SHALL include bounded match-window metadata naming the
  record, field path, text window, truncation state, and continuation selector
- **AND** the field-window continuation SHALL remain grant-scoped

#### Scenario: Search backend cannot prove matched field

- **WHEN** a search backend returns a hit but cannot identify the matched field
  or a safe text window
- **THEN** the search hit SHALL omit match-window evidence or mark it unavailable
- **AND** downstream adapters SHALL NOT infer the matched field from field names
