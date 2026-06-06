## Context

ChatGPT large-account catch-up is now intentionally slow and resumable: capped runs can commit hydrated prefixes and defer the remaining detail tail without arming source-pressure cooldown. The remaining schedule blocker is semantic, not collection mechanics: the shipped manifest says `manual` and `background_safe: false`, so the reference rejects an enabled schedule.

The existing `needs_human_auth` rule is correct for connectors that cannot start without a person. It is too broad for browser-backed connectors with durable local browser profiles: the owner must bootstrap or repair auth, but a later run can start in the background and surface bounded assistance if auth expires, an OTP appears, or manual action is needed.

## Decision

Introduce `capabilities.refresh_policy.assisted_after_owner_auth: true`.

When a listed manifest has `public_listing.status: "needs_human_auth"`, the manifest may declare automatic/background-safe refresh only if this new flag is true. The flag does not mean "unattended forever." It means:

- the owner must perform initial auth or be available for auth repair;
- after that auth state exists, the scheduler may start runs;
- the run automation projection remains `assisted` when `interaction_posture` is `credentials`, `otp_likely`, or `manual_action_likely`;
- auto-enrollment on server boot still requires `public_listing.status: "proven"` and therefore will not create schedules for `needs_human_auth` connectors.

This keeps the manifest honest while allowing an owner to explicitly enable a schedule for a configured ChatGPT connection.

## Alternatives

- Leave ChatGPT manual-only. This preserves honesty but prevents the best available catch-up mode for large histories.
- Mark ChatGPT `status: "proven"`. This is inaccurate because it still needs owner auth and browser-session maintenance.
- Treat `background_safe: true` alone as enough. This weakens the honesty tests and erases the distinction between durable API credentials and owner-auth bootstrapped browser sessions.

## Acceptance Checks

- Manifest validation accepts a boolean `assisted_after_owner_auth` and rejects non-boolean values.
- Public-listing honesty fails a `needs_human_auth` manifest that declares automatic/background-safe without `assisted_after_owner_auth: true`.
- Public-listing honesty accepts ChatGPT's assisted-after-owner-auth posture.
- Explicit schedule creation succeeds for an assisted-after-owner-auth manifest.
- Auto-enrollment still refuses `needs_human_auth` manifests.
- ChatGPT capped local schedule creation succeeds after manifest reconciliation.
