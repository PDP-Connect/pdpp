## Decision

Treat a successful spine event with `event_type = 'client.deleted'`,
`status = 'succeeded'`, `object_type = 'client'`, and matching non-empty
`client_id`/`object_id` as the deletion tombstone for maintenance. The event is
written by the existing dynamic-client and CIMD deletion paths after their
client-specific revoke work. A missing `oauth_clients` row is deliberately not
an orphan signal.

The reconciler performs fixed set-based updates inside one transaction per
client and changes only live status/projection fields:

1. active `grants.client_id` become `revoked`;
2. active `grant_packages.client_id` become `revoked`, with
   `revoked_at = COALESCE(revoked_at, reconciliation_time)`;
3. active package members whose package or grant belongs to the exact client
   become `revoked`, preserving `revoked_at`;
4. unrevoked tokens and active refresh tokens linked by exact client, package,
   or grant scope are revoked, preserving refresh `revoked_at`.

The route calls this after its existing row-by-row revoke loops and owner-token
cascade. That keeps existing event emission and result counts while closing
partial historical states. Repeating the call is a no-op on already-revoked
rows.

## Bounded maintenance

The reconciler uses the existing durable fenced cursor store under a new
`auth_client_access` cursor name. A candidate query is a keyset walk over the
exact deletion evidence, ordered by `client_id`, with one look-ahead row. The
production round is capped at 25 clients and 2 seconds; internal hard caps
prevent callers from turning the seam into an unbounded pass. The cursor is
committed only after processed identities finish. A failed or fenced-out
round releases/abandons its lease, and replay is safe because reconciliation
is idempotent.

One startup round is scheduled with `setImmediate` and is included in graceful
shutdown's bounded startup-task drain. The existing 60-second maintenance
timer invokes the same reconciler thereafter. The new phase is independently
best-effort from shell, attention, evidence, and run-history phases.

## Alternatives rejected

- Treating absent `oauth_clients` rows as deletion would revoke valid external
  identities and cannot distinguish a local schema omission from a tombstone.
- Reusing a full-table startup scan would repeat the incident at scale and
  violate the bounded-startup contract.
- Deleting authority rows would destroy audit/history and make the repair less
  observable than a status transition.
- Adding a second timer would create competing lifecycle ownership; the
  existing fenced maintenance chassis already provides the required scheduling
  and shutdown behavior.

## Acceptance checks

- The pre-change route fixture fails with an active member under an already
  revoked package; the post-change route test passes.
- SQLite store tests prove all status transitions, timestamp preservation,
  idempotency, exact evidence filtering, and one-client cursor progress.
- PostgreSQL uses the same store SQL path and has an environment-gated parity
  test; no PostgreSQL URL is assumed in the default run.
- Typecheck, targeted Ultracite checks, focused route/store/cursor tests, and
  strict OpenSpec validation pass.
