# Northstar Native World Plan

Date: 2026-04-16

## Bottom line

`Northstar HR` should be the minimal native-provider reference world for PDPP.

Its job is not to be a fictional product with elaborate chrome. Its job is to prove that:

- a cooperating platform can expose PDPP natively
- Longview can request compensation records from it without any connector/runtime story leaking into the contract
- owner self-export works against the same stream model
- projection, revocation, and incremental sync remain the main truths of the system

The native path should feel like:

- one provider-local PDPP deployment
- one stream contract
- one owner path
- one Longview client path

It should not feel like:

- a personal server with nicer sample data
- a connector deployment in disguise
- a fake HR product UI

## What Northstar HR is

Northstar HR is a cooperating provider that speaks PDPP directly.

In the reference topology, it is the native path counterpart to the personal-server polyfill path.

It should provide:

- AS behavior for request, consent, grant, token, and revocation
- RS behavior for owner self-export and client-grant queries
- provider-local stream metadata
- seeded compensation records for one subject

It should not expose:

- connector registration
- connector manifests as the public contract
- Collection Profile runtime endpoints as part of the native path
- `connector_id` in public native request/query surfaces

Internally, the implementation may still reuse parts of the current `reference-implementation/server` substrate, but the public native contract must read as provider-native.

## Naming and vocabulary

The naming should be restrained and protocol-legible.

Provider name:

- `Northstar HR`

Provider identifier:

- stable provider-local ID, such as `northstar_hr`

Do not publicly use:

- connector terminology
- registry-style connector URLs
- source-selection language in the native path

Streams should use the same stream names already established in the Longview reference world:

- `pay_statements`
- `equity_grants`
- `benefits_enrollments`

Reason:

- Longview already teaches those names
- the current web reference and specimen data already depend on them
- keeping the same stream names makes the native and polyfill paths comparable without cognitive translation

## Minimal stream set

The smallest honest native provider world needs three streams, even if Longview only requires two on day one.

### 1. `pay_statements`

This is the anchor stream.

Why it is mandatory:

- it updates regularly
- it makes `changes_since` legible
- it makes field projection legible
- it is the clearest self-export proof

Required properties at the contract level:

- append-only semantics
- provider-local primary key
- payroll-cycle timestamps suitable for delta sync
- a small set of identity-heavy fields that Longview does not need
- a smaller granted field set that Longview does need

Minimum useful fields:

- `id`
- `employer`
- `pay_period`
- `gross_pay`
- `net_pay`
- `employee_id`
- `home_address`
- `bank_account_last4`
- `tax_id_fragment`
- `source_created_at`

Longview granted subset:

- `employer`
- `pay_period`
- `gross_pay`
- `net_pay`

### 2. `equity_grants`

This is the second required Longview stream.

Why it is mandatory:

- Longview’s reference story is not just payroll math
- it proves the client can request more than one compensation stream under one grant
- it keeps the native world from collapsing into “payroll export only”

Required properties at the contract level:

- mutable-state semantics
- one or more grant records
- fields for comparison and vesting interpretation
- no brokerage-account or beneficiary-heavy fields in the Longview-granted subset

Minimum useful fields:

- `id`
- `grant_type`
- `quantity`
- `vesting_start`
- `vesting_schedule`
- `grant_price`
- `brokerage_account_last4`
- `beneficiary_status`
- `source_updated_at`

Longview granted subset:

- `grant_type`
- `quantity`
- `vesting_start`
- `vesting_schedule`

### 3. `benefits_enrollments`

This should exist in the native world even if it remains optional in the first Longview request.

Why it matters:

- it proves that the provider-local model is broader than a two-stream demo
- it supports the optional-stream semantics already used in the reference consent flow
- it keeps the compensation world coherent

Required properties at the contract level:

- mutable-state semantics
- exactly enough plan/comparison data to matter
- excluded dependent/claims/provider-note detail in the Longview path

Minimum useful fields:

- `id`
- `plan_name`
- `coverage_tier`
- `employer_contribution`
- `employee_contribution`
- `plan_year`
- `dependent_summary`
- `claims_vendor`
- `provider_notes`
- `source_updated_at`

Longview optional subset:

- `plan_name`
- `coverage_tier`
- `employer_contribution`

## Seeded records

The native world should start with one subject and a very small, believable dataset.

Do not seed large volumes in the first pass. The goal is protocol legibility, not synthetic realism.

### Subject

Use one stable subject profile, e.g.:

- subject: one employee with a current compensation package and recent pay history

The subject should have:

- multiple recent pay statements
- one or more active equity grants
- one current benefits enrollment

### Minimum seeded dataset

#### `pay_statements`

Seed:

- 3 records minimum

Why:

- one record is too thin
- two records barely prove periodicity
- three records give the reference enough history to show self-export and delta sync honestly

Suggested shape:

- two older payroll cycles
- one most-recent payroll cycle

Also reserve one additional future record fixture for a delta-sync test.

#### `equity_grants`

Seed:

- 2 records minimum

Why:

- one grant is enough to render but not enough to feel like real compensation planning
- two grants allow a comparison and keep the stream from feeling ornamental

Suggested shape:

- one older grant
- one newer grant or refresh state

#### `benefits_enrollments`

Seed:

- 1 record minimum

Why:

- this stream exists mainly to prove optional-stream and broader compensation-world semantics in the first cut

### Seed quality rules

All seeded records should be:

- internally consistent across streams
- obviously compensation-related
- free of gratuitous fake complexity

Do not seed:

- claims histories
- brokerage transactions
- tax forms
- org charts
- performance reviews

Those can come later if a real protocol need appears.

## What must be true for owner self-export

The native path is not honest unless owner self-export works cleanly without connector semantics.

Minimum required truths:

1. Owner self-export must use the same provider-local stream names:
   - `pay_statements`
   - `equity_grants`
   - `benefits_enrollments`

2. The owner path must not require `connector_id`.

3. Owner access must return full-fidelity records for the provider-local subject, not the Longview-projected subset.

4. The self-export path must work against the same RS query surfaces used elsewhere, not a private data dump route.

5. The provider-local stream metadata must be discoverable without connector registration language.

6. `changes_since` must work on `pay_statements` for the owner path too, because it is part of the same RS behavior, not a client-only trick.

### Smallest honest owner-path proof

For the first cut, the owner proof only needs to show:

- list streams
- query `pay_statements`
- fetch one record
- observe a new payroll-cycle record via `changes_since`

That is enough to prove the owner path is real without inflating scope.

## What must be true for Longview access

The native path is not honest unless Longview can use its existing compensation-planning request model against Northstar HR without learning a different ontology.

Minimum required truths:

1. Longview can request `pay_statements` and `equity_grants` from the native provider without a `connector_id`.

2. The consent/grant path names provider-local streams and purpose, not connector machinery.

3. The grant projects the pay-statement field subset exactly as already taught in the reference flow:
   - granted:
     - `employer`
     - `pay_period`
     - `gross_pay`
     - `net_pay`
   - withheld:
     - `employee_id`
     - `home_address`
     - `bank_account_last4`
     - `tax_id_fragment`

4. The RS enforces that projection on query.

5. `changes_since` on `pay_statements` returns only newly added payroll-cycle records, not a full replay.

6. Revocation stops later Longview queries in the same way it already does elsewhere in the reference.

### Optional first-cut truth

The first cut does not need Longview to request `benefits_enrollments` in the native path, but the stream should exist so the optional-stream story remains truthful and ready.

## Smallest honest acceptance tests

The goal is not a huge native-provider suite. The goal is the smallest test set that would convince a skeptical implementer the native path is real and connector-free at the contract boundary.

### 1. Native owner self-export works without connector language

Test:

- issue an owner token for Northstar HR
- list provider-local streams
- query `pay_statements`
- assert:
  - no `connector_id` required
  - seeded records are returned
  - full pay-statement fields are visible

Why this test matters:

- it proves the owner path is provider-native
- it catches disguised connector assumptions immediately

### 2. Longview grant against native provider enforces field projection

Test:

- submit a Longview-style request to Northstar HR for `pay_statements` and `equity_grants`
- approve consent
- query `pay_statements` with the client token
- assert:
  - granted fields are returned
  - identity-heavy payroll fields are absent
  - no connector-scoped parameter is present in the request path

Why this test matters:

- it proves the native path teaches the same PDPP truth as the reference flow

### 3. Native `changes_since` on `pay_statements` returns only the new payroll cycle

Test:

- query baseline `pay_statements`
- insert one new payroll-cycle record into the native provider dataset
- query again with `changes_since`
- assert:
  - exactly one new record arrives
  - the record is the new payroll cycle
  - the flow works for owner and client paths as appropriate

Why this test matters:

- it proves the native world is not just static seeded data
- it makes continuous access honest

### 4. Revocation cuts off later native-provider access

Test:

- issue and approve a Longview grant
- successfully query `pay_statements`
- revoke the grant
- query again
- assert rejection

Why this test matters:

- it proves the native path is truly using the same grant-and-enforcement semantics

### 5. Native path does not expose polyfill/runtime-only surfaces as part of the contract

Test:

- verify the native-provider app does not mount connector/runtime-facing routes in its public path
- or, if the same engine is reused internally, verify those routes are not part of the native contract surface under test

Why this test matters:

- it keeps Northstar HR from being a personal server in costume

## What this plan deliberately excludes

Do not include in the first Northstar cut:

- elaborate HR product UI
- admin screens
- payroll operations logic
- employee onboarding flows
- benefits claims workflows
- scheduling/runtime/connector surfaces

Those are all distractions at this stage.

The native world needs:

- streams
- records
- request/consent/grant
- self-export
- projection
- sync
- revocation

Nothing more is required to prove the point honestly.

## Recommendation

Build Northstar HR as the smallest provider-local compensation world that can honestly satisfy Longview and owner self-export using the same PDPP core semantics already proven elsewhere.

If it cannot pass the five acceptance tests above without leaking connector assumptions, it is not yet a real native-provider reference path.
