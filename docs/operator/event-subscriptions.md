# Event Subscriptions

Operator-facing guide to the `/v1/event-subscriptions` surface on a PDPP
reference deployment: what subscriptions are, who creates them, how the
operator console surfaces them, and how to verify end-to-end delivery against
a local test receiver before pointing a real client at the deployment.

This is a reference-implementation operator guide. The protocol semantics live
in the spec and in `packages/mcp-server/README.md`; the operator console
surface is documented in
`openspec/changes/add-mcp-event-subscription-client-tools/specs/reference-implementation-architecture/spec.md`.

## What event subscriptions are

A client that holds a grant-scoped bearer can register an HTTPS webhook
receiver against its grant. The reference resource server then delivers
[CloudEvents 1.0](https://cloudevents.io/) JSON envelopes signed per
[Standard Webhooks](https://www.standardwebhooks.com) when:

- the grant is approved or revoked,
- new records land for streams covered by the grant.

Record bodies are never pushed. The event envelope carries a
`data.changes_since` cursor; the client pulls the actual records by passing
that cursor to `GET /v1/streams/{stream}/records`.

The wire shape (event types, retry schedule, verification handshake) is
advertised at `capabilities.client_event_subscriptions` on
`/.well-known/oauth-protected-resource`.

## Who creates them

The owner does not create subscriptions. They are a **client** affordance:

- An MCP-capable client (Claude, ChatGPT) creates a subscription via the MCP
  adapter's `create_event_subscription` tool. The adapter forwards
  `POST /v1/event-subscriptions` under the same scoped client bearer it uses
  for read tools. See `packages/mcp-server/README.md` for the tool list.
- A non-MCP client that holds the same scoped client bearer can call the
  REST endpoint directly with `POST /v1/event-subscriptions`.

The operator console exposes a **read-only** view plus one safety-valve
disable. Subscriptions cannot be created, rotated, or replayed from the
console on purpose — the bound client retains lifecycle authority.

## Operator console surface

The console mounts the subscription list at:

```
/dashboard/event-subscriptions
```

The list shows every subscription on the deployment with `subscription_id`,
bound `client_id` and `grant_id`, status (`active`, `pending_verification`,
`disabled`, `disabled_failure`, `disabled_revoked`, `deleted`), callback host,
pending queue count, and recent delivery attempts. Click a row to open a peek
pane with the full callback URL, recent attempts (status code, latency,
error), and the disable affordance.

Filter by `client_id`, `grant_id`, or `status` to narrow the list. The peek
selection survives filter submits.

### The operator disable affordance

The disable form is the only operator-side mutation. It posts to
`/_ref/event-subscriptions/{id}/disable` and:

- Requires the `confirm_disable` checkbox (server-side enforced; not a
  client-only `confirm()` dialog).
- Accepts an optional reason (max 256 bytes UTF-8) that lands in the
  subscription's `disabled_reason` field for audit.
- Re-verifies the owner session before forwarding to the reference server.
- Stops deliveries for that subscription. The bound grant stays active and
  the client may re-enable via `PATCH /v1/event-subscriptions/{id} { enabled: true }`
  unless the grant itself was revoked.

There is no operator re-enable, rotate, or replay. Those remain on the bound
client by design — the operator is a safety valve, not the lifecycle owner.

## Verifying delivery with a local test receiver

The repository ships `scripts/event-subscription-test-receiver.mjs`: a tiny
Node HTTP server that verifies the Standard Webhooks signature and prints
each event envelope to stdout. Use it to sanity-check that a fresh reference
deployment can sign and deliver events before you point a real client at it.

### Run it

```sh
# 1. Start the receiver. It listens on http://localhost:8765 by default
#    and prints the callback URL you should give the client.
node scripts/event-subscription-test-receiver.mjs

# 2. From a client that holds a scoped client bearer (for example the MCP
#    adapter under `pdpp connect`), create a subscription pointing at the
#    receiver. With the MCP adapter, this is the create_event_subscription
#    tool. With raw REST:
curl -sS -X POST \
  -H "Authorization: Bearer $PDPP_CLIENT_BEARER" \
  -H "Content-Type: application/json" \
  -d '{"callback_url":"http://localhost:8765/webhook"}' \
  https://<your-deployment>/v1/event-subscriptions

# 3. The receiver prints the verification handshake event
#    (`pdpp.subscription.verify`) and the subscription should transition
#    from `pending_verification` to `active` in `/dashboard/event-subscriptions`.

# 4. Trigger a test event:
curl -sS -X POST \
  -H "Authorization: Bearer $PDPP_CLIENT_BEARER" \
  https://<your-deployment>/v1/event-subscriptions/{id}/test-event

# 5. The receiver prints the `pdpp.subscription.test` envelope. Done.
```

### Receiver flags

```
--port <N>        Listen port (default 8765).
--host <HOST>     Bind address (default 127.0.0.1). Use 0.0.0.0 only behind
                  a trusted TLS proxy.
--secret <SECRET> Per-subscription secret returned by POST /v1/event-subscriptions.
                  May also be set with `WEBHOOK_SECRET`.
--insecure        Skip signature verification. Useful only when you want
                  to inspect envelopes without configuring the secret yet.
                  Never combine with a production callback URL.
```

The receiver intentionally has no persistent storage and no retry logic. It
is a verifier, not a substitute for a real callback host.

### Receiver requires `http://localhost` callbacks

The reference deployment accepts `http://localhost` callback URLs only in
development. Production deployments will reject the receiver's URL unless you
expose it over HTTPS — use `cloudflared`, an SSH tunnel, or any reverse
proxy that terminates TLS in front of port 8765.

If the TLS proxy runs on another host, bind the receiver on an interface that
proxy can reach:

```sh
WEBHOOK_SECRET="whsec_..." node scripts/event-subscription-test-receiver.mjs --host 0.0.0.0 --port 8765
```

## CLI surface

Operator-side inspection is available through the `pdpp` CLI:

```sh
pdpp ref event-subscriptions list
pdpp ref event-subscriptions show <subscription_id>
pdpp ref event-subscriptions disable <subscription_id> [--reason <text>]
```

The CLI hits the same `_ref` surface the console uses and re-verifies owner
session. It is the headless equivalent of the console list and peek/disable
flow.

Client-side subscription management lives on the MCP adapter, not the CLI.
The decision rationale is recorded in
`openspec/changes/add-mcp-event-subscription-client-tools/design.md` §3:
subscription management is naturally driven from the agent (MCP) or from the
client application code that owns the callback receiver, not from a
human-typed terminal.

## Troubleshooting

- **Subscription stays in `pending_verification`.** The receiver never echoed
  the verification challenge. Check that the receiver is actually reachable
  from the reference deployment (`curl` from inside the reference container to
  the callback URL), and that signature verification is not rejecting the
  challenge event silently. The receiver's `--insecure` flag isolates network
  reachability from signature problems.
- **`pending_queue_count` keeps climbing.** The receiver is reachable but
  responding non-2xx, or the signature is failing. Check the receiver logs and
  the peek pane's `recent_attempts` for the status code and error string the
  delivery worker recorded.
- **`disabled_failure`.** The delivery worker disabled the subscription after
  repeated failures. The bound client can re-enable once the receiver is
  healthy by sending `PATCH /v1/event-subscriptions/{id} { enabled: true }`.
- **`disabled_revoked`.** The bound grant was revoked. The subscription is
  not recoverable in place; the client must obtain a new grant and create a
  new subscription.

## Related

- `packages/mcp-server/README.md` — the MCP tool surface that creates and
  manages subscriptions from a client.
- `docs/operator/selfhost-quickstart.md` — fresh-operator path. The receiver
  script is one of the first things to point at a new deployment.
- `openspec/changes/add-mcp-event-subscription-client-tools/` — the OpenSpec
  change that landed the MCP tool parity.
- `openspec/changes/add-client-event-subscription-management/` (archived) —
  the OpenSpec change that landed the REST surface, console, and CLI.
