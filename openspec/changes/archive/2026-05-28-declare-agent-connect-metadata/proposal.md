## Why

The reference authorization-server metadata emits `agent_connect_endpoint`, but the public contract schema and docs do not declare it. Generated contract artifacts therefore under-report an endpoint that agents rely on.

## What Changes

- Add `agent_connect_endpoint` to the public AS metadata schema.
- Assert the field in provider metadata tests.
- Regenerate and update public reference docs.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects generated OpenAPI/docs for `GET /.well-known/oauth-authorization-server`.
- Does not change route behavior; it makes the contract match the existing live metadata.
