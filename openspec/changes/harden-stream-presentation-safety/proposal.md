## Why

The streamed presentation lifecycle can release or reuse a managed browser surface before its desktop baseline is physically restored. Dynamic surfaces also lack a surface-specific settle endpoint, and controller authority is not consistently scoped to a stream session.

## What Changes

- Require managed n.eko surfaces to carry a valid per-surface window-settle endpoint through allocation, leasing, targeting, and streaming.
- Await baseline window settlement before a presentation is marked restored or a terminal path resumes or releases a surface.
- Route run cleanup through the existing restore-or-retire terminalizer before releasing a leased presentation surface.
- Scope controller attachments per stream session and require them for every state-changing presentation route.
- Normalize viewport dimensions before accepting them at the reference wire boundary.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

Affected areas are dynamic n.eko allocation, stream targeting and routing, runtime lease cleanup, protocol-wire normalization, deterministic route and lifecycle tests, and the stream parity oracle.
