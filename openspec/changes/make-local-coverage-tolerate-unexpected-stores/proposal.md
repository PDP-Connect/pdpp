## Why

`packages/polyfill-connectors/src/local-source-inventory.ts` treated an
unexpected store as fatal to a coverage snapshot:

```ts
const hasCommittedSnapshot =
  !malformed && duplicateStores.length === 0 &&
  unexpectedStores.length === 0 && missingStores.length === 0;
```

An unexpected store is one the collector reported that the server's descriptor
table no longer declares — the normal result of a device running a build older
than the server. One such name set `hasCommittedSnapshot = false`, then
`reliable = false`, then coverage axis `unknown`, rendered as "Not measured".

Measured on production: connection `cin_ece4bfe5096b8bf67a1468c2` ("peregrine
Codex") has **1,293,596 collected records**, summary evidence `state=fresh` with
every component `current`, a current heartbeat and a drained outbox — and
displays "Not measured". The only drift is a single legacy `logs` store. Nothing
is missing: every declared store is reported.

## What Changes

- An unexpected store no longer disqualifies a coverage snapshot.
- `unexpectedStores` is still returned, so the drift stays observable — it
  becomes informational rather than disqualifying.
- Missing, duplicate, and malformed remain fatal, unchanged.

## Capabilities

- Modified: local-agent-collector-completeness

## Impact

- `packages/polyfill-connectors/src/local-source-inventory.ts`
- `packages/polyfill-connectors/src/local-source-inventory.test.ts`
