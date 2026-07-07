## Why

A live browser-backed connection emitted structured external-assistance evidence:
`running + act_elsewhere + response_contract:none + expires_at`. The attention
row existed, but the shared health predicate filtered all nonblocking
`act_elsewhere` rows as informational. Owner surfaces therefore rendered active
collection with no action needed while the run was actually waiting on a
time-bound external approval.

## What Changes

- Treat non-terminal, non-expired `act_elsewhere` attention with an expiry as
  health-relevant owner action.
- Enforce `ASSISTANCE.timeout_seconds` for no-response assistance so a connector
  that never emits `ASSISTANCE_STATUS` cannot hold an active run forever.
- Reconcile open attention for runs that have already reached a terminal spine
  event so restart cleanup cannot leave stale owner-action CTAs.
- Preserve the quiet path for unbounded `act_elsewhere` progress notices.
- Add pure model, summary-projection, and runtime timeout tests.

## Capabilities

Modified:
- `reference-connection-health`

## Impact

- Connector-neutral owner-facing health projection and runtime timeout behavior
  changes for structured attention rows.
- No new connector manifest semantics, storage tables, or dashboard-specific
  routing branches.
