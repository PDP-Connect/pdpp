## Context

The n.eko companion applies a screen configuration on SSE attach and on
token-scoped viewport updates. Its `stop()` path currently closes polling and
browser control without restoring the previous screen. SSE close is deliberately
reconnect-safe, while terminal interaction invalidation destroys the companion.

The generic surface-session store records a session's first `attached_at`, but
does not yet model multiple attachments. The host therefore owns the
presentation-controller decision without widening the stream token's authority.

## Goals / Non-Goals

**Goals:**

- Capture and persist a normalized baseline before any presentation screen POST.
- Run screen capture, apply, rotate, and restore through one epoch-serialized
  operation stream.
- Keep the first attached viewer as the controlling attachment across its
  reconnects; token-only observers may view and input but cannot resize.
- Restore before terminal interaction resolution lets connector work continue,
  and recover an unresolved restore obligation safely on boot.

**Non-Goals:**

- Device/UA/touch emulation or mobile fingerprint changes.
- Collaborative control, controller hand-off, or a new generic
  `@opendatalabs/remote-surface` attachment protocol.
- Restoring on ordinary SSE socket close.

## Decisions

### Persist the restore obligation before applying the presentation geometry

The n.eko `GET api/room/screen` response is normalized to the existing screen
configuration representation and written as `captured` before the first screen
POST. A successful restore records `restored`. A process restart can then see
the only dangerous state: captured but not restored.

Capturing only in companion memory was rejected because it cannot distinguish a
safe surface from a screen-mutated surface after process death.

### Use one lease-scoped presentation epoch and FIFO mutation stream

The companion owns a single promise tail for screen operations. Attach and
viewport operations use its current presentation epoch; terminal restoration
advances the epoch before queuing itself. A queued operation from the prior
epoch becomes a no-op, while operations in the current epoch run in request
order. This prevents an old rotation from applying after restoration and keeps
concurrent viewport posts from interleaving their GET/POST sequences.

Independent best-effort calls were rejected because a late configuration POST
can otherwise overwrite the baseline restore.

### Add a host-scoped controlling attachment capability

The first SSE attachment receives a short-lived, HttpOnly, same-origin
attachment cookie. It remains the controlling attachment on reconnect. A
different attachment with the same stream token is an observer for screen
resize purposes and receives a typed rejection from the viewport route. This
models the only attachment signal available today (`attached_at`) and contains
the policy at the host boundary until the package exposes attachment records.

Trusting a token-only viewport POST was rejected because any observer holding a
valid stream URL could otherwise thrash shared geometry.

### Terminal invalidation awaits restoration or safe retirement

All interaction-terminal paths call one async invalidation method before their
controller promise is allowed to settle. It first invalidates the token to fence
new viewport work, then restores the baseline before it destroys the companion
and unregisters the target. On a restore failure, a dynamic managed surface is
retired through the existing replacement path; a non-replaceable surface causes
the run to terminal rather than resume against presentation geometry.

Fire-and-forget invalidation was rejected because it allowed the connector to
resume while the surface was still phone-shaped.

### Keep presentation terminalization separate from bearer-token retention

The stream-token store is authentication metadata and purges a session when
its short bearer TTL passes. The presentation terminalizer instead retains an
in-memory `(run_id, interaction_id)` record with the browser session and
companion until restore or recovery settles. Expiry schedules that same
terminalizer; token supersession terminalizes the prior presentation without
invalidating the replacement bearer record. This keeps a late response,
cancel, or timeout from bypassing restore merely because authentication state
has expired.

## Risks / Trade-offs

- [n.eko restore endpoint fails] → retire a dynamic surface or terminal the
  run; never clear the restore obligation as success.
- [process death after capture] → startup reconciliation restores when possible
  or recycles/blocks the surface before admission.
- [controller cookie is absent after a fresh observer attach] → reject only its
  resize request; stream viewing remains reconnect-safe.
- [static surface cannot be replaced] → preserve a terminal, operator-actionable
  state instead of reusing an unknown geometry.
- [bearer record expires before a response] → terminalize from presentation
  identity, not from token-store lookup.

## Acceptance checks

- Focused streaming and controller suites cover capture-once, epoch ordering,
  observer rejection, all terminal paths, restore failure, and boot recovery.
- `openspec validate add-presentation-screen-lifecycle-restore-barrier --strict`
  and `openspec validate --all --strict` pass.
