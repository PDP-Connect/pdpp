# Fix introspection fail-open on manifest-storage faults

## Why

`introspect()` fails OPEN on an unexpected manifest-store / storage fault. In the
client-token branch (`reference-implementation/server/auth.js`), the persisted
grant is validated against its manifest inside a try/catch that returns an
inactive projection ONLY for a `grant_invalid`-coded error and silently swallows
every other error, then falls through to a `result` object pre-initialized to
`active: true`. An infrastructure fault — a manifest-store outage, a DB error —
is therefore converted into an authorization "active" decision: a token
introspects as active during an outage even though its grant could not be
validated.

This is a fail-open authorization bug: an operational failure (not even an
attack) resolves into granted access.

## What Changes

- Add a normative requirement to `reference-implementation-architecture`:
  client-token introspection SHALL fail closed — a genuine semantic
  grant-invalid projects the token inactive, but any other (unexpected) error
  encountered while resolving or validating the grant's manifest SHALL propagate,
  so introspection can never mark a token active on an infrastructure failure.
- Implement: in `introspect()`'s client branch, rethrow non-`grant_invalid`
  errors from both the inner (manifest-validation) and outer (grant-state) catch
  blocks instead of swallowing them.

## Deliberately preserved (not changed)

- A grant bound to an UNREGISTERED connector (manifest resolves to `null`) keeps
  the token active; the read path resolves the connector connector-first and
  returns a precise `not_found` there. This is the existing, tested "connector-
  first" behavior (`pdpp.test.js`: "polyfill client reads fail connector-first
  …"). This change does NOT move that failure earlier into introspection.

## Impact

- Affected spec: `reference-implementation-architecture` (introspection).
- Affected code: `reference-implementation/server/auth.js` (`introspect()` only).
- No change to the export surface, wire envelopes, routes, or schemas.
