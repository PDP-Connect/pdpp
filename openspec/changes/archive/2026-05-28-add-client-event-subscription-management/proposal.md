## Why

The archived `add-client-event-subscriptions` change shipped the outbound client-facing subscription surface at `/v1/event-subscriptions` (create / read / list / update / delete / test-event), the delivery worker, store parity, and protected-resource metadata advertisement. What it did not ship is *operator-side oversight*: today a reference operator who runs a self-hosted instance has no first-class way to enumerate the subscriptions clients have created against grants on their server, inspect delivery health, or disable a misbehaving callback independently of the client.

Operators are the party named in `docs/voice-and-framing.md` §3 as the addressee of `/dashboard/**` and of the `pdpp ref` CLI. They are not the client (clients self-serve via the bearer surface) and they are not the protocol (Core PDPP is silent on subscription management). The reference must give that operator a read-mostly oversight surface plus a narrow safety-valve disable, without inventing a parallel state machine.

## What Changes

- Extend the existing `ClientEventSubscriptionStore` with operator-facing reads: list all subscriptions across grants (with filters by `client_id`, `grant_id`, `status`), and list bounded attempts for a subscription.
- Add three reference-only operations under `operations/ref-client-event-subscriptions-*`:
  - `ref.client-event-subscriptions.list` — operator list with summary projection (status, last attempt outcome, attempt counts, callback host).
  - `ref.client-event-subscriptions.get` — operator detail projection including recent attempts.
  - `ref.client-event-subscriptions.disable` — operator-initiated disable that sets status to `disabled` with `disabled_reason: operator_disabled` and drops queued events.
- Mount three owner-session-gated routes at `GET /_ref/event-subscriptions`, `GET /_ref/event-subscriptions/:id`, and `POST /_ref/event-subscriptions/:id/disable`. These reuse the same `_ref` ownership posture as `/_ref/grants`, `/_ref/connectors`, etc.
- Add `pdpp ref event-subscriptions list|show|disable` CLI subcommands mirroring those routes one-to-one. Owner session reuses the existing `.pdpp/owner-sessions/` cache.
- Add a dashboard surface at `/dashboard/event-subscriptions` (list + per-subscription peek) that renders the same projection.
- Update `openspec/specs/reference-implementation-architecture/spec.md` to add a normative requirement covering operator oversight: read-only list/get, owner-disable safety valve, and explicit non-widening (the operator cannot create, re-enable, rotate secrets, or replay deliveries — those remain client-owned).

## Capabilities

Modified:

- `reference-implementation-architecture`

Added:

- None

Removed:

- None

## Impact

- Affected code:
  - `reference-implementation/operations/ref-client-event-subscriptions-list/index.ts` (new)
  - `reference-implementation/operations/ref-client-event-subscriptions-get/index.ts` (new)
  - `reference-implementation/operations/ref-client-event-subscriptions-disable/index.ts` (new)
  - `reference-implementation/server/stores/client-event-subscription-store.ts` (extend store + worker helpers)
  - `reference-implementation/server/index.js` (mount three `/_ref/event-subscriptions*` routes)
  - `packages/cli/src/ref/commands/event-subscriptions.js` (new) and dispatch in `packages/cli/src/index.js`
  - `apps/web/src/app/dashboard/event-subscriptions/page.tsx` (new) and consumer in `apps/web/src/app/dashboard/lib/ref-client.ts`
  - tests under `reference-implementation/test/` and `packages/cli/test/`
- Affected behavior: deployments expose operator oversight of client subscriptions. No client wire shape changes. The protected-resource metadata advertisement is unchanged.
- Protocol impact: none for Core PDPP. The `_ref` surface is reference-only; the dashboard and CLI are operator tools.

## Out of scope (and why)

- **MCP tools for subscription management.** `packages/mcp-server` is declared "read-only, grant-scoped" and only mounts read tools. Adding owner controls to MCP would either (a) require an owner-bearer code path through stdio, which the adapter has never supported, or (b) leak operator state to grant-scoped clients. Both break the read-only posture. Deferred until a future change explicitly proposes an operator MCP surface.
- **Owner-initiated re-enable, secret rotation, or attempt replay.** The subscription's `secret` is client-only by design (returned once on create, never displayed in the operator surface). Re-enable after `disabled_failure` is a client signal that they have fixed their endpoint — letting the operator silently re-enable would mask a real failure. Attempt replay is deferred for the same reason.
- **Owner-initiated subscription creation.** Subscriptions are bound to a client grant; the operator does not have a client bearer and creating one would violate the grant-scope invariant.
- **Webhook wire format changes.** The separate `worker/webhook-standards-alignment` branch owns wire-format work.
