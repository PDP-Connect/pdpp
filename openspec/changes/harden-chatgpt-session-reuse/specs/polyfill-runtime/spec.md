## MODIFIED Requirements

### Requirement: Browser-backed connector page preservation SHALL be explicit and outcome-scoped

The polyfill runtime SHALL close browser run pages by default after both successful and failed runs. A connector MAY opt into preserving its run page after successful runs, failed runs, or both when its source authentication state is carried by the live browser page rather than durable browser storage.

#### Scenario: Connector does not opt into preservation

**WHEN** a browser-backed connector run completes or fails
**THEN** the runtime SHALL close the run page during teardown.

#### Scenario: Connector preserves successful pages

**WHEN** a browser-backed connector run succeeds
**AND** the connector opted into successful-page preservation
**THEN** the runtime SHALL leave the run page open for later reuse.

#### Scenario: Connector preserves failed pages

**WHEN** a browser-backed connector run fails
**AND** the connector opted into failed-page preservation
**THEN** the runtime SHALL leave the run page open for later repair or reuse.

#### Scenario: Preserved remote pages are reacquired

**WHEN** a remote-CDP connector opts into preserving successful or failed pages
**THEN** the next acquire SHALL skip remote page-target cleanup
**AND** the runtime SHALL reuse an existing non-blank page when one is available.

### Requirement: Managed browser profiles SHALL configure browser-supported session restore honestly

The managed n.eko browser image SHALL configure Chrome to restore the prior browser session on startup when using a persistent profile directory. The reference runtime SHALL NOT rely on profile directory persistence alone as proof that a provider API session survived restart, because some sources carry authenticated API state in process- or session-scoped browser state that is not restored by profile files alone.

#### Scenario: Managed browser starts with a persistent profile

**WHEN** a managed n.eko surface starts with a persistent Chrome profile directory
**THEN** Chrome SHALL be configured to restore the prior browser session
**AND** connector auth probes SHALL remain authoritative for deciding whether source collection may proceed.
