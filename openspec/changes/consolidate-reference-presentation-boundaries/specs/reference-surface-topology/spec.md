## ADDED Requirements

### Requirement: Shared reference presentation SHALL have explicit package and deployable ownership

Framework-independent connector identity, record presentation, and timestamp policy shared by reference web surfaces SHALL live in a workspace package that does not depend on React, Next.js, or CSS. Shared design tokens and stylesheet composition SHALL live in the brand package. React components SHALL own their component-specific styling, and deployable- or route-specific styling and navigation SHALL remain in the owning application.

#### Scenario: A non-React consumer formats reference data

- **WHEN** a package or test needs connector labels, record preview policy, record formatting, or timestamp parsing without rendering React
- **THEN** it SHALL import that policy from the framework-independent display package
- **AND** it SHALL NOT need to import operator-ui or brand-react internals

#### Scenario: A stylesheet applies to only one deployable or route

- **WHEN** a style encodes public-site editorial presentation, console-specific Ink Carbon overrides, or stream-route behavior
- **THEN** that stylesheet SHALL be owned and imported by that deployable or route
- **AND** the shared brand package SHALL NOT expose it as a cross-surface contract

#### Scenario: Both web deployables resolve theme state

- **WHEN** the public site and operator console initialize or change light, dark, or system theme choice
- **THEN** both SHALL use the same shared theme provider contract
- **AND** application-local providers SHALL NOT implement competing persistence behavior
