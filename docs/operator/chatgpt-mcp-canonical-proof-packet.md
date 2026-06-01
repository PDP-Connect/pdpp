# ChatGPT hosted-MCP canonical-key proof packet

Status: reference/operator runbook. Not PDPP Core or Collection Profile protocol.

This is the exact owner-run proof for the **ChatGPT half** of
`canonicalize-connector-keys` task 5.2. It exists so the final ChatGPT live proof
is mechanical and acceptance-grade: every check has a precise pass/fail bar, a
named no-secrets evidence line, and an explicit rule for classifying partial
runs. It is the ChatGPT-specific drill-down of
[`live-proof-packet.md`](live-proof-packet.md) Gate 2; that gate's summary points
here.

The deployment-setup steps are owned by
[`hosted-mcp-setup.md`](hosted-mcp-setup.md) (the `## ChatGPT` and
`## Verifying hosted schema token efficiency` sections). The event-subscription
mechanics and the local test receiver are owned by
[`event-subscriptions.md`](event-subscriptions.md). This packet does not
duplicate them; it sequences and gates them for the ChatGPT acceptance run.

The non-negotiable rule, inherited from the change's task text and the owner
ledger: **do not check task 5.2 until ChatGPT is live-proven end to end** — and
"end to end" includes the **event-subscription lifecycle**, not just registration
refresh and the `connection_id` retry.

---

## What is already proven, and what this packet still has to close

The Claude half of task 5.2 is fully live-proven (2026-05-31), captured in
`tmp/workstreams/ri-external-claude-live-evidence-2026-05-31.md`: multi-source
grant approval, readable stream/schema/record text, `ambiguous_connection ->
connection_id` retry whose `available_connections` carried
`grant_id`/`connector_key`/`connection_id`/`display_name`/`retry_with`, four
distinct `claude_code` multi-instance connections, and a full
create/list/get/send-test/delete event-subscription lifecycle. No URL-shaped
connector ids in owner-facing tool guidance.

The ChatGPT half is **partially** proven. From the owner ledger
(`tmp/workstreams/ri-owner-current-state.md`):

- ChatGPT initially exposed a **stale 6-tool surface** (an old reference image's
  tool list pinned by the cached connector registration).
- **Deleting and re-adding** the connector refreshed the host to the current
  **14-tool surface** exposing `query_records.connection_id` and the
  event-subscription tools.
- A `messages` `query_records` call retried successfully with a
  `connection_id`.
- A separate scoped retry against a Slack connection succeeded, confirming the
  `connection_id` selector works across connector types (not just `messages`),
  and the event-subscription tools are present on the 14-tool surface.

That is exactly the evidence the owner had when a prior lane
(`ri-canonical-keys-live-evidence-reconcile-v1`) tried to flip task 5.2 to `[x]`
and was **rejected for overclaim** (ledger checkpoint 2026-06-01T00:23:54): the
task text requires ChatGPT to *create event subscriptions* without URL-shaped
ids, and the ChatGPT **event-subscription lifecycle was never exercised**. So the
residual this packet must close is narrow and specific:

> **ChatGPT residual:** event-subscription `create -> list -> get -> send-test ->
> delete` through the ChatGPT MCP client, with a reachable HTTPS receiver,
> proving canonical-key identity and no URL-shaped connector ids — plus a
> re-confirmation of the schema/`connection_id` retry path on the current
> 14-tool surface so the whole flow is captured in one durable evidence file.

Everything else in this packet is the supporting scaffold that makes that one
residual mechanical.

---

## Why ChatGPT differs from Claude (read before running)

ChatGPT's connector/developer-mode MCP integration has two behaviors that the
Claude run did not stress, and that the packet is built around:

1. **Tool-surface caching ("the 6-tool problem").** ChatGPT can pin the tool
   surface advertised at first registration. If the connector was added against an
   older reference image, ChatGPT may keep showing that old surface (historically
   6 tools, missing `connection_id` and the event-subscription tools) even after
   the deployment is upgraded. **This is host registration drift, not a backend
   defect.** The fix is always delete + re-add (see Preconditions). The backend
   `/mcp` surface is the same in-repo tool code for ChatGPT and Claude
   (`createPdppMcpServer -> buildTools`), so a missing tool on ChatGPT after a
   fresh re-add would be a real defect; a missing tool before a re-add is drift.

2. **`search` / `fetch` are ChatGPT's first-class tools.** The MCP server shapes
   `search` and `fetch` to ChatGPT's expected contract (flattened `results` with
   `id`/`title`/`url`; `fetch` returns a document by `stream:record_id`). For
   ChatGPT, the **`ambiguous_connection` retry is most naturally triggered on
   `fetch`** (and `fetch_blob`), not only on `query_records`. The retry envelope
   and the canonical-id rule are identical across tools; just expect ChatGPT to
   reach it through `fetch`.

Both are reasons the ChatGPT acceptance run is a distinct gate from Claude, not a
formality.

---

## Secret-handling (applies to every step)

Never print, paste, commit, or screenshot: the MCP integration/client secret,
owner session cookies or bearers, the grant-scoped client bearer, scoped stream
tokens, the per-subscription `whsec_...` delivery secret, the one-time event
secret, provider credentials, production connection strings, or raw record
contents before scrubbing.

- It is sufficient for ChatGPT to **state** that a value (e.g. the one-time
  secret) is readable in the tool text. Do not have it echo the value.
- Quote only harmless schema-level facts: stream names, field names, canonical
  `connector_key`, `connection_id` values, `subscription_id`, status strings,
  counts. These are not secrets.
- Report **invariants** (tool count, no URL-shaped ids, retry succeeded,
  subscription became `active`, list empty after delete), not the underlying
  personal data.

---

## Preconditions

**P0. Reachable deployment.** A running reference deployment with `/mcp`
reachable over HTTPS (the public reference deployment is `https://pdpp.vivid.fish`;
its MCP URL is `https://pdpp.vivid.fish/mcp`). Confirm the deployed revision is
current enough to advertise the 14-tool surface — the protected-resource metadata
carries the reference revision:

```sh
# Observe only the revision header; prints no secret.
curl -fsS -D - -o /dev/null \
  "<PDPP_REFERENCE_ORIGIN>/.well-known/oauth-protected-resource/mcp" \
  | grep -i 'pdpp-reference-revision'
```

**P1. Clear stale ChatGPT registration if the surface is stale.** This is the
"6-tool problem" fix and is the most important precondition. In ChatGPT, **delete
any existing PDPP connector** that was registered against an older image, then
**re-add** it against `<PDPP_REFERENCE_ORIGIN>/mcp` with OAuth and complete the
PDPP owner consent flow. This mirrors `hosted-mcp-setup.md` step 1 of the parity
check. Do the delete/re-add whenever step S1 below shows fewer than 14 tools or a
`query_records` without `connection_id` — never work around it by editing the
backend.

**P2. Multi-connection grant.** Approve a grant covering **multiple sources**,
ideally including at least one connector type with **more than one connection**
(e.g. two `claude_code` instances, or two of the same source). This is what makes
the `ambiguous_connection -> connection_id` path reachable. Confirm with an owner
read first (do not echo the cookie):

```bash
# Set BASE_URL and PDPP_OWNER_SESSION_COOKIE in the environment, then:
node --input-type=module <<'NODE'
const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const cookie = process.env.PDPP_OWNER_SESSION_COOKIE;
if (!baseUrl || !cookie) throw new Error('Set BASE_URL and PDPP_OWNER_SESSION_COOKIE.');
const r = await fetch(`${baseUrl}/v1/streams`, { headers: { Cookie: cookie, Accept: 'application/json' } });
const body = await r.json();
console.log('stream_count:', Array.isArray(body.data) ? body.data.length : 'n/a');
NODE
```

**P3. HTTPS callback receiver (required for the event-subscription half).** A
public HTTPS receiver the deployment can reach. The known-good route is
`https://pdpp-events.vivid.fish/webhook` (forwards to the workstation receiver).
Start the tracked receiver per `event-subscriptions.md` before creating any
subscription; for secure proof prefer `WEBHOOK_SECRET_FILE` over `--insecure`.
**If no HTTPS callback is available, you cannot fully close task 5.2** — see
[Classifying partial evidence](#classifying-partial-evidence). The owner-side
secure callback delivery is already independently proven
(`tmp/workstreams/ri-secure-callback-proof-2026-05-31.md`); this gate's open part
is specifically that **ChatGPT** drives the lifecycle, so the receiver must be up
for the ChatGPT run itself.

---

## Required tool-schema checks (before any live call)

Have ChatGPT list its PDPP tools, or inspect the connector's tool list, and
confirm the surface. These are schema/registration facts, provable before
touching records.

**T1. Exactly the 14-tool surface is present.** The current tool set is:

```
schema, list_streams, query_records, aggregate, search, fetch,
discover_event_subscription_capabilities,
create_event_subscription, list_event_subscriptions, get_event_subscription,
update_event_subscription, delete_event_subscription, send_test_event,
fetch_blob
```

(ChatGPT may also list unrelated tools from other connectors, e.g. Google Drive;
that is fine. Count only the PDPP tools.)

**T2. `query_records` accepts `connection_id`.** Its input schema must expose
`connection_id` (the deprecated `connector_instance_id` alias may also appear but
must not be the preferred selector). `schema` must expose `detail`
(`compact|full`) and `stream`. If `connection_id` or `detail`/`stream` are
missing, the registration is stale — return to **P1** (delete + re-add). A
missing tool *after* a fresh re-add against a current image is a backend defect to
file, not drift.

**T3. Event-subscription tools are present.** All seven subscription-related
tools are in T1's list:
`create_event_subscription`, `list_event_subscriptions`,
`get_event_subscription`, `update_event_subscription`,
`delete_event_subscription`, `send_test_event`, plus
`discover_event_subscription_capabilities`. Their presence is the precondition for
the lifecycle proof; absence means stale registration (P1) or an old image (P0).

**T4. No URL-shaped connector ids exposed as stable source identity.** In the
tool descriptions, `list_streams`/`schema` identity, and any
`available_connections` guidance, the connector type must read as canonical
`connector_key` (e.g. `gmail`, `ynab`, `claude-code`) and the source selector as
`connection_id`. A `manifest_uri` of the shape `https://<host>/connectors/<key>`
is acceptable **only** if it is clearly labeled as provenance, never as the
operational id or selector. No tool guidance may instruct the client to select a
source by a `https://...` connector id or by `grant_id`.

---

## Required live calls (in order)

Drive these from the ChatGPT client. Suggested single prompt is in
[Appendix A](#appendix-a-chatgpt-prompt). Capture ChatGPT's reported facts into
the evidence file as you go.

**S1. List tools.** Confirm T1-T4. If stale, do P1 and restart S1.

**S2. List streams + inspect schema.** Call `list_streams`, then `schema` (compact
default) and optionally `schema(stream: "<one>")`. Confirm stream names, field
capabilities, canonical `connector_key`, and `connection_id` values are **readable
in the tool text** (the 2026-05-31 readability fix `91ccbe56`/`071c64c8` made
discovery and record previews parseable in `content[]`, not only
`structuredContent`). This re-confirms on ChatGPT what was confirmed on Claude.

**S3. Query records.** Call `query_records` (or `search`/`fetch`) on one allowed
stream and have ChatGPT quote a harmless field name or short value proving the
payload is readable from the tool text. Read-only.

**S4. Trigger ambiguity, then retry by `connection_id`.** On the multi-connection
grant, call a tool that fans in across connections without `connection_id`
(`query_records` on a shared stream like `messages`; for ChatGPT, `fetch` on a
record id that resolves to >1 connection is the natural trigger). Confirm the
typed `ambiguous_connection` (409) envelope lists `available_connections` entries
carrying `grant_id`, `connector_key`, `connection_id`, optional `display_name`,
and `retry_with: "connection_id"`. **Then retry with one `connection_id` and
confirm it succeeds.** Confirm none of the candidates is identified by a URL-shaped
connector id, and that the retry selector is `connection_id`, not `grant_id`.

**S5. Event-subscription lifecycle (THE residual — required to close 5.2).** With
the HTTPS receiver from P3 running, drive the full lifecycle through ChatGPT:

1. `discover_event_subscription_capabilities` — confirm `supported: true`.
2. `create_event_subscription` with `callback_url` = the HTTPS receiver, and (on
   a multi-source package token) a `connection_id` so it binds to exactly one
   child grant. Confirm: a `subscription_id` (prefix `sub_`) is returned; the
   one-time `whsec_...` delivery secret is **stated as readable in the tool text**
   (do not echo it); initial status is `pending_verification`.
   - If `connection_id` is omitted on a multi-source token, confirm the call is
     rejected with the typed `ambiguous_connection` (409) — then retry with a
     `connection_id`. This proves event-sub creation honors the same canonical
     disambiguation as reads.
3. Receiver confirms the `pdpp.subscription.verify` handshake; subscription
   transitions `pending_verification -> active`.
4. `list_event_subscriptions` — the new `sub_...` appears.
5. `get_event_subscription` — returns it with `active` status, canonical
   `connector_key`/`connection_id`, no URL-shaped id.
6. `send_test_event` — receiver confirms a signed `pdpp.subscription.test`
   envelope (Standard Webhooks `webhook-signature`).
7. `delete_event_subscription` — then `list_event_subscriptions` returns **empty**
   (or the `sub_...` is gone). This leaves the deployment clean.

Record `subscription_id`, the two event ids (verify + test), the status
transition, and the final empty list. Do not record secrets or record bodies.

> **Signed-callback caveat (carried from the Claude run, 2026-06-01).** The
> *signature-verifying* half of S5 step 6 — confirming the `webhook-signature`
> on the `pdpp.subscription.test` envelope against the one-time `whsec_...`
> secret — can only be driven from chat if the MCP client surfaces that secret
> in a form the operator can copy into the receiver's `--secret-file`. Some
> clients (notably mobile or structured-only surfaces) render the secret as
> non-selectable / hidden / mobile-truncated. When that happens, the lifecycle
> (`create -> verify -> active -> list -> get -> send-test -> delete`) and the
> canonical-id invariant are still fully provable from chat, but the
> *cryptographic* signature check is not — the receiver records delivery and
> envelope shape, not a verified signature. **This does not block closing 5.2:**
> 5.2 requires creating event subscriptions without URL-shaped ids, not a
> chat-driven signature verification. Record the lifecycle + canonical-id
> invariant as proven and note the signature check as "delivered, signature
> unverified-from-chat (secret not extractable on this client)". To get a
> verified signature, run the receiver against a client/surface that exposes the
> secret as copyable text, or use the owner-bearer `curl` path in
> [`event-subscriptions.md`](event-subscriptions.md) where the secret is
> returned to a terminal you control.

---

## What counts as sufficient evidence (no leaks)

The evidence is a short no-secrets note, written to
`tmp/workstreams/ri-chatgpt-mcp-live-evidence-<date>.md`. Sufficient means it
records, as invariants:

- **Surface:** "14 PDPP tools listed" with the names, `query_records` exposes
  `connection_id`, `schema` exposes `detail`/`stream`, all event-sub tools
  present. (T1-T4)
- **Discovery/read:** stream names + at least one harmless field name/value read
  from tool text. (S2-S3)
- **Disambiguation:** the `ambiguous_connection` envelope fields present
  (`grant_id`, `connector_key`, `connection_id`, `retry_with`), and the
  `connection_id` retry **succeeded**. (S4)
- **Event-sub lifecycle:** `subscription_id`, secret stated readable (value
  withheld), `pending_verification -> active`, the two event ids, `send_test`
  delivered, deleted, **list empty after delete**. (S5)
- **Canonical-id invariant:** an explicit statement that **no URL-shaped connector
  id** appeared as operational identity or as a source selector anywhere in tool
  descriptions, stream/schema identity, `available_connections`, or retry
  guidance. A clearly-labeled `manifest_uri` provenance value does not violate
  this.

Insufficient: a screenshot with secrets; a claim of "it worked" without the named
invariants; record contents pasted into chat; the secret value echoed; or
event-sub lifecycle asserted from the Claude run rather than the ChatGPT run.

---

## Classifying partial evidence

Map the ChatGPT run to exactly one of these. Only the first row checks task 5.2.

| Observed | Classification | Box action |
|---|---|---|
| All of S1-S5 pass; canonical-id invariant holds; lifecycle driven from ChatGPT | **Full ChatGPT proof** | Check 5.2 (both clients now proven) |
| S1-S4 pass but **no HTTPS callback available**, so S5 not run | **Read + disambiguation proven; event-sub pending** | Leave 5.2 open; note "ChatGPT reads + `connection_id` retry live-proven; event-sub lifecycle blocked on callback" |
| Tool list shows 6 tools / no `connection_id` / no event-sub tools | **Stale host registration** (drift, not defect) | Do P1 (delete + re-add); re-run. Do not check; do not file a backend bug |
| `ambiguous_connection` does not list `connection_id` / retry by `connection_id` fails | **Retry path defect** | Leave open; file a backend issue with the envelope fields actually returned |
| Only read tools usable; event-sub tools present but `create` errors with a non-ambiguity error | **Event-sub defect** | Leave open; capture the typed error; file a backend issue |
| A URL-shaped connector id appears as operational identity or source selector | **Canonical-key regression** | Leave open; this is in-scope for this change — capture the exact surface and file against `canonicalize-connector-keys` |
| Subscription created but never reaches `active` (no verify handshake) | **Callback delivery gap** | Leave 5.2 open; check receiver reachability/route per `event-subscriptions.md`; this is environment, not necessarily a PDPP defect |

The single most important distinction: **a stale 6-tool surface is host
registration drift and is fixed by delete + re-add — it is never grounds to
declare a backend defect or to weaken canonicalization.** A missing tool or
URL-shaped id that survives a *fresh* re-add against a *current* image is a real
defect.

---

## Pass/fail criteria for Codex (task 5.2 acceptance bar)

Task 5.2 text: "Verify Claude **and** ChatGPT MCP flows can approve multiple
connections, inspect streams, query records, and create event subscriptions
without URL-shaped connector ids." Claude is already `[x]`-grade. To flip 5.2,
Codex must confirm **all** of the following for the ChatGPT side, from a real
ChatGPT run captured in `tmp/workstreams/ri-chatgpt-mcp-live-evidence-<date>.md`:

1. ChatGPT completed OAuth against `/mcp` and lists the **14-tool** PDPP surface
   (T1), with `query_records.connection_id` and all event-sub tools (T2-T3).
2. ChatGPT inspected streams/schema and read records from tool text without
   guessing stream names (S2-S3).
3. The multi-connection `ambiguous_connection` envelope carried
   `connector_key` + `connection_id` (+ `grant_id`, `retry_with`), and the
   **`connection_id` retry succeeded** (S4).
4. ChatGPT drove the **full event-subscription lifecycle**
   create -> (verify -> active) -> list -> get -> send-test -> delete, ending in
   an empty list, against a reachable HTTPS receiver (S5).
5. **No URL-shaped connector id** appeared as operational identity or source
   selector in any owner-facing tool surface; `grant_id` was not used as the
   stable source selector; `connection_id` was (canonical-id invariant).
6. No owner bearer was used with `/mcp` (the MCP path takes grant-scoped client
   bearers only; owner bearers are rejected by design).

**Fail-and-hold** if any of 1-6 is unmet. In particular: if the receiver was
unavailable and S5 was skipped, 5.2 stays open with the read/disambiguation half
recorded as proven and the event-sub half named as the remaining residual — this
matches the prior owner rejection and must not be re-overclaimed.

---

## Appendix A: ChatGPT prompt

Paste into ChatGPT after the connector is freshly added (P1) and the receiver is
running (P3). It supersedes the older
`tmp/workstreams/ri-chatgpt-mcp-live-checklist-2026-05-31.md` by adding the
required event-subscription lifecycle and the canonical-id invariant as
first-class asks.

```text
Using the PDPP MCP connector, do the following and report exact tool-visible
evidence as short facts (no secrets, no full record bodies):

1. List your PDPP tools. Report the count and names. Confirm query_records exposes
   a connection_id input, schema exposes detail and stream inputs, and all seven
   subscription-related tools are present (create/list/get/update/delete +
   send_test + discover capabilities).
2. Call list_streams and schema. Confirm stream names, field capabilities,
   connector_key, and connection_id are readable in the tool text (not only in
   structuredContent). Quote one stream name.
3. Query a small record sample from one allowed stream (query_records, or
   search/fetch). Quote only one harmless field name or short value proving the
   payload is readable.
4. Trigger an ambiguous source: call a stream/record that spans more than one
   connection without passing connection_id. Report whether the error envelope is
   ambiguous_connection and whether available_connections includes grant_id,
   connector_key, connection_id, display_name, and retry_with: "connection_id".
   Then retry with one connection_id and report whether it succeeds.
5. With the HTTPS receiver running, create an event subscription to the receiver
   URL. On a multi-source grant, pass a connection_id. Report: subscription_id,
   whether the one-time whsec_ secret is readable in the tool text (do NOT paste
   it), and the initial status. Then confirm it becomes active, list it, get it,
   send a test event, delete it, and confirm the list is empty afterward.
6. Report whether ANY URL-shaped connector id (https://<host>/connectors/<key>)
   appears as a source identity or selector in tool descriptions, stream/schema
   identity, available_connections, or retry guidance. A manifest_uri labeled as
   provenance is acceptable; an operational selector that is a URL is not.
```

---

## Related

- [`live-proof-packet.md`](live-proof-packet.md) — Gate 2 indexes this packet.
- [`hosted-mcp-setup.md`](hosted-mcp-setup.md) — ChatGPT/Claude setup + the
  schema token-efficiency parity check (owns the delete/re-add stale-registration
  guidance).
- [`event-subscriptions.md`](event-subscriptions.md) — subscription mechanics,
  the local test receiver, and the callback route.
- `tmp/workstreams/ri-external-claude-live-evidence-2026-05-31.md` — the proven
  Claude half of task 5.2.
- `tmp/workstreams/ri-secure-callback-proof-2026-05-31.md` — owner-side secure
  callback delivery (independent of which client drives it).
- `openspec/changes/canonicalize-connector-keys/tasks.md` — task 5.2 itself.
