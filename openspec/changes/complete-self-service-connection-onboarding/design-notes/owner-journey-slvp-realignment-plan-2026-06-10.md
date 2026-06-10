# Owner Journey SLVP Realignment Plan

Status: proposed plan
Owner: reference implementation owner
Created: 2026-06-10
Related:
- `openspec/changes/complete-self-service-connection-onboarding/`
- `tmp/workstreams/connection-onboarding-alignment-audit-2026-06-10.md`
- `design-notes/full-context-refresh.md`

## Why This Plan Exists

The current implementation improved internal construction but failed the owner
acceptance walkthrough. The failure was not one bad string or one missing test.
The implementation optimized for these criteria:

- setup planner is shared;
- static-secret fields are manifest-authored;
- Console has fewer provider-specific branches;
- OpenSpec validates;
- Docker deploys.

Those are necessary, but they are not the acceptance target. The acceptance
target is the owner journey:

> A self-hosted owner can add, understand, monitor, and manage multiple source
> accounts across the supported connector catalog from shipped surfaces, without
> a PDPP repo checkout, unpublished CLI, internal ids, or developer vocabulary.

This plan resets the implementation bar around that target.

## Target User

Primary target user:

- Owns a PDPP instance on Docker, Railway, Fly, or a VPS.
- May have one or more accounts per provider.
- Is technical enough to deploy a service and copy commands, but is not a PDPP
  contributor and should not need a monorepo checkout.
- Wants to populate a personal server with records, then grant read access to AI
  apps or agents.

Secondary target user:

- Trusted local owner-agent or CLI user helping the owner operate the instance.
- May initiate setup or explain status, but does not receive provider secrets,
  owner cookies, browser session cookies, or grant-scoped MCP bearer material.

Not the target user for the normal setup UI:

- A PDPP maintainer running package internals from the monorepo.
- A connector developer proving an experimental browser collector path.

Developer/maintainer procedures can exist, but they must not be presented as
ordinary owner setup.

## SLVP Ideal For This Scope

The SLVP ideal is an owner-centered connection cockpit, not a raw setup-plan
catalog.

It has five properties:

1. **Findable:** The owner starts from `Sources` / `Connections`, not from a
   mixed "Connect AI apps + add sources + developer CLI preview" page. Agent
   connection setup remains available but secondary.
2. **Truth-separated:** For each connector, the UI separately answers:
   - Do I already have data/connections for this connector?
   - Can I add another account from shipped self-service surfaces today?
   - If not, what is the safe next status: packaged path pending, existing-only,
     developer proof only, deployment prerequisite, or unsupported?
3. **One next action:** Each card or flow has one owner-facing primary action.
   Raw planner states remain behind diagnostic disclosure.
4. **No developer assumptions:** Normal UI never asks for a repo checkout,
   package-internal command, unpublished CLI command, internal id mapping, or
   env-var jargon.
5. **Visible lifecycle:** After setup starts, the owner sees a pending, running,
   active, failed, or needs-attention state. No invisible draft black holes.

The setup planner remains important, but it is not the UX. It is the engine that
feeds the owner-centered projection.

## Alignment Contract

Before claiming another tranche is accepted, the owner and RI owner should agree
on the following acceptance contract.

### Owner acceptance matrix

Every row below must have an explicit pass/fail result, evidence path, and any
known residual risk.

| Journey | Acceptance bar |
|---|---|
| Add Gmail account | Owner can use dashboard, follow help link without losing form context, submit credential, see pending/running state, and see active connection or actionable failure. |
| Add second Gmail account | Owner can submit another account and see a distinct connection id/label/status, with no credential overwrite. |
| Add GitHub account | Same static-secret acceptance as Gmail, with connector-authored labels/help. |
| Existing connector with data | Card distinguishes existing working data from whether adding another account is self-service supported. |
| Chase / ChatGPT | UI must not imply inert "Track only" if existing connections work; if add-new is not productized, say "Existing data works; adding a new account is not self-service yet" and do not show developer commands. |
| Amazon | Either a packaged non-developer setup path works, or the owner UI demotes it to "developer proof only / not self-service" and does not present repo commands as setup. |
| Local collectors | Any shown command works from a clean shell using a published package, not monorepo internals. |
| CLI preview | Every shown `pdpp ...` command works with the published package/version shown in the UI, from outside the repo. |
| Railway-like owner | Setup requires no source credential env vars per account and no local repo checkout. |
| Failure/recovery | Pending setup/run failure is visible with next action and without leaked secrets. |

### Negative acceptance checks

The implementation fails if any normal owner UI contains:

- `packages/...`;
- `pnpm --dir`;
- `PDPP monorepo checkout`;
- "replace placeholders" without exact copyable values;
- "env var per account" normal-path language;
- unpublished CLI commands;
- ambiguous `connection_id` / `source_instance_id` instructions;
- hidden draft/pending state after a setup submit.

Advanced diagnostics may expose technical ids, but only when clearly labeled
and not required for the normal path.

## Revised Information Architecture

### Keep two surfaces separate

`Sources / Connections`

- Purpose: populate and manage the owner data store.
- Shows existing connections, add-account paths, pending setup, runs, schedules,
  freshness, coverage, revoke/delete.
- This is where data-source setup belongs.

`Connect AI apps`

- Purpose: grant read access to data already in PDPP.
- Shows MCP URL, Claude Code/Codex/ChatGPT setup, CIMD identities, CLI/agent
  read entrypoints.
- Must not be mixed with source-account setup except for a pointer like "Need
  more data? Add sources."

Current `/dashboard/connect` does too much. The SLVP endpoint may remain, but
the IA should lead with `Sources` for data setup and keep "Connect AI apps" as
agent/client setup.

### Source card projection

Each source card should be a projection of three layers:

```text
manifest identity
  display name, connector key, setup descriptors, capabilities

existing connection state
  active/pending/revoked count, last run, records, freshness, coverage

add-account support state
  add now, finish on this device, requires deployment setup,
  existing/manual only, developer proof only, unsupported
```

Do not show raw setup-plan states as the primary label. Owner-facing labels:

- `Add now`
- `Finish on this device`
- `Needs deployment setup`
- `Existing data only`
- `Developer proof only`
- `Not supported yet`
- `Setting up`
- `Needs attention`

Diagnostic details can expose:

- setup modality;
- proof gate;
- runbook path;
- internal ids;
- planner reason.

### Existing-working vs add-new support

The key UI change is to stop conflating these:

```text
connector works in this instance  !=  owner can add a new account self-service
```

Examples:

- ChatGPT with an existing active connection:
  - Primary: "1 active connection · last run ..."
  - Add account state: "Adding a new account is not self-service yet."
  - No "Track only" primary status.

- Gmail:
  - Primary: "Add account"
  - Existing: "1 active connection" if present.
  - After submit: "Setting up the owner@... · first sync running."

- Amazon:
  - If no packaged path: "Developer proof only" or hidden from normal Add list
    unless advanced mode is enabled.
  - No monorepo commands in owner flow.

## Technical Design Requirements

### 1. Shared state model must include setup attempts

The current `draft`/first-ingest activation model hides too much. Add or expose
a setup attempt view that can show:

- `setup_attempt_id` or draft connection id;
- connector key and display name;
- owner-entered non-secret account label/identity;
- state: `draft`, `credential_captured`, `first_sync_running`,
  `active`, `failed`, `needs_attention`, `abandoned`;
- current run id if any;
- last error and remediation;
- created/updated timestamps;
- eventual `connection_id` once active.

This may be backed by existing connector instance rows if they already carry the
needed state, but the owner projection must make pending setup visible.

### 2. Public/package commands are a contract

Any command rendered in UI must satisfy one of:

- uses a published package and exact version/tag shown in the UI;
- is a standard shell command available to the owner;
- is hidden behind a "developer proof" disclosure clearly labeled as not a
  normal owner path.

The UI must not render `pdpp owner-agent ...` until the published `@pdpp/cli`
contains it and a clean-shell test passes.

### 3. Browser-bound setup must be productized or demoted

There are only two SLVP-consistent options for Amazon/browser-bound sources:

Option A: Productize browser setup.

- Publish or package a browser collector command that works outside the repo.
- Make enrollment and run commands exact/copyable.
- Use stable names: `device_id`, `device_token`, `source_instance_id`, and
  `connection_id` must map clearly.
- The UI should pass values through generated commands so the owner does not
  replace placeholders manually.
- Prove end-to-end with a real owner browser session.

Option B: Demote from normal self-service.

- Show as "Developer proof only" or "Not self-service yet."
- Do not show code generation or repo-run commands to normal owners.
- Existing active connections still appear and remain manageable.

Until Option A is shipped, Option B is the honest SLVP path.

### 4. Static-secret setup must preserve task continuity

Help links for provider credential creation must:

- open in a new tab/window;
- make that explicit in copy;
- keep the form state available when the owner returns;
- avoid saying generic "Open setup page" when the connector descriptor can say
  "Open provider credential page" or equivalent.

After submission, the owner should land on a setup status page or an inline
status card, not a one-time redirect notice.

### 5. Terminology must be owner-safe

Owner-facing normal path terms:

- `connection`
- `source`
- `account`
- `device`
- `setup`
- `sync`
- `records`
- `needs attention`

Advanced-only terms:

- `connector_instance_id`
- `source_instance_id`
- `device_token`
- `proof gate`
- `setup modality`
- `runbook`
- env var names

If a command needs an id, the UI should supply it directly or label it exactly.
No "connection id" field should accept a `source_instance_id`.

### 6. Operations must catch low disk before restart

The deployment incident exposed an operational requirement:

- Reference-stack restart/build should preflight root/Docker free space.
- Dashboard deployment readiness should report low disk risk for data-heavy
  instances.
- The fix should not delete data automatically; it can recommend build-cache
  pruning with explicit operator action.

This is adjacent to the connection journey, but acceptance should record it as
a discovered operational hardening item.

## Implementation Plan

### Phase 0: Stop the bleeding

Goal: remove misleading owner UI before building the ideal.

Tasks:

- Hide CLI preview commands from source cards unless the command is proven
  available in the published package.
- Remove or demote Amazon/manual browser setup from normal owner Add flow until
  it has a packaged non-repo command.
- Replace raw statuses:
  - `Track only` -> explicit existing/add distinction;
  - `Manual setup` -> only if it is actually owner-usable without repo checkout;
  - `Ready with provider secret` -> `Add account`;
  - `No deployment env var per account` -> owner-safe copy or advanced detail.
- Update static-secret help links to open a new tab and preserve form context.
- Add regression tests that fail on normal owner UI containing repo commands,
  unpublished CLI commands, or env-var jargon.

Acceptance:

- The current live page no longer invites the owner into a dead Amazon path.
- No source card shows a CLI command that fails under `npx @pdpp/cli`.
- Gmail/GitHub forms preserve task continuity.

### Phase 1: Build the owner acceptance harness

Goal: make alignment testable before more feature work.

Tasks:

- Add a small owner-journey acceptance test harness that can run against local
  or live origin with owner auth:
  - fetch Sources/Add page;
  - assert visible copy constraints;
  - assert no developer-only commands;
  - assert every shown command has a declared verification mode;
  - optionally submit static-secret flow with test connector credentials.
- Add a clean-shell CLI command test for every UI-rendered command.
- Add a server-state reconciliation script for setup attempts:
  - list draft/pending/active connection state;
  - list current run status;
  - report what the dashboard should show.
- Record results in `tmp/workstreams/` for each owner acceptance run.

Acceptance:

- The harness would have caught the exact failures from the owner walkthrough.

### Phase 2: Add visible setup lifecycle

Goal: no invisible draft/running black holes.

Tasks:

- Expose setup attempts or pending connections from the reference API/BFF.
- Show pending setup cards on Sources/Connections:
  - account identity when known;
  - current run id/status;
  - last error;
  - "refresh status" / "view run" actions.
- After static-secret submit, redirect to that setup status, not back to the
  form with a transient notice.
- When first ingest accepts records, transition the same visible card to active
  connection state.

Acceptance:

- The owner can see the newly submitted account immediately after submit.
- If the run is still running, the UI says so.
- If the run fails, the UI shows a clear next action.

### Phase 3: Rebuild Sources / Connections IA

Goal: make existing connections and add-new support legible.

Tasks:

- Move data-source add flow into Sources/Connections as the primary path.
- For each connector, show:
  - existing active/pending/revoked count;
  - add-new support state;
  - one primary action;
  - optional details.
- Treat existing working connectors as working, even when add-new support is
  not self-service.
- Keep Connect AI apps as a separate page/section for MCP/CLI/agent read access.
- Add UX copy tests for the owner-facing state vocabulary.

Acceptance:

- Chase/ChatGPT no longer look inert when existing data is present.
- The owner understands whether they can add another account today.

### Phase 4: Publish or remove command paths

Goal: every shown command is real for target users.

Tasks:

- Either publish the owner-agent CLI setup commands and update UI to show exact
  install/version, or stop showing those commands.
- Package local collector/browser collector flows so they work outside the repo,
  or keep them out of normal owner UI.
- Add clean-shell tests:
  - `npx -y @pdpp/cli@beta --help`;
  - any shown `pdpp owner-agent ...`;
  - any shown local collector command.
- Add a release freshness check so the UI cannot advertise a command not in the
  published package.

Acceptance:

- Copying any command from normal owner UI works from a clean shell.

### Phase 5: Decide browser-bound product path

Goal: settle Amazon/Chase/ChatGPT add-new support honestly.

Decision point:

- If the SLVP ideal includes self-service browser-bound setup now, build a
  packaged browser collector with generated commands and real proof.
- If not, demote browser-bound add-new to "not self-service yet" while keeping
  existing connections manageable.

Tasks if productizing:

- Package browser collector.
- Generate exact commands without placeholder ambiguity.
- Prove Amazon end-to-end with real browser session.
- Only then expose as `Finish on this device`.

Tasks if demoting:

- Remove normal owner browser setup actions.
- Preserve advanced runbook for maintainers only.
- Keep existing browser-bound connections visible/manageable.

Acceptance:

- No normal owner path requires a monorepo checkout.

### Phase 6: Operational hardening

Goal: prevent unrelated deployment surprises from derailing acceptance.

Tasks:

- Add disk-space preflight to `scripts/reference-stack.sh up`.
- Add dashboard deployment readiness row for low disk/headroom.
- Document safe Docker build-cache pruning without touching data volumes.

Acceptance:

- A deploy/restart warns before Postgres hits `No space left on device`.

## OpenSpec Updates Needed If Accepted

This plan should update the active change as follows:

- `proposal.md`: expand impact from setup engine parity to owner-journey
  self-service acceptance.
- `design.md`: supersede "one simple page" with the separated Sources vs
  Connect AI apps IA; add visible setup lifecycle and command-surface contract.
- `tasks.md`: reopen/replace Console Setup Flow and Acceptance Checks sections
  with the phases above.
- `specs/reference-implementation-architecture/spec.md`: add requirements for
  owner-visible pending setup, command surface honesty, and existing-vs-add-new
  distinction.
- `specs/reference-connector-instances/spec.md`: add scenarios for draft/pending
  setup visibility and activation transition.

## Delegation Plan

Use ABD only where bounded:

- Worker A: inventory visible owner UI strings and classify normal vs advanced
  vs developer-only. Output grep-backed report only.
- Worker B: audit published CLI/package reality against every UI-rendered
  command. Output exact commands and pass/fail.
- Worker C: inspect server state for the user's new Gmail run/connection and
  report why it was not visible. No mutations without owner approval.
- Worker D: propose Sources/Connections IA wireframe and copy model from the
  acceptance matrix. No code.

Owner thread gates all design changes, integrates OpenSpec, and only then
implements.

## What Not To Do

- Do not patch isolated strings and call it aligned.
- Do not keep Amazon as "Manual setup" unless the manual setup is actually
  owner-usable from a shipped package.
- Do not show CLI commands that are not in the published CLI.
- Do not mark static-secret setup supported until pending/active/failure state
  is visible after submission and two-account proof passes.
- Do not archive the change while the owner journey still depends on
  maintainer-only procedures.

## Proposed Next Owner Decision

Before implementation, decide this:

> For browser-bound connectors in this tranche, do we productize a packaged
> owner-usable setup path, or do we explicitly demote add-new browser-bound setup
> to not self-service yet?

My recommendation is to demote browser-bound add-new setup immediately (Phase 0)
and productize it in a separate focused tranche only if it remains a priority
after Gmail/GitHub/static-secret and connection-state visibility are correct.

