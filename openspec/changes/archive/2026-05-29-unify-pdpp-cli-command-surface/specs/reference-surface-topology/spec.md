## ADDED Requirements

### Requirement: Human-facing CLI copy SHALL identify install and authority
Human-facing reference surfaces SHALL distinguish public delegated-access CLI
commands from reference-operator CLI commands and SHALL show the correct install
or execution path for each.

#### Scenario: A dashboard timeline shows a CLI command
- **WHEN** a live dashboard timeline, grant, trace, or peek surface shows a CLI command for `_ref` inspection
- **THEN** the command SHALL use the reference namespace, such as `pdpp ref run timeline <run-id>`
- **AND** the copy SHALL state whether it is runnable through the public npm CLI or from a repo checkout

#### Scenario: A surface advertises agent connection
- **WHEN** a docs, dashboard, metadata, skill, or LLM-facing surface advertises delegated access for an agent
- **THEN** it SHALL use the public install/connect command generated from the CLI package metadata
- **AND** it SHALL NOT imply that reference-operator commands are required for routine agent connection

#### Scenario: Public and reference CLI surfaces differ
- **WHEN** a command is available only in the repo-local reference wrapper
- **THEN** human-facing copy SHALL label it repo-local or compatibility-only
- **AND** it SHALL NOT link users to the public npm package as though that package supports the command

### Requirement: CLI examples SHALL remain consistent across surfaces
Reference website, dashboard, package README, and hosted docs SHALL keep CLI
examples consistent with the configured CLI package metadata and command
namespace decisions.

#### Scenario: CLI metadata changes
- **WHEN** the configured CLI package name, binary name, version policy, or reference namespace changes
- **THEN** docs and dashboard examples SHALL update from the same source of truth or fail validation

#### Scenario: Legacy operator aliases exist
- **WHEN** repo-local compatibility aliases remain for old top-level operator commands
- **THEN** rendered dashboard and documentation surfaces SHALL avoid advertising those aliases
- **AND** tests SHALL detect accidental reintroduction of the legacy examples
