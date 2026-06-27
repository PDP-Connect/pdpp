## MODIFIED Requirements

### Requirement: Browser connectors SHALL clean up run pages according to connector policy

Browser-backed connector runs SHALL use a disposable page by default. The runtime MAY expose an opt-in connector policy to preserve the run page after a successful run when a source keeps useful authenticated state in the page itself. The runtime SHALL NOT preserve the page after a failed run.

#### Scenario: Default browser connector closes the run page

**WHEN** a browser connector does not opt in to page preservation
**THEN** the runtime SHALL create a run page for that run
**AND** the runtime SHALL close that page during teardown.

#### Scenario: Opted-in connector reuses an existing authenticated page

**WHEN** a browser connector opts in to preserving successful run pages
**AND** the browser context already has an open page with a non-blank URL
**THEN** the runtime SHALL use that page for the run instead of opening a fresh page.

#### Scenario: Opted-in remote-CDP connector keeps preserved page targets

**WHEN** a browser connector opts in to preserving successful run pages
**AND** the runtime attaches to a remote-CDP browser
**THEN** the launcher SHALL NOT run pre-attach page-target cleanup for that acquisition.

#### Scenario: Opted-in connector preserves successful run page

**WHEN** a browser connector opts in to preserving successful run pages
**AND** the run completes successfully
**THEN** the runtime SHALL leave the run page open while still releasing the browser lease.

#### Scenario: Opted-in connector closes failed run page

**WHEN** a browser connector opts in to preserving successful run pages
**AND** the run fails before successful completion
**THEN** the runtime SHALL close the run page during teardown.
