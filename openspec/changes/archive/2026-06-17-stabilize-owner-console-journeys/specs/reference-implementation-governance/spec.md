## ADDED Requirements

### Requirement: Owner-console UI deploys SHALL be gated by journey evidence

Owner-console UI changes that affect Sources, Add data, browser-session setup, recovery, Runs, Traces, Explore handoff, or Connect AI apps SHALL include journey evidence before deployment. Unit tests, typechecks, and text scanners SHALL be required but SHALL NOT be sufficient by themselves.

#### Scenario: A UI tranche is ready for deploy

- **WHEN** a UI tranche is proposed for deployment
- **THEN** the handoff SHALL cite the journey row it closes
- **AND** it SHALL include relevant tests, before/after screenshots or headed-browser captures, console-error capture for affected client journeys, and failed-network capture where applicable

#### Scenario: A route cannot be exercised without owner-only action

- **WHEN** a route requires owner credentials, provider login, physical device state, or personal-data mutation to fully verify
- **THEN** the RI owner SHALL record the blocked evidence explicitly
- **AND** SHALL still exhaust safe local, seeded, headed-browser, and non-mutating live checks before asking the owner for a fresh walkthrough

### Requirement: Worker lanes SHALL not define shippability

Delegated worker lanes SHALL operate from an RI-owner-authored acceptance packet or evidence request. A worker MAY gather evidence, implement a bounded change, or adversarially review a diff, but SHALL NOT redefine the acceptance target or ship a local proxy for the owner journey.

#### Scenario: A worker returns a green report

- **WHEN** a worker reports success
- **THEN** the RI owner SHALL review the report against the OpenSpec journey contract and acceptance ledger
- **AND** SHALL NOT merge or deploy the worker result if it only relabels a dead end, relies on mocked evidence for a live failure, or changes unrelated surfaces while leaving the complaint unresolved

#### Scenario: Multiple workers run in parallel

- **WHEN** multiple worker lanes are delegated
- **THEN** their scopes SHALL be disjoint or explicitly ordered
- **AND** each lane SHALL write a concise report under `tmp/workstreams/`

### Requirement: Live-stack mutation SHALL use the owner mutex and closeout evidence

Any deployment, container restart, container recreate, database maintenance, or other live-stack mutation SHALL declare a live-stack window before it starts and SHALL close that window with evidence. UI journey proof that mutates live personal-data state SHALL declare a verification window with scope and boundaries before starting.

#### Scenario: A live deployment starts

- **WHEN** an agent deploys or restarts any part of the live reference stack
- **THEN** it SHALL first record operator, start time, scope, expected duration, and boundaries in `tmp/workstreams/ri-owner-current-state.md`
- **AND** it SHALL check that no incompatible live-stack window is already open

#### Scenario: Live verification creates draft source state

- **WHEN** a headed browser proof may create a draft enrollment, run, or source state on the live personal-data instance
- **THEN** the agent SHALL record a verification window with scope and no-credential boundaries
- **AND** it SHALL close the window with the observed result and any cleanup/residual note
