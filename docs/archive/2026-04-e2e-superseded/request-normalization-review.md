# Request Normalization Review

Date: 2026-04-16

## Recommended next-patch shape

Introduce one new internal object in `e2e/server/auth.js` and use it only for the
pending-consent seam:

```ts
type NormalizedPendingRequest = {
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
      time_range?: { since?: string; until?: string };
      resources?: string[];
      client_claims?: Record<string, unknown>;
    }>;
  };
  realization_binding: {
    binding_kind: 'connector';
    connector_id: string;
  };
  compat: {
    source_shape: 'flat_v0' | 'authorization_details_v1';
  };
};
```

## Why this is the smallest safe move

- It gives `auth.js` one stable internal shape for `initiateGrant()`,
  `getPendingConsent()`, and `approveGrant()`.
- It moves `connector_id` out of the semantic request body without pretending the
  runtime is already neutral across native and polyfill realizations.
- It does not force any immediate grant-schema, RS, CLI, or runtime rewrite.

## Exact code-order recommendation

1. Add a local normalization helper in `e2e/server/auth.js`.
   - Input: current flat request body, plus a minimal path for future
     `authorization_details`.
   - Output: `NormalizedPendingRequest`.

2. Change `initiateGrant()` to persist the normalized object into
   `pending_consents.params_json`.
   - Do not persist the raw request as the main object anymore.

3. Change `getPendingConsent()` to return the normalized object as `request`
   rather than returning raw `params`.
   - If needed for one patch, also expose `params: request` as a temporary alias
     so `index.js` can be updated incrementally in the same change.

4. Change `approveGrant()` to read only from:
   - `request.client.client_id`
   - `request.selection.*`
   - `request.realization_binding.connector_id`

5. Update the consent page rendering in `e2e/server/index.js` to consume the
   normalized object directly.
   - Render `client.client_id` or `client_display.name`
   - Render `selection.purpose_*`, `selection.access_mode`, `selection.retention`
   - Render `selection.streams`
   - Render `realization_binding.connector_id` only as an implementation detail,
     not as the semantic center of the request

## Fields that should remain transitional in this patch

- `realization_binding.connector_id`
  - Keep it required for now.
  - Treat it as routing/binding state, not canonical request semantics.

- `compat.source_shape`
  - Keep it so tests and later cleanup can distinguish old flat transport from
    future request envelopes.

- `client.client_display`
  - Allow it, but do not require it yet.
  - The current flow can still render a minimal client identity safely.

- Single-entry `selection`
  - Do not generalize to multiple authorization objects in this patch.
  - One normalized selection request is enough to clean up the seam.

## What should stay omitted for now

- Any new grant table columns or issued-grant schema changes
- Any native-realization binding model beyond `binding_kind: 'connector'`
- Any generalized request registry or request-version negotiation
- Any CLI or RS transport changes
- Any attempt to make `index.js` or the consent page look fully RFC-shaped

## Top 3 regression risks and tests

1. Flat-request compatibility breaks at grant initiation
   - Test: current `/grants/initiate` flat body still returns device code and
     consent link.
   - Test: approval of that request still issues a valid grant/token pair.

2. Approval logic silently drifts because code still reads old flat fields
   - Test: `approveGrant()` issues the same manifest expansion, stream grants,
     `ai_training` behavior, and `connector_id` as before.
   - Test: grep/assert there are no remaining reads of
     `params.connector_id`, `params.streams`, `params.purpose_code`, or
     equivalent old flat paths inside `auth.js`.

3. Consent rendering or pending-consent lookup breaks on the new object
   - Test: `GET /consent/:deviceCode` renders from normalized fields and still
     shows streams, purpose, access mode, and retention correctly.
   - Test: pending-consent persistence round-trip works: initiate -> fetch
     pending consent -> approve.

## Bottom line

The next patch should introduce exactly one honest internal object:
`NormalizedPendingRequest`. It should be used only at the pending-consent/auth
seam, keep `connector_id` in `realization_binding`, and leave the rest of the
system untouched until this normalization layer is proven stable.
