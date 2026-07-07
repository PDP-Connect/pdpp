## Context

The live ChatGPT dondochaka run `run_1783434253305` leased a browser surface and emitted `run.browser_surface_ready`. The connector then emitted a pending `manual_action`; the dashboard minted a stream session, but the companion immediately resolved as `companion_start_failed` because there was no registered streaming target.

The route already supports managed-surface targets for no-response browser assistance, but the pending-interaction branch returned `target: null` unconditionally. That is correct for legacy CDP registration, but wrong when the same run already owns a ready managed browser surface.

## Decision

When minting a stream for a pending browser interaction, first look for a ready managed browser-surface lease for that run. If one exists, pass a Neko target to the companion factory. If not, keep returning `target: null` so connector-registered CDP targets continue to work.

## Alternatives Considered

- Require the connector child to register a target even for managed surfaces. Rejected: the reference server already owns the managed-surface lease and can construct the target without depending on child-side registration.
- Convert ChatGPT to no-response assistance. Rejected: the live failure is route-side and can affect any pending browser interaction backed by a managed surface.
- Add connector-specific ChatGPT UI routing. Rejected: the assistance surface should be connector-neutral.

## Acceptance Checks

- A pending `manual_action` with a ready managed surface mints a stream whose companion receives a Neko target for that lease.
- Existing no-response browser assistance behavior remains covered.
- Existing legacy target-registration behavior remains covered by current stream route tests.
