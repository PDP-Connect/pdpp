## Context

`add-client-event-subscriptions` (archived 2026-05-27) gave the *client* an authenticated REST surface to create, inspect, modify, and delete its own subscriptions, and gave the *delivery worker* the post-commit signing/retry/dead-letter pipeline. It did not give the *operator* — the human or agent running the reference instance — any way to inspect or intervene.

This change closes that gap with the minimum surface that an operator actually needs to keep a reference deployment honest:

1. **Inventory.** "What subscriptions exist on my instance right now, across all clients and grants?"
2. **Health.** "Is delivery actually working? What did the last attempts look like?"
3. **Safety valve.** "If a callback is misbehaving (looping, leaking, owned by a revoked client), how do I stop deliveries without revoking the grant?"

It deliberately stops there. The PDPP framing rule (`docs/voice-and-framing.md` §3) is that the operator console runs on top of the protocol but does not become the protocol; the dashboard surfaces operator-local state, not authority over the client's own resources. Letting the operator re-enable, rotate, or replay would silently widen the operator beyond that line.

## Surface decisions

### One operation model, three adapters

The archived design called for "one canonical subscription-management operation model, then thin adapters." That model already exists in `operations/as-client-event-subscriptions/`. This change does **not** introduce a parallel state machine. Instead it adds three reference-only operations alongside the existing client-facing ones; they consume the same store, the same `SubscriptionRow`/`SubscriptionStatus` types, and the same status taxonomy. The only new status reason is the string `"operator_disabled"`, which slots into the existing `disabled_reason` column without changing the `SubscriptionStatus` enum.

Three thin adapters then consume those operations:

- `_ref` REST routes (mounted in `server/index.js`).
- `pdpp ref event-subscriptions` CLI commands (call the `_ref` routes with owner session).
- Dashboard `/dashboard/event-subscriptions` page (calls the `_ref` routes from server components via `apps/web/src/app/dashboard/lib/ref-client.ts`).

This matches the existing pattern for `/_ref/connectors`, `/_ref/approvals`, `/_ref/grants`, etc.

### MCP scope

`packages/mcp-server` is documented as a "Local stdio MCP adapter for read-only, grant-scoped access to a PDPP resource server." It exposes only data-read tools (`schema`, `list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`). Adding operator subscription-management tools to MCP would require either:

- an owner-bearer code path through stdio (the adapter has never supported owner auth), or
- exposing operator state via a grant-scoped client token (this leaks per-instance state to clients and inverts authorization).

Both options conflict with the adapter's declared posture. We do not ship MCP tools for subscription management in this tranche. A future change could explicitly propose an *operator* MCP surface (separate transport, separate auth, separate `pdpp-mcp-owner` bin) — that's a different design conversation.

### Why operator-disable but not operator-enable

`SubscriptionStatus` already has a non-fatal `disabled` reason (`client_disabled`, set when the client itself sends `PATCH { enabled: false }`). The operator-disable path reuses the same status terminal and only differs in `disabled_reason: "operator_disabled"`. Both are recoverable: the client may `PATCH { enabled: true }` to bring the subscription back to `active`.

We do *not* add an operator-enable path. The reason is asymmetric incentive: the operator's job is to stop bad behaviour; re-enabling is the client's affirmative signal that they've fixed whatever caused the disable. Allowing an operator to silently re-enable a callback the client hasn't acknowledged inverts that signal and creates a foot-gun where the operator believes they've fixed a delivery problem the client never noticed.

The `disabled_failure` and `disabled_revoked` terminals remain client-only / system-only respectively — this is unchanged from the prior tranche.

### Why no operator secret rotation

The `secret` is the client's mutual-authentication credential for verifying inbound webhook callbacks. Letting the operator rotate it would either (a) require the operator to deliver the new secret to the client through some side channel (which doesn't exist), or (b) silently break HMAC verification for the client. Both are worse than just disabling and letting the client rotate via `PATCH { rotate_secret: true }`.

### Why no attempt replay

Replaying a `final_failure` event would require the operator to either (a) know the original payload and re-enqueue (we keep `payload_json` in `client_event_queue` past dead-letter, so this is technically possible) or (b) wait for the next record change. The first option is a much larger UX surface (replay-with-payload, multiplicity, retry budget). The second is what happens by default once the subscription is re-enabled by the client. We defer replay until there is a real operator complaint that lookup-and-replay was needed.

## Operator projection shape

The list projection deliberately avoids fields the operator cannot act on. It includes:

- `subscription_id`, `client_id`, `grant_id`, `status`, `disabled_reason`
- `callback_host` (the URL host only — full callback URL is operator-relevant but unparsed; we surface host because that's what an operator scans for in the list view)
- `created_at`, `updated_at`, `disabled_at`
- `pending_queue_count`, `last_attempt_at`, `last_attempt_ok`, `last_attempt_status_code`
- `final_failure_count` (count of queue rows in `final_failure` status)

The detail projection adds:

- The full `callback_url` (operators need this to diagnose; it is already stored in plaintext)
- The `scope` snapshot (so operators can correlate to the bound grant)
- A bounded list of the most recent `client_event_attempts` for the subscription (status code, latency, error, response snippet), capped at 25 by the operation layer

The detail projection deliberately **does not** include the `secret`, `secret_hash`, or `secret_text` columns. Those are the client's credential. The store interface already returns them; the projection drops them.

## Storage and operation seams

`ClientEventSubscriptionStore` already exists. This change adds three methods:

- `listAllSubscriptions(filters: { clientId?, grantId?, status?, callbackHostContains? })` — owner-bounded read across grants.
- `getSubscriptionSummary(subscriptionId)` — joins queue/attempts to surface the projection counts and last-attempt fields without N+1 round trips.
- `listAttemptsForSubscription(subscriptionId, limit)` — bounded attempt log across all queued events for the subscription.

These mirror the existing `claimDueQueue` / `listAttemptsForQueue` helpers; they live in the same file (`server/stores/client-event-subscription-store.ts`) and have SQLite + Postgres implementations behind the same backend resolver.

A new SQL artifact module `server/queries/client-event-subscriptions-ref/` carries the SQLite query bodies. We do not add new tables.

## Authorization

Every `_ref/event-subscriptions*` route is gated by `ownerAuth.requireOwnerSession`, the same middleware that protects every other `_ref` route. The operator's authority is local to their instance: it covers subscriptions whose grants live on this resource server. There is no cross-instance operator authority.

`POST /_ref/event-subscriptions/:id/disable` is the only mutating route; it accepts an optional body `{ reason: string }` to capture operator intent in the `disabled_reason` column (overrides the default `operator_disabled` so an operator can record a specific cause like `loop_suspected`).

## CLI surface

Two read commands and one mutating command:

```
pdpp ref event-subscriptions list --as-url <url> [--client-id <id>] [--grant-id <id>] [--status <status>] [--format json|table]
pdpp ref event-subscriptions show <subscription-id> --as-url <url> [--format json|table]
pdpp ref event-subscriptions disable <subscription-id> --as-url <url> [--reason <text>]
```

`disable` requires explicit confirmation: it prints the subscription summary and prompts `Disable subscription <id>? (yes/no) ` unless `--yes` is passed. Confirmation is a CLI affordance only; the route accepts the POST without confirmation (the dashboard renders its own confirm dialog).

## Dashboard surface

Add a route at `/dashboard/event-subscriptions`. Use the existing `ListWithPeekView` + `DataList` + `StatusBadge` primitives already used by `/dashboard/grants`. The page renders:

- A filter row: client, grant, status.
- A list with one row per subscription: status badge, callback host, last attempt result, attempt counts, links to grant detail and to the peek pane.
- A peek pane with the full callback URL, scope summary, and the last 25 attempts.

A single button on the peek pane fires `POST /_ref/event-subscriptions/:id/disable` via a server action. The action requires a Next.js form submission (no client-side JS gymnastics) and surfaces the resulting status back into the same page.

No new design tokens; reuse `Section`, `PageHeader`, `EmptyState`, `ServerUnreachable`.

## Alternatives

- **Add to `/dashboard/grants` as a sub-section.** Rejected. Grants are user-consent artifacts; subscriptions are delivery infrastructure. Coupling them in the UI conflates two different lifecycles. Operators investigating a delivery health issue should not need to know which grant produced the subscription before they can find it. The dashboard route does cross-link to the bound grant, but the inventory lives on its own page.
- **Owner can edit / rotate / replay.** Rejected — see "Why operator-disable but not operator-enable" / "Why no operator secret rotation" / "Why no attempt replay" above.
- **MCP operator tool for `listSubscriptions`, `disableSubscription`.** Rejected for this tranche. See "MCP scope" above. A future *operator* MCP adapter (distinct from the existing read-only client one) would be the right vehicle if the use case proves out.
- **Single bulk operator disable action across all subscriptions for a client.** Rejected. The operator already has `POST /_ref/grants/:grantId/revoke`, which auto-disables all subscriptions for the grant via the existing `executeApplyGrantRevoke` hook. Adding a bulk subscription disable would duplicate that path with weaker semantics (the grant remains active). If an operator wants to stop *all* deliveries for a client, the right tool is grant revoke.
- **Surface `secret_hash` to the operator (not the secret, just the hash).** Rejected. The hash is useless to the operator (they cannot use it to verify deliveries — that's the client's side) and adds noise to the projection.

## Acceptance Checks

- `openspec validate add-client-event-subscription-management --strict`
- `openspec validate --all --strict`
- Operation tests cover:
  - `ref.client-event-subscriptions.list` returns only non-deleted subscriptions, filtered by `clientId` / `grantId` / `status` separately and in combination
  - the list and get projections do not include `secret`, `secret_hash`, or `secret_text`
  - `ref.client-event-subscriptions.disable` transitions `active` → `disabled` with `disabled_reason: "operator_disabled"` (or the operator-provided reason)
  - operator disable drops pending queue rows the same way client disable does
  - operator disable on a subscription already in `disabled`, `disabled_failure`, `disabled_revoked`, or `deleted` is a no-op success (idempotent), not a 409
- Route tests cover:
  - All three routes require `ownerAuth.requireOwnerSession`; absent session returns the standard owner-login redirect / 401
  - GET list and GET detail return the operator projection without secrets
  - POST disable persists the reason and drops queued events
  - The bound `executeApplyGrantRevoke` hook still works after operator disable (subscription stays `disabled_revoked` since `disabled_revoked` is sticky)
- CLI tests cover:
  - `list`, `show`, `disable` end-to-end against a stub HTTP server matching the `_ref` route shape
  - `disable` without `--yes` requires confirmation
  - `--format json` and `--format table` both work on `list` and `show`
- Targeted reference tests: `pnpm --dir reference-implementation test --test-name-pattern "ref.client-event-subscriptions"`
- Typecheck: `pnpm --dir reference-implementation typecheck`
- CLI tests: `pnpm --dir packages/cli test`

## Residual risks

- The operator can disable a subscription that the client is happily using. This is by design (safety valve) but should be visible to the client — the existing `GET /v1/event-subscriptions/:id` already returns `status` and `disabled_reason`, so a polling client will see the change. We do not emit a `subscription.disabled` event (the archived design explicitly defers that).
- Operator projection assumes `client_event_attempts` rows are not pruned aggressively. The archived design notes retention is currently unbounded; if a future change adds a retention policy, the projection's `final_failure_count` may become misleading. The detail projection's attempt list is capped at 25, so it survives pruning gracefully.
- `callback_host` is a hostname extracted by the operation layer from `callback_url`. If `callback_url` is somehow malformed at storage time (it shouldn't be — `validateCallbackUrl` runs on create), the operation falls back to the raw URL string.
- We do not paginate the operator list in this tranche. Reference instances are local, so the cardinality is low in practice; if a future deployment needs pagination, we can add `?cursor=…` mirroring the grants list cursor shape.
