## Context

The app now waits on a n.eko window-settle behavior. A stale container has no such route, so a valid interaction begins and later fails with an upstream 404.

## Decision

The actual window-settle endpoint is the only authority: before stream minting or attachment, the application makes one no-query, read-only request to the target. A settled response with positive dimensions proves the behavior is present; a missing, malformed, unsettled, or unsuccessful response produces the existing typed retryable inline failure before companion/proxy traffic begins.

The deploy helper rebuilds and converges the n.eko image with the app. Dynamic reconciliation feeds a failed required-behavior probe through the existing unhealthy/replacement lifecycle: idle surfaces are removed and recreated with their existing profile bind mount; a surface with a live lease is deferred until its existing release/restore path finishes. If an operator presents a stale static container anyway, pre-attach verification returns a typed retryable error rather than starting a black stream.

## Out of Scope

- Changing protocol Core or Collection Profile contracts.
- Replacing or weakening controller-attachment authority checks.
- Migrating browser profile contents.

## Acceptance Checks

- A stale dynamic container is detected by its failed required-behavior probe, removed only when idle, and recreated with the same profile path.
- An active stale dynamic surface is not stopped until its lease releases.
- A stale static or dynamic target fails before attachment with a typed retryable behavior error.
- A new app with a stale n.eko image cannot progress to a black-frame stream.
- The public manual-action smoke rejects a visually black stream frame by pixel content, not element presence.
