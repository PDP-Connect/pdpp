## Why

Pre-registered public clients are usable but not ideal: a third-party agent can discover demo client IDs, yet it still cannot create its own public client identity. The reference should model the ideal open-standards path: a public client can self-register its non-secret client identity, then separately request an owner-approved data grant.

## What Changes

- Make `/oauth/register` support unauthenticated public-client self-registration when DCR is enabled.
- Keep initial-access-token registration as an optional controlled/bootstrap lane; invalid bearer tokens still fail.
- Add CLI support for discovering the registration endpoint, registering a public client, and using that `client_id` for agent connect.
- Keep registration separate from authorization: creating a client SHALL NOT create a grant or bearer token.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects authorization-server metadata, DCR route behavior, CLI connect flow, tests, and docs.
- Public client registry writes become available to strangers, so the route must keep strict metadata validation and bounded rate limits.
- Does not weaken owner data control: data access still requires an owner-approved grant.
