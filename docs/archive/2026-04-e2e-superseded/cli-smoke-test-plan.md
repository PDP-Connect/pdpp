# CLI Smoke-Test Plan

Date: 2026-04-16  
Status: Working plan  
Scope: Current and near-term smoke/conformance coverage for `e2e/cli`

## Bottom line

The CLI smoke plan should be a **thin black-box harness** over the real `e2e` server, not a second implementation of the protocol in tests.

First goal:

- prove the current CLI can talk to the real AS/RS surfaces it claims to use

Second goal:

- pin which of those surfaces are real vs compat-only so the tests do not silently bless the wrong contract

Do **not** start with:

- provider-connect flows
- website integration
- table-snapshot churn
- a huge matrix of permutations

## Test harness shape

Add one new Node test file under `e2e/test/`, for example:

- `e2e/test/cli-smoke.test.js`

Harness strategy:

1. start the real AS/RS with `startServer`
2. register one real manifest
3. bootstrap owner and client tokens using current setup helpers
4. seed records using the existing seed connector
5. invoke the CLI as a child process:
   - `node cli/index.js ...`
6. assert on:
   - exit code
   - stdout JSON
   - stderr only where the command is explicitly reference-only or expected to fail

Use the same helper style as `e2e/test/pdpp.test.js`:

- in-memory DB
- ephemeral ports
- real HTTP surfaces

## Fixtures and setup needed

Use the smallest existing fixture world:

- manifest: `e2e/manifests/spotify.json`
- connector: `e2e/connectors/seed/index.js`
- subject: `u1`
- client id: `concert_recommendation_app`

Setup path for smoke tests:

1. `POST /connectors`
2. `POST /owner-token` to get owner token
3. run seed connector to ingest spotify records
4. `POST /grants/initiate`
5. `POST /consent/:deviceCode/approve-api`

Important rule:

- steps 2, 4, and 5 are currently **bootstrap compat/reference-only setup**, not the CLI contract under test
- the smoke tests may use them to arrange state, but should not pretend they are the stable CLI-facing public story

## Surface classification for the plan

### Real surfaces to smoke

These are the surfaces the CLI should be allowed to rely on as actual reference contract:

- `POST /introspect`
- `GET /v1/streams`
- `GET /v1/streams/:stream/records`
- `GET /v1/streams/:stream/records/:id`
- `POST /grants/:grantId/revoke`
- local offline inspection of JSON artifacts via `pdpp inspect`

### Compat/reference-only setup surfaces

These may be used to set up test state for now, but should be labeled as such in the plan and test comments:

- `POST /owner-token`
- `POST /grants/initiate`
- `POST /consent/:deviceCode/approve-api`
- `POST /grants/:grantId/tokens`

### Not in scope for smoke yet

- provider discovery
- device flow
- auth code + PKCE
- collection runtime state endpoints from the CLI
- scenario/reset helpers
- trace inspection

## Exact first smoke tests to add

### 1. `pdpp owner streams` smoke

Purpose:

- prove owner-path stream listing works against the real RS

Setup:

- bootstrap owner token
- seed spotify

Command:

```bash
node cli/index.js owner streams --connector-id https://registry.pdpp.org/connectors/spotify --rs-url "$RS_URL" --token "$OWNER_TOKEN" --format json
```

Assert:

- exit code `0`
- stdout parses as JSON array
- includes `top_artists`

Type:

- black-box

### 2. `pdpp owner query` smoke

Purpose:

- prove owner-path record query works with connector-scoped current surface

Setup:

- same as above

Command:

```bash
node cli/index.js owner query top_artists --connector-id https://registry.pdpp.org/connectors/spotify --rs-url "$RS_URL" --token "$OWNER_TOKEN" --limit 2 --format json
```

Assert:

- exit code `0`
- stdout parses as JSON object
- `data` length is `2`
- first record includes `data.popularity` or `data.followers` to confirm full owner access

Type:

- black-box

### 3. `pdpp owner get` smoke

Purpose:

- prove owner-path single-record fetch works

Setup:

- run test 2 first to capture a real record id

Command:

```bash
node cli/index.js owner get top_artists <record-id> --connector-id https://registry.pdpp.org/connectors/spotify --rs-url "$RS_URL" --token "$OWNER_TOKEN" --format json
```

Assert:

- exit code `0`
- stdout parses as JSON object
- `data.id` equals the requested record id

Type:

- black-box

### 4. `pdpp owner export` smoke

Purpose:

- prove owner export paginates and emits JSONL

Setup:

- same seeded spotify world

Command:

```bash
node cli/index.js owner export top_artists --connector-id https://registry.pdpp.org/connectors/spotify --rs-url "$RS_URL" --token "$OWNER_TOKEN" --format jsonl
```

Assert:

- exit code `0`
- stdout has multiple lines
- each line parses as JSON
- at least one line has `data.id`

Type:

- black-box

### 5. `pdpp query streams` smoke

Purpose:

- prove client-token path is working and constrained to granted streams

Setup:

- bootstrap grant via current compat flow
- capture approved client token

Command:

```bash
node cli/index.js query streams --rs-url "$RS_URL" --token "$CLIENT_TOKEN" --format json
```

Assert:

- exit code `0`
- stdout parses as JSON array
- includes only granted streams for the fixture grant

Type:

- black-box

### 6. `pdpp query records` smoke

Purpose:

- prove projected client query works, not just raw access

Setup:

- use a grant with spotify `top_artists` `basic` view

Command:

```bash
node cli/index.js query records top_artists --rs-url "$RS_URL" --token "$CLIENT_TOKEN" --limit 1 --format json
```

Assert:

- exit code `0`
- stdout parses as JSON object
- first record exists
- first record `data` includes `name` and `genres`
- first record `data` does **not** include `popularity` or `followers`

Type:

- black-box

### 7. `pdpp auth introspect` smoke

Purpose:

- prove the CLI can inspect both owner and client tokens against the real AS

Commands:

```bash
node cli/index.js auth introspect --as-url "$AS_URL" --token "$OWNER_TOKEN" --format json
node cli/index.js auth introspect --as-url "$AS_URL" --token "$CLIENT_TOKEN" --format json
```

Assert:

- exit code `0`
- owner result has `active: true` and `pdpp_token_kind: "owner"`
- client result has `active: true`, `pdpp_token_kind: "client"`, and a `grant_id`

Type:

- black-box

### 8. `pdpp grant revoke` smoke

Purpose:

- prove the CLI can hit the real revoke surface and the RS enforces revocation afterward

Setup:

- use approved client token and its `grant_id`

Command:

```bash
node cli/index.js grant revoke "$GRANT_ID" --as-url "$AS_URL" --format json
```

Follow-up:

- rerun `pdpp query records top_artists ...`

Assert:

- revoke command exits `0`
- follow-up query exits with HTTP-derived nonzero code
- stderr contains `Grant has been revoked` or equivalent `grant_revoked`

Type:

- black-box

### 9. `pdpp inspect grant|request|manifest` smoke

Purpose:

- prove offline artifact inspection works and stays usable without network

Fixtures:

- write one request JSON fixture
- use returned `grant` JSON from setup
- use `e2e/manifests/spotify.json`

Commands:

```bash
node cli/index.js inspect manifest e2e/manifests/spotify.json --format json
node cli/index.js inspect request /tmp/request.json --format json
node cli/index.js inspect grant /tmp/grant.json --format json
```

Assert:

- exit code `0`
- stdout parses as JSON
- expected summary keys are present

Type:

- golden-output only for field presence/shape, not full pretty-print snapshots

### 10. `pdpp grant token` compat-only smoke

Purpose:

- explicitly cover the current reference-only helper without normalizing it as core

Setup:

- use a continuous grant to avoid intentional `single_use` failure

Command:

```bash
node cli/index.js grant token "$GRANT_ID" --as-url "$AS_URL" --format json
```

Assert:

- exit code `0`
- stderr includes `Reference-only command`
- stdout parses as JSON and contains a `token`

Type:

- compat-only black-box

Important note:

- this should live in a separate compat-only section of the test file so it is visually obvious that it is not part of the stable contract

## Black-box vs golden-output rules

### Black-box

Use black-box assertions for all network commands:

- `owner *`
- `query *`
- `auth introspect`
- `grant revoke`
- `grant token`

Assert:

- exit code
- JSON parseability
- a few semantic fields
- postcondition where relevant

Do **not** snapshot:

- full pretty JSON
- table output
- transient request ids
- full error payloads

### Golden-output

Use golden-output only for narrow, stable offline surfaces:

- `inspect manifest --format json`
- `inspect request --format json`
- `inspect grant --format json`
- help/usage text if needed

Even here, prefer:

- key presence
- small structural snapshots

not:

- brittle full-file snapshots

## Minimum CI-worthy matrix

Keep CI narrow and executable.

### Owner path matrix

Required in CI:

1. `owner streams`
2. `owner query`
3. `owner get`
4. `owner export`

Shared fixture:

- one owner token
- one registered spotify manifest
- one seeded spotify dataset

### Debug path matrix

Required in CI:

1. `auth introspect` with owner token
2. `auth introspect` with client token
3. `grant revoke` + post-revoke query failure
4. `inspect manifest`
5. `inspect request`
6. `inspect grant`

### Compat-only matrix

Required in CI for now, but clearly labeled:

1. `grant token` on a continuous grant

Optional but not required in CI:

- negative test on `grant token` for `single_use`
- explicit smoke around `POST /owner-token`

Reason:

- bootstrap compat routes are setup machinery, not the CLI contract under test

## First near-term additions after the current tranche

Add only after the owner-path CLI and pending-consent seam are stable:

### 1. Client projection regression

One test that proves the CLI still sees projected client fields after request-model cleanup.

### 2. Native-path owner smoke

Repeat the owner-path matrix against the first native HR deployment once it exists.

### 3. Compat-route reduction

As the legacy auth routes are demoted, reduce the test harness dependence on:

- `/owner-token`
- `/grants/initiate`
- `/consent/:deviceCode/approve-api`

Do not add provider-connect CLI smoke until the first discovery anchor is pinned and implemented.

## Biggest ways this plan could still overbuild

### 1. Testing table output too early

Wrong move:

- snapshotting human-readable tables and spacing

Right move:

- force `--format json` in smoke tests wherever possible

### 2. Treating bootstrap helpers as CLI contract

Wrong move:

- adding CLI smoke around `auth login`-like wrappers that just call `/owner-token`

Right move:

- use compat routes only to arrange state, not as the main thing under test

### 3. Expanding into provider-connect now

Wrong move:

- adding discovery/login/device-flow smoke before the profile is concrete

Right move:

- keep CI centered on owner path + current debug path

## Final judgment

The first CLI smoke plan should prove one thing clearly:

- the current CLI is a real consumer of the reference AS/RS surfaces, with compat-only helpers kept visible and quarantined

If the tests do that, they will be useful both now and through the next cleanup tranche.
