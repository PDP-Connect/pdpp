# Sitting B operator packet — hosted-MCP client bench (closes/narrows 5.2 + 8.5)

Status: reference/operator runbook. Not PDPP Core or Collection Profile protocol.

This is the single top-level execution packet for **Sitting B** of the
[live-proof batch runbook](live-proof-batch-runbook.md). One operator, one
deployed `/mcp`, two MCP clients, plus one owner-agent bearer credential. It
makes both of Sitting B's gates **mechanically executable with no ambiguity and
no overclaim**:

- **Gate 2 → `canonicalize-connector-keys` task 5.2 (ChatGPT half).** Drive the
  ChatGPT event-subscription lifecycle + `connection_id` retry. The mechanical
  drill-down already exists and is acceptance-grade —
  [`chatgpt-mcp-canonical-proof-packet.md`](chatgpt-mcp-canonical-proof-packet.md).
  This packet sequences it; it does **not** duplicate its steps.
- **Gate 7 → `add-owner-agent-control-surface` task 8.5.** Run the
  Daisy/Simon-style owner-agent REST control smoke (list → label → Amazon intent
  → stop at the owner-mediated step). The mechanical drill-down for this gate is
  **§"Gate 7 mechanical proof" below** — it is the 8.5 analogue of the ChatGPT
  packet and the part that was previously only described conceptually.

Read order: this packet top-to-bottom. It links out for Gate 2's per-call
detail; Gate 7's per-call detail is inline here.

---

## The one rule (inherited from the batch runbook)

**Do not check an OpenSpec box unless you ran the proof and captured the named
no-secrets evidence artifact.** A stale/partial run leaves the box `[ ]` with a
narrowed note. Specifically for this sitting:

- **5.2 is not closed by tool exposure.** The ChatGPT 14-tool surface, the
  `connection_id` retry (messages + Slack), and event-subscription *tool
  presence* are already observed (2026-06-01). 5.2's open clause is the ChatGPT
  **event-subscription lifecycle being driven** (`create → list → get →
  send-test → delete`). The prior reconcile lane was owner-rejected for exactly
  this overclaim — do not repeat it.
- **8.5 is not closed by the device flow working.** The owner-token device flow
  and Simon/Daisy token storage are already confirmed working — those are
  *preconditions*. 8.5's open clause is the **live REST control smoke**: list
  instances → label one → initiate an Amazon intent → stop at the
  owner-mediated step.

---

## Shared preconditions (do once, cover both gates)

### P0. Deployment is current enough (observe the revision header only)

The protected-resource metadata carries the reference revision in the
`PDPP-Reference-Revision` response header. Confirm the deployed origin advertises
a current build before any client work — prints no secret:

```sh
# PDPP_REFERENCE_ORIGIN e.g. https://pdpp.vivid.fish
curl -fsS -D - -o /dev/null \
  "$PDPP_REFERENCE_ORIGIN/.well-known/oauth-protected-resource/mcp" \
  | grep -i 'pdpp-reference-revision'
```

Record the revision string in your evidence note so Codex can confirm the proof
ran against a current image (the 14-tool surface and the owner-agent control
routes both ship in the current reference).

### P1. At least two connections configured

Both gates need ≥2 connections so the multi-connection
`ambiguous_connection → connection_id` path (Gate 2) and a labelable instance
(Gate 7) are reachable. Confirm with an owner read — set `BASE_URL` and
`PDPP_OWNER_SESSION_COOKIE`, **do not echo the cookie**:

```bash
node --input-type=module <<'NODE'
const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const cookie = process.env.PDPP_OWNER_SESSION_COOKIE;
if (!baseUrl || !cookie) throw new Error('Set BASE_URL and PDPP_OWNER_SESSION_COOKIE.');
const r = await fetch(`${baseUrl}/v1/streams`, { headers: { Cookie: cookie, Accept: 'application/json' } });
const body = await r.json();
console.log('stream_count:', Array.isArray(body.data) ? body.data.length : 'n/a');
NODE
```

### P2. Per-gate clients/credentials

- **Gate 2:** a ChatGPT MCP client able to connect to `$PDPP_REFERENCE_ORIGIN/mcp`
  in developer-mode, plus a reachable **HTTPS callback receiver** for the
  event-subscription half (P3 in the ChatGPT packet). The known-good route is
  `https://pdpp-events.vivid.fish/webhook`; start the tracked receiver per
  [`event-subscriptions.md`](event-subscriptions.md) before creating any
  subscription.
- **Gate 7:** a registered **owner-agent bearer credential file**, e.g.
  `~/applications/daisy/.pi/agent/pdpp-owner-agent.json`. The device flow that
  mints it is in
  [`docs/agent-skills/pdpp-owner-agent/references/daisy-runbook.md`](../agent-skills/pdpp-owner-agent/references/daisy-runbook.md)
  Steps 1–3. If you do not yet have a credential, run that first; it is a
  precondition, not part of the 8.5 proof.

> **Bearer hygiene carry-over.** The owner ledger records that a live
> owner-agent bearer was once pasted into chat. If that credential is
> production-sensitive, **rotate/revoke it before this sitting** and onboard a
> fresh one. Never paste the bearer into the transcript, this repo, or any
> command line that gets logged.

---

## Secret handling (applies to every step)

Never print, paste, commit, or screenshot: the MCP integration/client secret,
owner session cookies or bearers, the owner-agent bearer, grant-scoped client
bearers, scoped stream tokens, the per-subscription `whsec_...` delivery secret,
the one-time event-subscription `enrollment_code`, provider credentials,
production connection strings, or raw record contents.

Quote only harmless schema-level facts: stream names, field names, canonical
`connector_key`, `connection_id` values, `subscription_id`, `label_status`,
`next_step.kind`, status strings, counts. Report **invariants**, not the
underlying personal data.

---

## Gate 2 — ChatGPT hosted-MCP event-subscription proof (closes 5.2 ChatGPT half)

**Do not duplicate the steps — follow
[`chatgpt-mcp-canonical-proof-packet.md`](chatgpt-mcp-canonical-proof-packet.md)
verbatim.** It owns: the delete/re-add stale-registration fix (the "6-tool
problem"), the T1–T4 tool-schema checks, the S1–S5 live calls, the
partial-evidence classification table, the signed-callback caveat, and the
exact Codex acceptance bar.

Sequenced summary (detail lives in the packet):

1. **Refresh registration if stale.** In ChatGPT developer-mode, if the PDPP
   connector lists fewer than 14 tools or `query_records` has no `connection_id`,
   **delete and re-add** it against `$PDPP_REFERENCE_ORIGIN/mcp`. A stale 6-tool
   surface is host registration drift, not a backend defect.
2. **Schema checks (T1–T4):** 14 PDPP tools; `query_records` exposes
   `connection_id`; `schema` exposes `detail`/`stream`; all seven
   event-subscription tools present; no URL-shaped connector ids as operational
   identity.
3. **Live calls (S1–S5):** list tools → list streams + inspect schema → query
   records → trigger `ambiguous_connection` and **retry by `connection_id`** →
   drive the **full event-subscription lifecycle** against the HTTPS receiver:
   `discover → create → (verify → active) → list → get → send-test → delete →
   list-empty`.
4. **Signed-callback caveat:** if the client hides the one-time `whsec_` secret
   (mobile / structured-only surfaces), record the lifecycle + canonical-id
   invariant as proven and the signature check as "delivered,
   signature-unverified-from-chat". That **still closes 5.2** — 5.2 requires
   creating subscriptions without URL-shaped ids, not a chat-driven signature
   verification.

**Operator prompt to paste into ChatGPT:** Appendix A of the ChatGPT packet
(verbatim, no secrets). **Evidence file:**
`tmp/workstreams/ri-chatgpt-mcp-live-evidence-<date>.md`. **Delete any
subscription you created** so the deployment is left clean.

---

## Gate 7 — Daisy/Simon owner-agent REST control smoke (closes 8.5)

This is the **owner-agent control plane** — owner-bearer `/v1/owner/*` REST, not
`/mcp`. Task 8.5 text (verbatim):

> Run a live Daisy/Simon-equivalent smoke proving a trusted owner agent can list
> connection instances, label one, initiate a new Amazon connection intent, and
> stop at the owner-mediated provider step.

The typed-`unsupported` path is already unit-covered by
`test/owner-connection-intent.test.js`; **8.5 is the *live* proof** against a
real deployment with a real owner-agent bearer.

### Gate 7 mechanical proof

All four sub-steps run from a terminal you control. The owner-agent bearer is
read from the credential file at call time and **never echoed**. Set once:

```bash
export RS_URL="$PDPP_REFERENCE_ORIGIN"            # e.g. https://pdpp.vivid.fish
export CRED="$HOME/applications/daisy/.pi/agent/pdpp-owner-agent.json"
```

#### G7.1 — Discover control actions + list instances (one non-secret call)

The CLI `control` subcommand reads `GET /v1/owner/control` (capability families)
and `GET /v1/owner/connections` (each instance) and prints them **without the
bearer**:

```bash
pdpp owner-agent control --credential-file "$CRED"
```

Confirm and record (no secrets):
- the control action families and each action's typed `status`
  (`supported` / `owner_mediated` / `unsupported`);
- at least one connection row with its `connection_id`, `connector_key`, and
  `label_status` (`owner_set` or `fallback`).

Pick one connection to label. A `label_status: fallback` row is the natural
target (it is "label-needed"). Capture its `connection_id` into a shell var
**without** capturing any secret:

```bash
export TARGET_CONNECTION_ID="<connection_id from the listing>"
```

> The CLI only drives the two read calls. The label write (G7.2) and the
> Amazon intent (G7.3) are owner-bearer REST calls you issue directly — the
> pattern below reads the bearer from the credential file inside `node` and
> never prints it.

#### G7.2 — Label one connection instance (`PATCH /v1/owner/connections/:id`)

Set an owner-meaningful display name. The route shares the connector-instance
store's rename semantics; on success the row re-projects with
`label_status: "owner_set"`. Choose a non-identifying label for the transcript
(e.g. `Sitting B label check`):

```bash
RS_URL="$RS_URL" CRED="$CRED" TARGET_CONNECTION_ID="$TARGET_CONNECTION_ID" \
LABEL="Sitting B label check" \
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const rs = process.env.RS_URL.replace(/\/$/, '');
const cred = JSON.parse(readFileSync(process.env.CRED, 'utf8'));
const bearer = cred.access_token || cred.credential?.access_token;      // never printed
if (!bearer) throw new Error('No access_token in credential file.');
const id = encodeURIComponent(process.env.TARGET_CONNECTION_ID);
const r = await fetch(`${rs}/v1/owner/connections/${id}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ display_name: process.env.LABEL }),
});
const body = await r.json();
// Print ONLY non-secret invariants:
console.log('http_status:', r.status);
console.log('connection_id:', body.connection_id);
console.log('connector_key:', body.connector_key);
console.log('label_status:', body.label_status);
NODE
```

PASS for G7.2: `http_status: 200` and `label_status: owner_set` on the response.
Re-run `pdpp owner-agent control --credential-file "$CRED"` and confirm the same
`connection_id` now reads `label_status: owner_set` — the label persisted on
re-read. Record the before (`fallback`) and after (`owner_set`) values.

#### G7.3 — Initiate a new Amazon connection intent (`POST /v1/owner/connections/intents`)

Amazon is browser-bound, so the honest typed `next_step` is `unsupported` with a
reason that names the missing browser-collector primitive — **that is the
acceptance-permitted "owner-mediated stop."** The agent never performs the
provider step.

```bash
RS_URL="$RS_URL" CRED="$CRED" \
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const rs = process.env.RS_URL.replace(/\/$/, '');
const cred = JSON.parse(readFileSync(process.env.CRED, 'utf8'));
const bearer = cred.access_token || cred.credential?.access_token;      // never printed
if (!bearer) throw new Error('No access_token in credential file.');
const r = await fetch(`${rs}/v1/owner/connections/intents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ connector_id: 'amazon' }),
});
const body = await r.json();
console.log('http_status:', r.status);
console.log('connector_key:', body.connector_key);
console.log('connector_modality:', body.connector_modality);
console.log('connection_active:', body.connection_active);
console.log('next_step.kind:', body.next_step?.kind);
// The reason names the missing primitive; it is non-secret guidance text. Quote
// only its first clause in evidence if you want; do not paste record contents.
NODE
```

PASS for G7.3 (Gate 1 flip **not** landed — current state):
- `http_status: 201`
- `connector_modality: browser_bound`
- `connection_active: false`
- `next_step.kind: unsupported`
- the reason names the browser-collector enrollment primitive.

PASS for G7.3 (if Gate 1's flip **has** landed by sitting time): instead expect
`next_step.kind: enroll_local_collector`-class branch only if the connector has
been reclassified; until then `unsupported` is correct and is **not** a failure.
Either typed next step that stops before provider auth satisfies 8.5's
"stop at the owner-mediated provider step." Do **not** invent a one-click step.

#### G7.4 — Confirm the `/mcp` boundary holds (owner bearer rejected — by design)

8.5's spec keeps owner bearers off the data plane. Confirm the owner-agent
bearer is rejected at `/mcp` (this is intentional, already pinned by
`test/owner-connection-intent.test.js`; the live check just re-confirms it on
the deployment):

```bash
RS_URL="$RS_URL" CRED="$CRED" \
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const rs = process.env.RS_URL.replace(/\/$/, '');
const cred = JSON.parse(readFileSync(process.env.CRED, 'utf8'));
const bearer = cred.access_token || cred.credential?.access_token;
const r = await fetch(`${rs}/mcp`, { headers: { Authorization: `Bearer ${bearer}` } });
console.log('mcp_http_status:', r.status);   // expect 401/403 — owner bearers are control-plane only
NODE
```

PASS for G7.4: a `401` or `403`. A `200` here is a **boundary defect** — stop and
file against `add-owner-agent-control-surface`; do not close 8.5.

### Gate 7 evidence (no secrets) — paste this filled-in to Codex

Write to `tmp/workstreams/ri-owner-agent-control-live-evidence-<date>.md`:

```
Deployment: <PDPP_REFERENCE_ORIGIN>   revision: <PDPP-Reference-Revision value>
Owner-agent bearer: present (kind=owner), value withheld.

G7.1 control:
  control action families observed: <list family keys + each status>
  connection listed: connection_id=<id> connector_key=<key> label_status=fallback

G7.2 label:
  PATCH /v1/owner/connections/<id> {display_name:"Sitting B label check"} -> 200
  label_status before=fallback  after=owner_set
  re-read via `owner-agent control` confirms owner_set persisted.

G7.3 amazon intent:
  POST /v1/owner/connections/intents {connector_id:"amazon"} -> 201
  connector_modality=browser_bound  connection_active=false
  next_step.kind=unsupported  (reason names the browser-collector primitive)
  agent performed NO provider auth.

G7.4 boundary:
  GET /mcp with owner bearer -> <401|403>  (owner bearer rejected by design)

No URL-shaped connector id appeared as operational identity or selector in any
owner-facing response; the source selector was connection_id, the connector type
was canonical connector_key.
```

### Gate 7 Codex acceptance bar (8.5)

To flip 8.5, Codex must confirm **all** from the live evidence file:

1. The agent listed connection **instances** by `connection_id` (not just
   templates) via `GET /v1/owner/connections`. (G7.1)
2. A **label write succeeded** (`PATCH` → 200, `label_status: owner_set`) and is
   **reflected on re-read**. (G7.2)
3. The **Amazon intent** returned a typed next step that **stops at the
   owner-mediated step** (`unsupported` naming the primitive, or a
   reclassified-but-still-pre-auth step if Gate 1 flipped), with
   `connection_active: false` and no provider auth driven by the agent. (G7.3)
4. The owner bearer is **rejected at `/mcp`** (401/403). (G7.4)
5. **No URL-shaped connector id** appeared as operational identity or source
   selector; `connection_id`/`connector_key` were canonical.
6. The smoke ran against a **live deployment** with a **real owner-agent
   bearer**, not a unit test.

**Fail-and-hold** if any of 1–6 is unmet, or if the bearer leaked anywhere. A
label write that does not persist on re-read, an intent that completes provider
auth, a wrong-instance mutation, or a `/mcp` 200 each leaves 8.5 open with the
exact failing observation captured.

### Gate 7 partial-evidence classification

| Observed | Classification | Box action |
|---|---|---|
| G7.1–G7.4 all pass; no URL-shaped ids; live bearer | **Full 8.5 proof** | Codex may check 8.5 |
| List + intent pass but label write does not persist on re-read | **Label-mutation defect** | Leave 8.5 open; file against the rename route with the before/after `label_status` |
| Amazon intent completes provider auth / returns a one-click connect step | **Owner-mediation breach** | Leave 8.5 open; this contradicts the spec — capture the `next_step` and file |
| `/mcp` accepts the owner bearer (200) | **Boundary defect** | Leave 8.5 open; file against `add-owner-agent-control-surface`; do not close |
| A URL-shaped connector id appears as identity/selector | **Canonical-key regression** | Leave 8.5 open; capture the surface; in-scope for `canonicalize-connector-keys` too |

---

## Sitting B close-out

Two no-secrets evidence notes should exist:
- `tmp/workstreams/ri-chatgpt-mcp-live-evidence-<date>.md` (Gate 2 / 5.2)
- `tmp/workstreams/ri-owner-agent-control-live-evidence-<date>.md` (Gate 7 / 8.5)

**OpenSpec checkboxes Codex may close if the sitting succeeds** (do not check
them yourself — Codex is the gating reviewer):

- `canonicalize-connector-keys` **5.2** — only if the ChatGPT
  **event-subscription lifecycle was driven** (create → list → get → send-test →
  delete), the `connection_id` retry succeeded, and no URL-shaped connector ids
  appeared. Tool exposure alone does not close it.
- `add-owner-agent-control-surface` **8.5** — only if the live REST smoke proved
  list-by-`connection_id` → label-persists-on-re-read → Amazon intent stops at
  the owner-mediated step → `/mcp` rejects the owner bearer.

**Leave open with a narrowed note** any gate whose live half did not complete
cleanly (e.g. ChatGPT receiver unavailable → 5.2's read/disambiguation half
recorded, event-sub half named as residual; 8.5 label persisted but Amazon
intent unrun → record the partial).

**Cleanup:** delete any test event subscription created in Gate 2. The Gate 7
label write is a real owner-meaningful rename — leave it, or restore the prior
label if the operator prefers (re-PATCH with the original `display_name`).

---

## Related

- [`live-proof-batch-runbook.md`](live-proof-batch-runbook.md) — Sitting B is
  defined there; this packet is its mechanical execution layer.
- [`chatgpt-mcp-canonical-proof-packet.md`](chatgpt-mcp-canonical-proof-packet.md)
  — Gate 2 / 5.2 per-call drill-down (this packet sequences it).
- [`event-subscriptions.md`](event-subscriptions.md) — the local test receiver
  and callback route for Gate 2's event-subscription half.
- [`docs/agent-skills/pdpp-owner-agent/references/daisy-runbook.md`](../agent-skills/pdpp-owner-agent/references/daisy-runbook.md)
  — owner-agent device-flow onboarding (Gate 7 precondition) + Step 5b control
  plane narrative.
- [`docs/agent-skills/pdpp-owner-agent/references/control-surface.md`](../agent-skills/pdpp-owner-agent/references/control-surface.md)
  — owner-agent control-surface boundary + capability families.
- `openspec/changes/canonicalize-connector-keys/tasks.md` — task 5.2.
- `openspec/changes/add-owner-agent-control-surface/tasks.md` — task 8.5.
