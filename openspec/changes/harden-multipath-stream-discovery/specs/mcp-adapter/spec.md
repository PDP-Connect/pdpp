## ADDED Requirements

### Requirement: MCP search text SHALL surface a first fetch handle before verbose metadata

The MCP adapter SHALL include a parseable first fetch handle in the model-visible search tool `content[]` text whenever the search result page contains at least one fetchable hit. The first handle SHALL appear before verbose source/package metadata such as `source_mix`, so clients that clip or summarize tool output still expose a usable handle. The handle SHALL match the first entry in `structuredContent.results[0].id`.

The MCP adapter SHALL continue to expose the full flattened result page in `structuredContent.results`; the first text handle is a host-compatibility mirror, not a second canonical result list.

#### Scenario: Search has at least one hit

- **WHEN** an MCP client calls `search` and the adapter returns one or more hits
- **THEN** the search tool text SHALL include `first_fetch_id=<id>` before verbose source metadata
- **AND** `<id>` SHALL equal `structuredContent.results[0].id`.

#### Scenario: Search has no hits

- **WHEN** an MCP client calls `search` and the adapter returns zero hits
- **THEN** the adapter SHALL NOT invent a `first_fetch_id`
- **AND** `structuredContent.results` SHALL remain an empty array.

#### Scenario: Client fetches from clipped text

- **WHEN** a host preview hides `structuredContent.results` and clips later top-result lines
- **THEN** an agent SHALL still be able to extract the first fetch handle from the first search summary line and call `fetch` with that handle unchanged.
