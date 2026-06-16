## MODIFIED Requirements

### Requirement: Reference operator routes SHALL make surface authority clear

The live reference-instance operator console SHALL distinguish configured
connection setup, record inspection, and client read-access setup in route
labels, first-screen copy, and primary navigation. The configured-connection surface
SHALL use `connection` as the owner-facing noun. The Explore surface SHALL be
identified as the place to read or search collected records. The Connect AI apps
surface SHALL be identified as grant-scoped read-access setup for clients and
local agents.

#### Scenario: Owner lands on Sources

**WHEN** an owner opens the Sources surface
**THEN** the first screen SHALL identify Connections as the place to add, repair,
sync, reauthorize, revoke, or inspect configured connections
**AND** it SHALL point record reading to Explore
**AND** it SHALL point AI-app or local-agent read access to Connect AI apps.

#### Scenario: Owner scans configured connections

**WHEN** the route renders configured connection rows
**THEN** each row SHALL render one visible status derived from the connection
health projection before the connection identity
**AND** warning or destructive connection states SHALL receive a row-level visual
treatment
**AND** freshness or attention wording included in the status projection SHALL
remain visible in the row.

#### Scenario: Owner opens Add connections

**WHEN** an owner opens the Add connections catalog
**THEN** the screen SHALL present connection setup as configured-connection setup
**AND** it SHALL NOT describe the catalog as an AI-app grant, MCP client
onboarding, or general record-reading surface.
