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

A manifest stream whose collection is an independent, directly-failable
call (a network request the connector makes on its own behalf, not data
derived from another stream's already-fetched result) and that is not
part of the connector's core, always-expected value SHALL declare
`required` explicitly as `false`, rather than relying on the implicit
`required: true` default. Silence on `required` for such a stream is a
manifest authoring defect: it makes an independently-failable, non-core
stream load-bearing for the whole connector run without that being a
deliberate choice.

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

#### Scenario: Slack stars, user_groups, reminders, and dm_read_states are collected, not deferred, and explicitly non-required

**WHEN** the Slack connector holds a valid `xoxc` session token and `d`
session cookie (the credential captured by its `setup.credential_capture`
fields)
**THEN** the connector SHALL collect the `stars`, `user_groups`,
`reminders`, and `dm_read_states` streams via direct Slack Web API calls
(`stars.list`, `usergroups.list`, `reminders.list`, `conversations.info`)
using that same credential
**AND** the manifest SHALL declare no `coverage_policy` (default `collect`)
and no `availability` block for these four streams
**AND** the manifest SHALL declare `"required": false"` explicitly on each
of these four streams, because each is an independent, directly-failable
API call and none is part of the connector's core value (messages,
channels, files, canvases)
**AND** a per-connection runtime failure to collect one of these streams
(e.g. an expired session, a workspace-side restriction) SHALL be expressed
as a `SKIP_RESULT` or retryable/terminal error scoped to that run, never as
a manifest-level `unavailable`/`unsupported` declaration.

#### Scenario: a manifest stream omitting required is a defect unless already grandfathered and unchanged

**WHEN** a connector manifest stream is added or edited and the stream is
collected via an independent, directly-failable call
**AND** the stream omits `required`
**THEN** the manifest is authored incorrectly — it must declare `required`
explicitly (`true` if the stream is core/load-bearing, `false` otherwise)
**AND** a build-time guardrail test SHALL fail unless the stream is already
on a frozen, non-growing allowlist of pre-existing omissions predating the
guardrail
**AND**, for a stream that is on that allowlist, the guardrail SHALL also
fail if the stream's semantic fields (its behavioral contract — schema,
`semantics`, coverage/cursor/incremental strategy, `coverage_policy`, and
similar fields, excluding purely cosmetic prose fields such as
`description`/`display`) no longer match the fingerprint recorded for it at
grandfathering time, so that editing a grandfathered stream's real behavior
while continuing to omit `required` is caught as loudly as adding a brand
new omission would be.

## ADDED Requirements

### Requirement: A non-required stream's failure SHALL NOT fail the whole connector run

When a connector's manifest declares a stream `required: false`, a runtime
failure while collecting that stream SHALL be represented as stream-scoped
evidence (a `SKIP_RESULT` message naming the stream and the failure reason)
and SHALL NOT cause the connector's `collect()` call to reject or the
overall run to terminate with `DONE.status = "failed"`, provided every
`required` stream in the same run completed without error.

This isolation is a per-connector authoring responsibility, not a runtime-
layer guarantee: `connector-runtime.ts`'s `START.scope.streams` protocol
does not carry manifest `required`/`coverage_policy` metadata into the
connector subprocess (that metadata is consumed only by the post-run
health/coverage rollup), so a connector author implementing an optional
stream SHALL catch that stream's own failure locally and convert it to a
`SKIP_RESULT` before returning from `collect()`, rather than relying on any
shared runtime mechanism to do so implicitly.

A `required` stream's failure is unaffected by this requirement and SHALL
continue to fail the whole run — the isolation applies only to streams the
connector's own manifest has explicitly opted out of load-bearing status.

#### Scenario: an optional stream fails after required streams already succeeded

**WHEN** a connector run has already emitted RECORD/STATE for every
`required` stream in scope
**AND** a subsequently-dispatched `required: false` stream throws (e.g. an
HTTP 401 from a direct API call)
**THEN** the connector SHALL emit a `SKIP_RESULT` for that stream naming a
reason and message
**AND** `collect()` SHALL still resolve
**AND** the run's terminal `DONE` message SHALL report `status: "succeeded"`
**AND** the previously-emitted RECORD/STATE for the required streams SHALL
remain intact and uncontested by the optional stream's failure.

#### Scenario: a required stream fails

**WHEN** a connector run's `required` (or implicitly-required, no
`required: false` declared) stream throws during collection
**THEN** the error SHALL propagate out of `collect()`
**AND** the run's terminal `DONE` message SHALL report `status: "failed"`
**AND** the failure's retryable classification SHALL follow the
connector's declared `retryablePattern`, unchanged by this requirement.

#### Scenario: Slack's four gap streams fail independently of each other and of required streams

**WHEN** the Slack connector's `stars` stream throws `slack_auth_failed`
while `user_groups`, `reminders`, `dm_read_states`, and every required
stream (workspace, channels, users, messages, files, canvases,
channel_memberships) either already succeeded or have not yet been
reached in dispatch order
**THEN** `stars`'s failure SHALL be reported as its own `SKIP_RESULT` and
SHALL NOT prevent `user_groups`, `reminders`, or `dm_read_states` from
still being attempted
**AND** SHALL NOT cause any required stream's already-emitted RECORD/STATE
to be discarded or the run to report `status: "failed"`.
