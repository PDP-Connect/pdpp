# Request Shape Cutover Plan

Date: 2026-04-16  
Status: Code-oriented implementation plan  
Scope: move `e2e/server` away from the current flat `/grants/initiate` input toward one canonical internal selection-request object, without pretending the full AS flow is standardized yet

## Goal

Introduce a single canonical internal request object for the current AS flow so:

- route handlers stop depending on the legacy flat body shape
- pending-consent persistence stores one normalized request shape
- grant-building logic consumes one internal contract
- the server can accept both the current flat body and a more spec-shaped envelope during transition

This is **not** a plan to standardize the full AS flow yet. It is a cutover plan for the internal seam.

## Current state

The current path is:

- `POST /grants/initiate` in `e2e/server/index.js` forwards `req.body` directly into `initiateGrant()`
- `initiateGrant()` in `e2e/server/auth.js` stores that raw shape in pending consent
- `approveGrant()` reads that same raw shape back out and builds the grant from it

Today the accepted body is effectively:

```json
{
  "client_id": "concert_recommendation_app",
  "connector_id": "https://registry.pdpp.org/connectors/spotify",
  "purpose_code": "https://pdpp.org/purpose/personalization",
  "purpose_description": "Maintain a concert-recommendation profile over time",
  "access_mode": "continuous",
  "retention": { "max_duration": "P90D", "on_expiry": "delete" },
  "streams": [{ "name": "top_artists", "view": "basic" }]
}
```

That shape is convenient, but it is not a good long-term internal contract because:

- it is flatter than the current spec language
- it bakes transition-era assumptions into persistence
- it makes future auth/profile work harder because there is no internal distinction between transport compatibility and semantic request shape

## What should become canonical internally

The internal object should represent one **selection request** for the current demo AS flow.

Recommendation:

```ts
type CanonicalSelectionRequest = {
  request_kind: 'pdpp_selection_request';
  request_version: 'e2e.v1';

  client: {
    client_id: string;
    client_display?: {
      name: string;
      uri?: string;
      logo_uri?: string;
      policy_uri?: string;
      tos_uri?: string;
    } | null;
  };

  selection: {
    type: 'https://pdpp.org/data-access';
    connector_id: string;
    purpose_code: string;
    purpose_description?: string;
    access_mode: 'single_use' | 'continuous';
    retention?: {
      max_duration?: string;
      on_expiry?: string;
    } | null;
    streams: Array<{
      name: string;
      necessity?: 'required' | 'optional';
      view?: string;
      fields?: string[];
      time_range?: {
        since?: string;
        until?: string;
      };
      resources?: string[];
      client_claims?: Record<string, unknown>;
    }>;
  };

  compat: {
    source_shape: 'flat_v0' | 'authorization_details_v1';
    raw?: unknown;
  };
};
```

## Why this shape

### 1. It is singular on purpose

The current `e2e` AS flow is not ready to model a fully general OAuth authorization request with many `authorization_details` entries.

So the internal object should be:

- one canonical selection request
- not a fake fully-generalized AS model

That keeps the cutover honest.

### 2. It matches current grant-building needs

`approveGrant()` currently needs:

- `client_id`
- `connector_id`
- `purpose_code`
- `purpose_description`
- `access_mode`
- `retention`
- `streams`

This object keeps those fields intact while putting them in a structure closer to the spec’s conceptual model.

### 3. It makes transport compatibility explicit

The `compat.source_shape` field lets the implementation distinguish:

- legacy flat route input
- a newer envelope-shaped input

without polluting the semantic part of the object.

## Exact files to change

### 1. `e2e/server/auth.js`

This is the main cut point.

Add:

- a new normalization helper, preferably near the top of the file:
  - `normalizeSelectionRequest(input)`
- optionally a validation helper:
  - `assertCanonicalSelectionRequest(req)`

Change:

- `initiateGrant(params, opts)` to accept `input`, normalize it, and persist the canonical form
- `approveGrant()` to consume the canonical form from `pending_consents.params_json`

### 2. `e2e/server/index.js`

Keep the route shape the same:

- `POST /grants/initiate`

Change only:

- the route comment and local naming so it is obvious the route is an adapter into the canonical internal request shape, not itself the final standardized wire contract

### 3. `e2e/test/pdpp.test.js`

Keep all existing flat-body tests passing.

Add:

- one envelope-shaped request test
- possibly one helper that makes it easier to send either shape intentionally

### 4. `docs/archive/2026-04-e2e-superseded/pending-consent-seam-plan.md`

No direct code change required for this cutover, but the two plans should align:

- `params_json` in pending consent should store the canonical internal object, not the raw flat route body

## Recommended compatibility strategy

### Phase 1: dual input, single canonical internal shape

Accept two public request shapes at `POST /grants/initiate`:

#### A. Legacy flat shape

Continue accepting the current body exactly as tests and demo client already send it.

#### B. Envelope-shaped compat input

Also accept:

```json
{
  "client_id": "concert_recommendation_app",
  "client_display": {
    "name": "Concert Recommendation App"
  },
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "connector_id": "https://registry.pdpp.org/connectors/spotify",
      "purpose_code": "https://pdpp.org/purpose/personalization",
      "purpose_description": "Maintain a concert-recommendation profile over time",
      "access_mode": "continuous",
      "streams": [{ "name": "top_artists", "view": "basic" }]
    }
  ]
}
```

With these constraints:

- exactly one `authorization_details` entry
- `type` must be `https://pdpp.org/data-access`
- `profile` remains unsupported
- full OAuth redirect / response-mode semantics are still out of scope here

### Why this is the right compat boundary

It gives the server a path toward the spec’s conceptual model without pretending:

- that `POST /grants/initiate` is itself the final standardized authorization endpoint
- that the whole auth flow is already OAuth-complete

## Route adaptation strategy

### Keep adaptation at the edge

`POST /grants/initiate` should remain a thin adapter:

1. receive arbitrary request body
2. pass it to `initiateGrant()`
3. let `auth.js` normalize and validate it

Do **not** scatter normalization across routes and consent handlers.

### Why `auth.js` should own normalization

Because the actual semantic consumer lives there:

- pending-consent persistence
- manifest validation
- grant issuance

If normalization lives only in `index.js`, the persistence seam and the approval seam will drift again.

## Suggested normalization rules

### Input form A: legacy flat

Recognize as flat if:

- `authorization_details` is absent
- and top-level `connector_id`, `access_mode`, and `streams` are present

Map to canonical shape:

- `client.client_id = input.client_id || 'demo_client'`
- `client.client_display = null`
- `selection.type = 'https://pdpp.org/data-access'`
- `selection.connector_id = input.connector_id`
- `selection.purpose_code = input.purpose_code`
- `selection.purpose_description = input.purpose_description`
- `selection.access_mode = input.access_mode`
- `selection.retention = input.retention || null`
- `selection.streams = input.streams || []`
- `compat.source_shape = 'flat_v0'`

### Input form B: envelope-shaped compat input

Recognize as envelope if:

- `authorization_details` is an array

Constraints:

- array length must be exactly `1`
- entry `type` must equal `https://pdpp.org/data-access`

Map to canonical shape:

- `client.client_id = input.client_id || 'demo_client'`
- `client.client_display = input.client_display || null`
- `selection = first authorization_details entry` with only supported fields copied
- `compat.source_shape = 'authorization_details_v1'`

### Reject for now

Reject with `invalid_request` when:

- both flat fields and `authorization_details` are provided in a way that conflicts
- `authorization_details.length !== 1`
- `type` is missing or wrong
- `profile` is present
- required selection fields are absent

## How pending consent should change

The current pending-consent seam now persists `params_json`.

After this cutover:

- `params_json` should store the canonical internal object, not the incoming route body

This is important because it means:

- approval logic becomes independent of transport shape
- old pending-consent rows created from flat requests and new rows created from envelope-shaped requests behave identically

Recommended handling in `approveGrant()`:

```js
const request = JSON.parse(pending.params_json);
const params = request.selection;
const clientId = request.client.client_id || 'demo_client';
```

Then keep as much of the current grant-building logic intact as possible.

## Grant-building adaptation strategy

Keep the current grant model mostly unchanged for now.

That means in `approveGrant()`:

- use `request.selection.connector_id` where current code uses `params.connector_id`
- use `request.selection.streams` where current code uses `params.streams`
- use `request.client.client_id` where current code uses `params.client_id`

Do **not** try to redesign the issued grant shape in the same patch.

The cutover should be:

- route transport changes at the edge
- canonical internal object in the middle
- grant shape unchanged downstream

## Consent UI impact

Minimal.

`GET /consent/:deviceCode` currently reads:

- `params.client_id`
- `params.connector_id`
- `params.purpose_description || params.purpose_code`
- `params.access_mode`
- `params.retention`
- `params.streams`

After cutover it should read from the canonical object:

- client identity from `request.client`
- request semantics from `request.selection`

Minimal display rule:

- continue showing `client.client_id` if `client_display.name` is absent
- if `client_display.name` exists, prefer it in the consent screen

That gives a clean incremental improvement without dragging in the full client-metadata/trust rendering model yet.

## Minimal test changes

### Keep all current flat-body tests

Current helpers in `e2e/test/pdpp.test.js` use the flat shape. Keep them unchanged first so the compatibility path is proven.

### Add one new envelope-shaped initiation/approval test

Recommended new test:

- register connector as usual
- call `POST /grants/initiate` with:
  - `client_id`
  - `client_display`
  - one `authorization_details` entry
- approve via `/consent/:deviceCode/approve-api`
- assert:
  - token is issued
  - grant fields match expectations
  - poll returns approved

### Add one persistence-shape assertion

Since `pending_consents.params_json` is now important, add one narrow test or direct DB assertion:

- after initiation, inspect stored `params_json`
- verify it contains the canonical object shape, not the raw flat transport body

This is the best test that the internal seam actually moved.

### Optional rejection tests

Add one or two small negative tests for:

- multiple `authorization_details` entries
- wrong `type`

These should stay narrow and avoid overbuilding a conformance suite for a flow that is not yet standardized end-to-end.

## Suggested implementation order

1. Add `normalizeSelectionRequest(input)` in `e2e/server/auth.js`
2. Change `initiateGrant()` to normalize and persist canonical request
3. Change `approveGrant()` to read canonical request
4. Change consent rendering in `e2e/server/index.js` to read `client` + `selection`
5. Add one envelope-shaped positive test and one canonical-persistence assertion
6. Only then consider light cleanup of helper names and comments

## What not to do in this patch

Do **not**:

- turn `/grants/initiate` into a fake OAuth authorization endpoint
- add redirect-uri validation or client registration policy here
- support multiple `authorization_details` entries
- redesign the issued grant format
- make tests depend on a fully standardized auth flow that does not exist yet

## Bottom line

The right cutover is:

- **public compat in**: flat body or envelope-shaped body
- **canonical internal shape in the middle**: one `CanonicalSelectionRequest`
- **existing grant machinery out**: mostly unchanged

That keeps the implementation honest:

- closer to the current spec language
- safer for future auth/profile work
- still explicit that the full AS flow is not yet standardized end to end
