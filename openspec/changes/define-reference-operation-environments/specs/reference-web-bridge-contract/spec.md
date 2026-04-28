## ADDED Requirements

### Requirement: Website-hosted reference APIs SHALL mount reference operations

Website-hosted API surfaces that claim to expose AS, RS, or `_ref` reference behavior SHALL mount canonical reference operations through an explicit environment profile. They SHALL NOT independently implement AS/RS semantics in website code.

#### Scenario: Public sandbox API route

- **WHEN** `/sandbox/v1/schema`, `/sandbox/v1/search`, or another sandbox reference API route is requested
- **THEN** the route SHALL execute the corresponding reference operation through the sandbox fixture profile
- **AND** response builders in website code SHALL NOT be the source of AS/RS behavior

#### Scenario: Website-only educational helper

- **WHEN** a website route presents a walkthrough, code sample, or fixture explanation that is not a callable reference API
- **THEN** it MAY use website-local rendering helpers
- **BUT** it SHALL NOT be described as authoritative AS/RS behavior
