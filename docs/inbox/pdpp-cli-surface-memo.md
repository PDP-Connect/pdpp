# PDPP CLI Surface Memo

Date: 2026-04-16  
Status: Working recommendation for the PDPP reference-implementation CLI

## Why this memo exists

PDPP needs a CLI not as polish, but as one of the strongest ways to keep the reference honest.

If the CLI can do real work against the same surfaces the reference engine exposes, then:

- implementers have a forkable operator/debug client
- tests can exercise the same contract humans use
- the future control plane has a natural parity target
- the website cannot quietly become required infrastructure

If the CLI instead depends on private database access, website helper routes, or demo-only shortcuts, it becomes a backdoor and weakens the reference.

## Bottom line

The PDPP CLI should be a **first-class reference consumer** with four primary jobs:

1. **Owner self-export and owner operations**
2. **Grant/debug/introspection inspection**
3. **Provider-connect flows via the companion profile, if supported**
4. **Reference-stack scenario control where that control is explicitly part of reference architecture**

The CLI should not be a hidden admin interface. It should consume the same protocol surfaces, profile surfaces, and reference-architecture surfaces that another implementation could realistically expose.

## Current repo reality

Today, the repo has:

- strong owner-token and RS query semantics in `spec-core.md`
- an authentication boundary memo in `spec-auth-design.md`
- a real `reference-implementation/` substrate with owner tokens, grant issuance, introspection, RS query, ingest, and state endpoints
- a demo script in `reference-implementation/client/demo.js`
- a now-meaningful `reference-implementation/cli/` surface for login, self-export, inspection, and trace/grant debugging

Important existing facts:

- owner self-export is already a live core pattern
- the current AS flow is still partly demo/reference architecture, not final normative core
- some reference seams are clearly non-portable today, including owner-token bootstrap helpers plus compat `/grants/initiate` and compat `/consent/:deviceCode/*`

So the CLI design should not simply mirror the current `reference-implementation/server/index.js` route list. It should classify surfaces carefully.

## Design standard

The CLI should feel like a blend of:

- Stripe CLI: real operator and developer leverage
- Temporal CLI: real system inspection and local-dev convenience
- Ory CLI: automation and migration/debug utility

For PDPP specifically, the CLI must also satisfy two harder constraints:

- it must preserve the distinction between **core protocol** and **reference architecture**
- it must stay useful if a third party forks `reference-implementation/` and discards the website entirely

## Core rule: command groups should map to real objects

The command taxonomy should be organized around stable protocol or runtime objects, not around page names or demo scenes.

Recommended top-level groups:

- `pdpp auth`
- `pdpp owner`
- `pdpp grant`
- `pdpp query`
- `pdpp provider`
- `pdpp run`
- `pdpp trace`
- `pdpp scenario`
- `pdpp inspect`

These are not all equally normative. Some are core, some are profile-driven, some are reference-only. But they map to real system objects:

- owner token / owner session
- grant
- stream / record query
- provider metadata
- collection run
- trace / event timeline
- reference scenario

## Surface classification: core vs profile vs reference-only

The CLI needs a hard surface taxonomy so it does not normalize private shortcuts.

### A. Core PDPP CLI commands

These should consume core PDPP surfaces only and should be expected to work against any conforming implementation that supports the relevant capability.

#### `pdpp owner`

Purpose:

- owner-authenticated self-export and owner-scope inspection

Candidate commands:

- `pdpp owner streams`
- `pdpp owner query <stream>`
- `pdpp owner get <stream> <record-id>`
- `pdpp owner export <stream>`

Expected substrate:

- standard RS query endpoints
- owner bearer token

Important note:

- these commands are conceptually core once an owner token exists
- token acquisition itself is not fully core-standardized

#### `pdpp query`

Purpose:

- query under an existing client access token

Candidate commands:

- `pdpp query streams`
- `pdpp query records <stream>`
- `pdpp query get <stream> <record-id>`

Expected substrate:

- standard RS query endpoints
- client bearer token

#### `pdpp inspect`

Purpose:

- inspect stable protocol artifacts already obtained by the client or exported from the system

Candidate commands:

- `pdpp inspect grant <file-or-json>`
- `pdpp inspect request <file-or-json>`
- `pdpp inspect manifest <file-or-json>`

Expected substrate:

- no network required for basic artifact rendering
- strict schema-aware display for grants, requests, manifests

This is especially valuable for tests and docs because it turns raw JSON into a stable inspection surface without inventing new semantics.

### B. Companion-profile CLI commands

These depend on the provider-connect/auth-discovery companion profile rather than core alone.

#### `pdpp auth`

Purpose:

- discover provider auth surfaces
- acquire tokens using supported OAuth flows

Candidate commands:

- `pdpp auth discover <provider-url>`
- `pdpp auth login --provider <provider-url>`
- `pdpp auth device --provider <provider-url>`
- `pdpp auth whoami`

Expected substrate:

- RFC 8414 metadata
- RFC 9728 protected resource metadata if used
- OAuth auth code + PKCE and/or device flow
- PDPP provider metadata/capabilities from the companion profile

Important boundary:

- the CLI should reuse OAuth flows directly
- the CLI should not define a new PDPP-flavored login protocol

#### `pdpp provider`

Purpose:

- inspect provider capabilities relevant to generic PDPP connectivity

Candidate commands:

- `pdpp provider show <provider-url>`
- `pdpp provider capabilities <provider-url>`
- `pdpp provider resources <provider-url>`

Expected substrate:

- companion-profile discovery metadata

These commands are useful because they make provider-connect behavior explicit and debuggable instead of burying it inside `login`.

### C. Reference-architecture CLI commands

These are allowed in the reference implementation, but they must be clearly marked as reference-only and never be confused with core interoperability.

#### `pdpp grant`

Purpose:

- create, inspect, revoke, and debug grants in the reference stack

Candidate commands:

- `pdpp grant request <request.json>`
- `pdpp grant show <grant-id>`
- `pdpp grant revoke <grant-id>`
- `pdpp grant token <grant-id>`

Important distinction:

- `grant revoke` can be a legitimate reference command if it maps to a real AS surface
- `grant token <grant-id>` is currently an admin/demo helper in the repo and should be treated as reference-only unless the final reference AS intentionally exposes it

#### `pdpp run`

Purpose:

- interact with collection/runtime executions in the reference stack

Candidate commands:

- `pdpp run start <connector-or-source>`
- `pdpp run list`
- `pdpp run show <run-id>`
- `pdpp run logs <run-id>`

Expected substrate:

- Collection Profile runtime
- reference control/event spine when it exists

These are not core PDPP commands. They are reference/runtime commands.

#### `pdpp trace`

Purpose:

- retrieve and inspect the append-only event/trace spine for grants, runs, queries, and revocations

Candidate commands:

- `pdpp trace list`
- `pdpp trace show <trace-id>`
- `pdpp trace tail`

This is reference-architecture today, but it should become one of the strongest shared surfaces for tests, CLI, and the future control plane.

#### `pdpp scenario`

Purpose:

- seed/reset the reference world for demos, tests, and local iteration

Candidate commands:

- `pdpp scenario list`
- `pdpp scenario seed <name>`
- `pdpp scenario reset <name>`

This is explicitly reference-only.

## Recommended command taxonomy

The default CLI help should make the surface classification obvious.

Example shape:

```text
pdpp auth      Acquire and inspect tokens via provider-connect flows
pdpp owner     Query and export owner data
pdpp query     Query data under a client token
pdpp grant     Reference grant operations and inspection
pdpp provider  Inspect provider capabilities and metadata
pdpp run       Reference collection/runtime operations
pdpp trace     Inspect reference event timelines
pdpp scenario  Seed and reset reference worlds
pdpp inspect   Render PDPP artifacts locally
```

The classification should also appear in docs/help output:

- `core`
- `profile`
- `reference`

Not every command needs the label inline, but the docs and generated help should make the boundary legible.

## Owner self-export flows

This is the most important day-one CLI job.

### Why it matters

- it is already close to the current core spec
- it gives immediate utility without waiting for full provider-connect maturity
- it creates a serious non-demo use case for the CLI

### Minimum viable flow

1. CLI obtains or is provided an owner token.
2. CLI calls RS endpoints directly.
3. CLI outputs records, streams, and artifacts in machine-usable formats.

### Concrete day-one commands

- `pdpp owner streams --provider <url>`
- `pdpp owner query pay_statements --provider <url> --limit 10`
- `pdpp owner export pay_statements --provider <url> --format jsonl`
- `pdpp owner get pay_statements <record-id> --provider <url>`

### Token acquisition

There are two valid near-term modes:

- `--token` / env-var injection for automation and tests
- profile-backed login/device flow when the provider-connect profile exists

The CLI should support both.

### Important boundary

Owner self-export should use the standard RS query endpoints, not a separate “export API,” unless the provider explicitly exposes one as additional reference architecture.

## Debug and introspection flows

The CLI should also be the best way to inspect the reference behavior at the protocol seams.

### Legitimate day-one debug flows

- introspect a token
- inspect a grant
- compare owner view vs client-granted view
- verify revocation behavior
- inspect `changes_since` cursors and paging

Candidate commands:

- `pdpp grant show <grant-id>`
- `pdpp query streams --token <client-token>`
- `pdpp query records pay_statements --changes-since <cursor>`
- `pdpp inspect grant ./fixtures/grant.json`

### Token introspection

This needs careful treatment.

For the reference implementation:

- a CLI command like `pdpp auth introspect --token ...` is useful and legitimate if it maps to a real AS introspection endpoint or equivalent

For generic interoperability:

- introspection is not usually a public end-user feature
- if exposed, it is likely deployment-specific or operator-scoped

So the CLI should distinguish:

- provider/public behavior
- reference/operator behavior

## Provider-connect flows

If the companion profile exists, the CLI becomes the natural proving ground for it.

### Why the CLI is the right first client

- device flow is already a natural fit for CLI
- discovery and metadata errors are easier to debug in terminal form
- it exercises the profile without needing a polished native-app shell first

### Minimum profile-backed commands

- `pdpp provider show <provider-url>`
- `pdpp auth login --provider <provider-url>`
- `pdpp auth device --provider <provider-url>`
- `pdpp owner streams --provider <provider-url>`

### What the CLI may assume only if the profile says so

- where AS metadata lives
- where RS metadata lives
- whether owner self-export is supported
- whether device flow is supported
- whether dynamic registration is supported

### What it should not assume

- that every provider supports the same login flow
- that client registration is always automatic
- that a provider-specific consent shortcut is portable

## CLI/API parity rules

These should be hard rules for the reference project.

### Rule 1: no website dependency

If a CLI operation depends on `apps/web`, the architecture is wrong.

### Rule 2: no private database access

The CLI should never read SQLite directly or bypass the AS/RS/runtime contracts.

### Rule 3: no dashboard-only powers

If a future control plane can do something the CLI cannot, that capability is suspect unless the reason is purely presentational.

### Rule 4: convenience commands may compose real calls

It is acceptable for one CLI command to orchestrate several public/reference calls.

Example:

- `pdpp owner export pay_statements` may call `streams`, then `records`, then paginate

That is not a backdoor. It is a composition.

### Rule 5: any command that requires a reference-only endpoint must be labeled as such

This is the most important anti-confusion rule.

## Anti-backdoor rules

The CLI must not normalize temporary demo conveniences into the public model.

### Suspect current surfaces

In the current `reference-implementation/server` code, these should not be treated as generic PDPP client surfaces:

- owner-token bootstrap helpers
- compat `POST /grants/initiate`
- compat `/consent/:deviceCode/*`

They may remain valid in the reference stack, but the CLI docs/help should treat them as:

- reference-only
- demo/operator surfaces
- not generic provider expectations

### Strong rule

If a CLI command cannot be explained as one of:

- core PDPP
- companion profile
- explicit reference architecture

then it probably should not exist.

## Output formats

The CLI should support machine-readable output by default and human-readable rendering as a deliberate option.

Recommended formats:

- `json` for structured single objects and lists
- `jsonl` for record export and stream-friendly piping
- `table` for interactive human inspection
- `text` only for terse status lines

Recommended rule:

- default to `json` for non-interactive environments
- default to `table` or concise human view for TTY, but always allow `--format json`

Examples:

- `pdpp owner streams --format table`
- `pdpp owner export pay_statements --format jsonl`
- `pdpp grant show <id> --format json`

### Exit codes

The CLI should use stable exit semantics so scripts and tests can rely on it.

Suggested pattern:

- `0` success
- `1` general CLI/runtime failure
- `2` invalid user input
- `3` authentication failure
- `4` permission/grant denial
- `5` not found
- `6` provider/profile incompatibility

The exact numbering is less important than consistency.

## Testability

The CLI should be one of the easiest surfaces to test.

### Required test layers

#### 1. Pure unit tests

For:

- argument parsing
- output rendering
- artifact inspection formatting
- command classification

#### 2. Contract tests with mocked HTTP

For:

- owner query flows
- auth/discovery flows
- output normalization
- error mapping to exit codes

#### 3. Full reference-implementation tests against the live reference stack

For:

- owner self-export
- grant revocation visibility
- query under client token
- changes_since flows
- provider-connect flow when available
- scenario seed/reset if implemented

### Golden-output tests

PDPP should strongly consider golden tests for:

- `pdpp inspect grant`
- `pdpp owner streams --format json`
- `pdpp provider show`

That will help keep docs, tests, and CLI examples aligned.

### AI-friendly design

The CLI should be scriptable and deterministic enough that future agents can use it as a stable tool for:

- seeding worlds
- capturing traces
- verifying invariants
- comparing owner and client-visible outputs

That means:

- stable machine output
- stable exit codes
- low-noise stdout/stderr discipline

## Recommended implementation sequence

1. Build `pdpp inspect` and `pdpp owner` first.
2. Add `pdpp query` for existing client-token behavior.
3. Add `pdpp grant` inspection and revocation where it maps to real AS surfaces.
4. Add `pdpp provider` and `pdpp auth` once the companion profile shape settles.
5. Add `pdpp run`, `pdpp trace`, and `pdpp scenario` only when the reference stack has the corresponding stable objects.

This keeps the CLI honest: useful immediately, then broader only as the substrate matures.

## Recommendation

PDPP should treat the CLI as a mandatory reference consumer, not a convenience wrapper.

The CLI should:

- lead with owner self-export and artifact inspection
- consume only real protocol/profile/reference surfaces
- clearly label reference-only commands
- avoid website coupling and hidden admin behavior
- adopt machine-readable outputs and stable exit codes
- become one of the main test harnesses for the reference implementation

If done well, the CLI will become the cleanest proof that PDPP has a real, forkable implementation surface rather than just a well-explained demo.
