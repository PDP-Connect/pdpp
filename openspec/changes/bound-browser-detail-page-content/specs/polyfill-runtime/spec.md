## MODIFIED Requirements

### Requirement: Browser-backed connectors SHALL bound renderer-dependent reads
Browser-backed polyfill connectors SHALL NOT rely on unbounded renderer-dependent reads for list/detail parsing. If a connector reads page HTML, text, accessibility, or other renderer-derived content after navigation, it SHALL apply a bounded timeout or use a runtime helper that does.

#### Scenario: Detail page renderer stops answering
- **WHEN** a browser-backed connector navigates to a detail page
- **AND** the browser target remains alive but renderer-dependent content reads do not return
- **THEN** the connector SHALL stop waiting after a bounded timeout
- **AND** it SHALL report the item through the connector's existing retryable gap or failure path

#### Scenario: Browser metadata remains available
- **WHEN** navigation history or target metadata still responds
- **AND** DOM/Runtime/content reads time out
- **THEN** the connector SHALL treat the detail read as unavailable rather than assuming the page parsed successfully
