## ADDED Requirements

### Requirement: Fast broad agent consent SHALL remain proposed until accepted

Any mechanism that lets an owner approve multiple source scopes for an agent in one ceremony SHALL be treated as proposed until reviewed and accepted through the OpenSpec/spec process.

#### Scenario: Experimental batch consent ships in the reference

- **WHEN** the reference implementation experiments with a batch consent or grant package flow
- **THEN** the UI and documentation SHALL label it reference-experimental
- **AND** it SHALL NOT claim finalized PDPP protocol semantics.

### Requirement: Issued grants SHALL remain source-bounded unless explicitly superseded

Fast setup designs SHALL preserve the current source-bounded grant model by issuing independent grants per source rather than a single cross-source grant, unless a later accepted PDPP change explicitly supersedes that model.

#### Scenario: Owner approves a multi-source setup ceremony

- **WHEN** an owner approves access to multiple connectors or providers in one owner-facing ceremony
- **THEN** the resulting access SHALL be represented as multiple independently revocable source-bounded grants
- **AND** RS enforcement SHALL remain per grant and per source.

### Requirement: Broad consent UI SHALL make cumulative risk legible

Any proposed broad or batch consent ceremony SHALL render enough information for the owner to understand cumulative access risk across sources.

#### Scenario: A request includes high-risk breadth

- **WHEN** a staged setup request includes continuous access, all streams, no time range, no field projection, sensitive sources, or many sources
- **THEN** the consent UI SHALL surface those risk factors explicitly
- **AND** it SHALL NOT make maximal access visually equivalent to a narrow single-task grant.

### Requirement: Owner control SHALL remain granular

Any proposed broad setup flow SHALL preserve granular owner control over approval, denial, audit, and revocation.

#### Scenario: Owner rejects one source in a package

- **WHEN** an owner-facing ceremony contains multiple source-bounded requests
- **THEN** the owner SHALL be able to deny or remove one source without denying all other sources
- **AND** any approved sources SHALL remain auditable and revocable independently.

### Requirement: Client-authored broad packages SHALL be constrained

The AS SHALL NOT accept arbitrary client-authored "all data" packages without validation, risk classification, and owner-visible review constraints.

#### Scenario: Client requests many maximal continuous scopes

- **WHEN** a client stages a broad package containing many maximal continuous source scopes
- **THEN** the AS SHALL either reject it or require a stronger consent ceremony than a narrow request
- **AND** the owner SHALL see which sources and scope dimensions make the request broad.
