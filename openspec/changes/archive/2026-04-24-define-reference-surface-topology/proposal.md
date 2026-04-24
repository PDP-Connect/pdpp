## Why

PDPP currently co-hosts protocol documentation and the live reference dashboard under one website shell, which blurs distinct artifacts: normative protocol, reference implementation, running instance, sandbox, and project planning. That blur makes operational tools feel like docs pollution and makes reference implementation choices look more authoritative than they are.

## What Changes

- Define a durable surface topology for the website and reference implementation.
- Separate protocol docs, public reference-implementation explanation, live operator dashboard, mock sandbox, and OpenSpec/project-planning surfaces.
- Add an explicit home for reference implementation marketing/explanation, including design principles, run/deploy CTAs, and a public coverage matrix.
- Define `/dashboard` as a stateful, owner-authenticated live-instance surface, not a hosted public docs surface.
- Define a future `/sandbox` as mock-backed, resettable, and pedagogical rather than operational.
- Require public pages and navigation to label artifact category and authority so reviewers do not confuse protocol requirements with reference behavior.

## Capabilities

### New Capabilities

- `reference-surface-topology`: defines artifact categories, route families, authority boundaries, and minimum public surfaces for protocol docs, reference implementation, live dashboard, sandbox, and OpenSpec planning.

### Modified Capabilities

*(none)*

## Impact

- `apps/web/src/app` route organization and navigation
- `apps/web/src/app/dashboard/**` gating, chrome, caching posture, and noindex posture
- future `/reference`, `/sandbox`, and coverage-matrix pages
- docs copy and metadata that currently imply the reference implementation and protocol are one artifact
- OpenSpec/change viewer navigation and labels
- deployment documentation for self-hosted versus hosted/demo surfaces
