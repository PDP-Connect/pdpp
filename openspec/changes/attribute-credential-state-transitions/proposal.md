## Why

A connection revoke can change a stored credential without leaving durable
evidence of the actor, cause, or originating action. Operators then cannot
distinguish an owner action from maintenance or a provider-driven transition.

## What Changes

- Persist non-secret provenance for the latest stored-credential state change.
- Carry connection-revoke provenance atomically into the credential cascade.
- Require a closed revocation-reason token on every reference connection-revoke
  writer and log successful browser-enrollment TTL retirement.

## Capabilities

### Modified Capabilities

- `reference-connector-instances`: stored credential lifecycle evidence.

## Impact

- Additive SQLite and PostgreSQL schema fields and store writes.
- Reference connection-revoke, enrollment-retirement, and credential-store tests.
