# CLI Implementation Plan

Date: 2026-04-16  
Status: Code-oriented implementation plan for `e2e/cli`

## Why this plan exists

The repo now has a CLI surface memo, but the next implementation step needs to be concrete enough that work can start without re-deciding the architecture in code.

This plan translates the CLI surface into:

- an initial file/module layout under `e2e/cli`
- a first command set
- parsing and output strategy
- token/auth handling strategy
- explicit test hooks and test layers

The plan is deliberately grounded in the current `e2e/` substrate:

- `e2e/server/index.js` is the live AS/RS reference surface
- `e2e/runtime/index.js` is the live Collection Profile runner
- `e2e/client/demo.js` already exercises most of the current reference flows programmatically

The first CLI should reuse those surfaces and helpers where it improves correctness. It should not become a second demo script or a shell around the website.

## Existing substrate constraints

The current implementation matters for the CLI shape:

- `e2e/package.json` is a small Node ESM package with no CLI framework dependency today.
- `e2e/server/index.js` exposes:
  - `POST /introspect`
  - `POST /connectors`
  - `GET /connectors/:connectorId`
  - `POST /grants/initiate`
  - `POST /consent/:deviceCode/approve-api`
  - `GET /grants/poll/:deviceCode`
  - `POST /owner-token`
  - `POST /grants/:grantId/revoke`
  - `POST /grants/:grantId/tokens`
  - RS endpoints under `/v1/streams/*`
  - Collection Profile endpoints `/v1/ingest/:stream` and `/v1/state/:connectorId`
- `e2e/runtime/index.js` already exposes reusable runtime functions:
  - `runConnector(opts)`
  - `loadSyncState(connectorId, ownerToken, opts)`
- `e2e/client/demo.js` already contains working fetch wrappers, JSON printing, seed-world flows, and examples of current owner/grant/query behavior.

That suggests a CLI implementation strategy:

- reuse fetch + surface semantics from the demo, but move them into proper modules
- do not import presentation code from the website
- keep the CLI thin over HTTP, except where local artifact inspection is clearly better done offline

## Initial scope

The first implementation pass should build a useful CLI without waiting for the companion provider-connect profile or the future event spine.

### Phase 1 command set

Implement first:

- `pdpp inspect grant`
- `pdpp inspect request`
- `pdpp inspect manifest`
- `pdpp owner streams`
- `pdpp owner query`
- `pdpp owner get`
- `pdpp owner export`
- `pdpp query streams`
- `pdpp query records`
- `pdpp query get`
- `pdpp grant revoke`
- `pdpp grant token` as explicitly reference-only
- `pdpp auth introspect`

Delay until the substrate exists:

- `pdpp provider *`
- `pdpp auth login`
- `pdpp auth device`
- `pdpp run *`
- `pdpp trace *`
- `pdpp scenario *`

This keeps the first CLI useful and honest:

- real RS consumption
- real AS introspection/revoke usage
- local artifact inspection
- no premature dependency on provider metadata or trace infrastructure

## Package and entrypoint changes

Update `e2e/package.json`:

- add a `bin` entry
- add a `cli` script for local development

Recommended change:

```json
{
  "bin": {
    "pdpp": "./cli/index.js"
  },
  "scripts": {
    "cli": "node cli/index.js"
  }
}
```

No new third-party argument parser is required in the first pass. Node already gives enough for a clean minimal CLI.

## Proposed file/module layout

Create:

```text
e2e/cli/
  index.js
  commands/
    auth.js
    grant.js
    inspect.js
    owner.js
    query.js
  lib/
    args.js
    context.js
    errors.js
    exit.js
    fetch.js
    format.js
    output.js
    tokens.js
    urls.js
    inspect/
      grant.js
      manifest.js
      request.js
  fixtures/
    README.md
```

This layout is intentionally small:

- `commands/` owns command semantics
- `lib/` owns reusable mechanics
- `inspect/` keeps local renderers separate from network logic

Avoid a deep framework-style abstraction layer. The CLI will stay readable if each command module is a thin wrapper around one or two reusable lib functions.

## Module responsibilities

### `cli/index.js`

Owns:

- top-level argv dispatch
- help text
- subcommand selection
- exit code normalization

Should:

- parse the first positional token as the command group
- hand off the remaining argv to a command module
- catch `PdppCliError` and render it consistently

Should not:

- contain network logic
- contain formatting logic beyond help text

### `cli/lib/args.js`

Owns:

- minimal argument parsing helpers
- repeated flag extraction
- required-option validation

Recommended style:

- use a small custom parser over `process.argv`
- or use `node:util parseArgs` if it stays readable

Do not add a large dependency like Commander or Yargs in the first pass unless the built-in approach becomes clearly painful.

Why:

- the command set is still small
- a thin parser keeps the CLI easier to fork and inspect

### `cli/lib/context.js`

Owns:

- resolving shared execution context for each command

Context should include:

- `asUrl`
- `rsUrl`
- `outputFormat`
- `isTty`
- `tokens`
- `fetchJson`

This is where defaults should be consolidated so command modules do not each reinvent env handling.

### `cli/lib/urls.js`

Owns:

- AS/RS URL resolution rules

Initial resolution order:

1. explicit flag
2. env var
3. local default

Recommended env vars:

- `PDPP_AS_URL`
- `PDPP_RS_URL`
- `PDPP_OWNER_TOKEN`
- `PDPP_CLIENT_TOKEN`

Reference-only backward-compatible fallbacks are acceptable initially:

- `AS_URL`
- `RS_URL`
- `VANA_PS_TOKEN`

But the CLI docs should lead with `PDPP_*` names.

### `cli/lib/tokens.js`

Owns:

- token lookup rules
- token source precedence
- reference-only local auth-store reading if needed later

Initial strategy:

- support explicit `--token`
- support env vars
- optionally support a local JSON auth file later, but do not require it

Resolution order for owner commands:

1. `--token`
2. `PDPP_OWNER_TOKEN`
3. `VANA_PS_TOKEN`

Resolution order for client commands:

1. `--token`
2. `PDPP_CLIENT_TOKEN`

Do not invent persistent credential storage in phase 1. The provider-connect profile may justify it later.

### `cli/lib/fetch.js`

Owns:

- JSON fetch wrapper
- bearer header injection
- error normalization
- timeout handling

This should be extracted from the fetch pattern already visible in `e2e/client/demo.js`, but made reusable and less theatrical.

Functions:

- `fetchJson(url, opts)`
- `fetchNdjson(url, opts)` for export later if useful

Errors should map structured PDPP error bodies into `PdppCliError`.

### `cli/lib/errors.js`

Owns:

- error classes
- server error mapping
- command-usage error mapping

Recommended classes:

- `PdppCliError`
- `PdppUsageError`
- `PdppHttpError`

Each should carry:

- `message`
- `exitCode`
- optional `details`

### `cli/lib/exit.js`

Owns stable exit-code mapping.

Recommended constants:

- `0` success
- `2` usage error
- `3` auth failure
- `4` permission/grant denial
- `5` not found
- `6` unsupported profile/provider capability
- `1` all other failures

### `cli/lib/format.js`

Owns:

- JSON formatting
- JSONL output for exports
- table rendering

Initial supported formats:

- `json`
- `jsonl`
- `table`

Keep table rendering simple:

- no dependency initially
- a compact fixed-width renderer is enough for streams and list outputs

### `cli/lib/output.js`

Owns:

- choosing default format based on TTY
- printing objects consistently
- keeping stdout machine-clean

Rule:

- primary data goes to stdout
- diagnostics and non-data messages go to stderr

This is critical for testability and shell composition.

### `cli/lib/inspect/*.js`

Own:

- local rendering of grants, requests, and manifests

These modules should not fetch or infer network state.

Functions:

- `renderGrant(grant, opts)`
- `renderRequest(request, opts)`
- `renderManifest(manifest, opts)`

Each should support:

- `json`
- `table`

Why this matters:

- these commands are ideal golden-output test targets
- docs can use the same renderer later

## Command module plans

### `cli/commands/inspect.js`

Implements:

- `pdpp inspect grant <path-or-stdin>`
- `pdpp inspect request <path-or-stdin>`
- `pdpp inspect manifest <path-or-stdin>`

Implementation details:

- accept a filesystem path or `-` for stdin
- parse JSON
- call the corresponding renderer

This is the easiest first command group and should be implemented first.

### `cli/commands/owner.js`

Implements:

- `pdpp owner streams`
- `pdpp owner query <stream>`
- `pdpp owner get <stream> <record-id>`
- `pdpp owner export <stream>`

Underlying surfaces:

- `GET /v1/streams`
- `GET /v1/streams/:stream/records`
- `GET /v1/streams/:stream/records/:id`

Key flags:

- `--provider` or `--rs-url`
- `--token`
- `--limit`
- `--cursor`
- `--changes-since`
- `--connector-id` for current reference-world compatibility
- `--format`

Note on `--connector-id`:

- the current `e2e` RS query layer still often expects `connector_id`
- the CLI should expose it explicitly rather than hiding it
- once the reference world converges on cleaner multi-provider semantics, this can become less prominent

`owner export` should:

- page until exhaustion unless `--limit` is set
- default to `jsonl` for large record output
- support `--out <file>` later, but first pass can write to stdout only

### `cli/commands/query.js`

Implements:

- `pdpp query streams`
- `pdpp query records <stream>`
- `pdpp query get <stream> <record-id>`

Same underlying RS routes as `owner`, but with client token semantics.

Keep `owner` and `query` separate even if they share lib functions. That separation makes the auth boundary legible.

### `cli/commands/grant.js`

Implements in phase 1:

- `pdpp grant revoke <grant-id>`
- `pdpp grant token <grant-id>`

Potential phase-2 additions:

- `pdpp grant request <request.json>`
- `pdpp grant poll <device-code>`

Important classification:

- `revoke` is plausible as a real reference AS surface
- `token` is reference-only for now because it maps to `/grants/:grantId/tokens`

The command help should say that explicitly.

### `cli/commands/auth.js`

Implements in phase 1:

- `pdpp auth introspect --token <token>`

Potential phase-2 additions:

- `pdpp auth discover`
- `pdpp auth device`
- `pdpp auth login`
- `pdpp auth whoami`

Why start with introspect:

- the AS already supports `/introspect`
- it is immediately useful for debugging
- it creates shared logic that later auth commands can reuse

## Parsing strategy

Keep the parser narrow and unsurprising.

### Suggested approach

- parse top-level `process.argv.slice(2)`
- dispatch on the first token
- let each command module parse its own flags

Helpers in `args.js`:

- `takeFlag(args, '--token')`
- `takeOptional(args, '--limit')`
- `takeRequiredPositional(args, 0, 'stream')`
- `assertNoUnknownFlags(args, knownFlags)`

This is enough for the initial command set.

Do not overbuild nested subcommand metadata tables until the command count demands it.

## Output strategy

The CLI should be machine-friendly first and human-friendly second, without making either mode ugly.

### Defaults

- when stdout is a TTY:
  - `table` for list-ish commands
  - `json` for single-object inspection commands
- when stdout is not a TTY:
  - `json` or `jsonl` as appropriate

### Command-specific defaults

- `owner streams` -> `table`
- `query streams` -> `table`
- `owner query` -> `json`
- `query records` -> `json`
- `owner export` -> `jsonl`
- `inspect *` -> `json`
- `auth introspect` -> `json`

### Formatting discipline

- no ANSI color in machine output
- if colors are added later, only add them in TTY human mode
- do not mix status chatter with data on stdout

## Auth and token handling

The first pass should stay simple and explicit.

### Phase 1 token model

- no persistent login store required
- explicit `--token` or env vars
- `auth introspect` to verify what a token is

### Reference-only bootstrap

If the local reference stack remains dependent on `POST /owner-token` for bootstrapping, add a clearly labeled helper command in a later phase:

- `pdpp auth issue-owner --subject <id> --reference-only`

But do not add it in phase 1 unless needed immediately. It is a demo/reference bootstrap, not a portable provider behavior.

### Future provider-connect model

When the companion profile exists, add:

- provider metadata discovery
- device flow login
- optional local token cache file

If a token cache is introduced later, put it behind:

- `cli/lib/token-store.js`

and keep the storage format simple JSON, not SQLite or a hidden service.

## Test hooks and test plan

The CLI should be easier to test than the current demo script.

### Test file layout

Create:

```text
e2e/test/cli/
  inspect.test.js
  owner.test.js
  query.test.js
  grant.test.js
  auth.test.js
```

### Pure test seams

Make these functions directly importable:

- `runCli(argv, deps)` from `cli/index.js` or `cli/lib/app.js`
- renderers in `cli/lib/inspect/*.js`
- `formatOutput(value, opts)` from `cli/lib/output.js`
- `buildContext(argv, env)` from `cli/lib/context.js`

This is important: the CLI entrypoint should be a thin wrapper around a pure-ish `runCli()` function so tests do not need to spawn subprocesses for every case.

### Test layers

#### 1. Unit tests

For:

- arg parsing
- token resolution precedence
- renderer output
- exit-code mapping

#### 2. Mocked HTTP tests

For:

- RS list/query/get calls
- AS introspection
- revoke flow
- server error mapping

Approach:

- inject `fetchJson` via `deps`
- do not monkeypatch global `fetch` when easy injection will do

#### 3. Full E2E subprocess tests

For:

- owner self-export against the live reference server
- client query against issued token
- revoke -> query failure
- introspect output against live AS

These should follow the same pattern as existing `e2e/test/pdpp.test.js`, starting the server and then invoking `runCli()` directly or spawning `node cli/index.js`.

### Golden tests

Golden output tests are worth adding early for:

- `inspect grant`
- `inspect manifest`
- `owner streams --format table`

They will make drift visible without requiring browser review.

## Reuse plan from current code

The CLI should reuse and extract from current code rather than rewrite blindly.

### Reuse from `e2e/client/demo.js`

Extract or replicate with cleanup:

- `apiCall()` shape -> `cli/lib/fetch.js`
- arg reading patterns -> `cli/lib/args.js`
- JSON pretty printing -> `cli/lib/output.js`

Do not reuse:

- theatrical ANSI-heavy presentation
- hard-coded demo story flow
- direct orchestration of many unrelated steps in one file

### Reuse from `e2e/runtime/index.js`

Potential later reuse:

- `runConnector()`
- `loadSyncState()`

Only once `run` commands are implemented.

### Reuse from `e2e/server/index.js`

Not by import. Reuse by consuming its HTTP surfaces.

The CLI should not directly import server internals.

## Minimal implementation order

### Step 1

Scaffold:

- `e2e/cli/index.js`
- `e2e/cli/lib/{args,context,errors,exit,fetch,format,output,tokens,urls}.js`
- `e2e/cli/commands/{inspect,owner,query,grant,auth}.js`

### Step 2

Implement:

- `inspect grant`
- `inspect request`
- `inspect manifest`

### Step 3

Implement:

- `owner streams`
- `owner query`
- `owner get`
- `owner export`

### Step 4

Implement:

- `query streams`
- `query records`
- `query get`

### Step 5

Implement:

- `auth introspect`
- `grant revoke`
- `grant token` with explicit reference-only labeling

### Step 6

Add:

- unit tests
- mocked HTTP tests
- one live E2E test path for owner export and revoke behavior

## Anti-bloat rules

1. Do not add `run`, `trace`, or `scenario` commands until the corresponding stable substrate exists.
2. Do not add provider-connect login flows until the companion profile decisions are written down.
3. Do not add a token database, background daemon, or local web UI to make the CLI “nicer.”
4. Do not import website code into the CLI.
5. Do not let the CLI use private SQLite access as a shortcut.

## Recommendation

Build `e2e/cli` as a small Node ESM app with:

- zero or near-zero new dependencies
- a pure-ish `runCli()` core
- explicit separation between command modules and reusable libs
- owner/query/inspect first
- auth/profile/runtime expansion only when the substrate justifies it

That will produce a CLI that is immediately useful, testable, and architecturally honest.
