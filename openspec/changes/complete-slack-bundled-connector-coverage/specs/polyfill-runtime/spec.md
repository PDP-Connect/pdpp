## MODIFIED Requirements

### Requirement: Connector manifest stream schema SHALL declare and validate coverage_policy

The `packages/reference-contract` manifest stream schema SHALL include
`coverage_policy` as an optional field with a closed enum of accepted values:
`collect`, `deferred`, `inventory_only`, `unavailable`, and `unsupported`.

The field SHALL be optional; absence is treated as `collect` (the default, "this
stream is intended to be fully collected"). A connector author declaring a stream
as `unsupported` or `unavailable` SHALL also set `required: false` to avoid a
contradictory manifest signal (`required: true` + accepted-coverage policy
degrades health rather than projecting accepted-coverage-green).

A connector author declaring `deferred`, `unsupported`, or `unavailable`
SHALL base that declaration on the credential and runtime substrate the
connector actually holds, not on a single dependency's feature surface. A
tool the connector wraps (a CLI, a library, an archive format) lacking a
capability is not sufficient grounds for declaring a stream
source-unavailable when the connector's own captured credential can reach
the source's API directly for that capability. `deferred`/`unsupported`/
`unavailable` SHALL be reserved for streams the connector's actual
credential and runtime cannot reach, not for streams a specific wrapped
tool's CLI happens not to expose.

#### Scenario: manifest schema accepts all valid coverage_policy values

**WHEN** a manifest stream declares `coverage_policy` with one of `collect`,
`deferred`, `inventory_only`, `unavailable`, or `unsupported`
**THEN** the reference-contract schema validation SHALL accept the manifest
without error.

#### Scenario: manifest schema rejects unknown coverage_policy values

**WHEN** a manifest stream declares a `coverage_policy` value outside the
recognized enum
**THEN** the reference-contract schema validation SHALL reject the manifest with
a type error.

#### Scenario: absence of coverage_policy is valid

**WHEN** a manifest stream does not declare `coverage_policy`
**THEN** the schema SHALL accept the manifest
**AND** the server SHALL treat the stream as `collect` (fully collected by
default).

#### Scenario: a wrapped tool's CLI gap is not a source-unavailability claim

**WHEN** a connector wraps an external tool (e.g. a CLI or archive format)
that does not itself expose a given source capability, but the connector's
own captured credential can call the source's underlying API for that
capability directly
**THEN** the connector author SHALL implement direct collection using that
credential rather than declaring the stream `deferred` or `unsupported`
**AND** the stream's manifest declaration SHALL reflect `collect` (the
default) once implemented, with no `availability` block asserting a
source-side limitation that does not exist.

#### Scenario: Slack stars, user_groups, reminders, and dm_read_states are collected, not deferred

**WHEN** the Slack connector holds a valid `xoxc` session token and `d`
session cookie (the credential captured by its `setup.credential_capture`
fields)
**THEN** the connector SHALL collect the `stars`, `user_groups`,
`reminders`, and `dm_read_states` streams via direct Slack Web API calls
(`stars.list`, `usergroups.list`, `reminders.list`, `conversations.info`)
using that same credential
**AND** the manifest SHALL declare no `coverage_policy` (default `collect`)
and no `availability` block for these four streams
**AND** a per-connection runtime failure to collect one of these streams
(e.g. an expired session, a workspace-side restriction) SHALL be expressed
as a `SKIP_RESULT` or retryable/terminal error scoped to that run, never as
a manifest-level `unavailable`/`unsupported` declaration.
