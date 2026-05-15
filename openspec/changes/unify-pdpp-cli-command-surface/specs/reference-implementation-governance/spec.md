## ADDED Requirements

### Requirement: CLI package validation SHALL prove command ownership
The repository SHALL validate that the public CLI package owns the public
`pdpp` command surface and that repo-local reference wrappers do not silently
diverge from the published command tree.

#### Scenario: The CLI package is packed
- **WHEN** CI or a maintainer packs `@pdpp/cli`
- **THEN** package validation SHALL prove that the package exposes the intended `pdpp` binary and command help
- **AND** it SHALL prove that publishable reference commands do not import server-only, connector-runtime, database, Docker, fixture, or deployment-only modules

#### Scenario: The repo-local wrapper is tested
- **WHEN** reference CLI tests run
- **THEN** they SHALL prove that the repo-local wrapper delegates public and reference-namespaced commands consistently
- **AND** any compatibility aliases SHALL be tested as aliases rather than as the canonical documented command surface

#### Scenario: Dashboard and docs are validated
- **WHEN** web or docs checks run
- **THEN** they SHALL detect dashboard/docs examples that advertise legacy top-level reference-operator aliases
- **AND** they SHALL detect examples that point to the public npm package for commands not shipped by that package

### Requirement: CLI boundary changes SHALL remain OpenSpec-governed
The repository SHALL treat future changes that publish additional operator
commands, add CLI extension loading, alter owner-session storage, or change the
public command namespace as durable reference/governance work.

#### Scenario: A new operator command is proposed for the public package
- **WHEN** maintainers want to move another repo-local reference command into `@pdpp/cli`
- **THEN** the command SHALL receive a publishability review covering dependencies, auth model, support posture, help text, and package tests

#### Scenario: A second public CLI package is proposed
- **WHEN** maintainers want to publish another package related to PDPP CLI behavior
- **THEN** the package SHALL NOT publish the same `pdpp` binary unless an OpenSpec change explicitly approves the conflict and migration model
