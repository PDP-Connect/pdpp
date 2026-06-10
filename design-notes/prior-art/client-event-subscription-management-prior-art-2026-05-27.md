# Operator/Owner Oversight of Outbound Event Subscriptions — Prior Art

**Status:** captured
**Date:** 2026-05-27
**Lens:** How leading platforms expose subscription management to the **server operator** (party that runs the resource server) — distinct from the **client developer** (party that owns the consuming endpoint).
**Out of scope:** Wire format (signing, headers, payload) — PDPP already has Standard-Webhooks-aligned signing. We are only researching the management/oversight surface.

---

## Primary sources (accessed 2026-05-27)

| # | Source | URL |
|---|--------|-----|
| 1 | Stripe — Webhooks docs (Workbench, retries, signing) | https://docs.stripe.com/webhooks |
| 1 | Stripe — Webhooks best practices | https://docs.stripe.com/webhooks/best-practices |
| 1 | Stripe CLI — `events resend` | https://docs.stripe.com/cli/events/resend |
| 2 | Standard Webhooks spec v1.0.0 | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md |
| 3 | Svix — Consumer App Portal | https://docs.svix.com/app-portal |
| 3 | Svix — Replaying messages | https://docs.svix.com/receiving/using-app-portal/replaying-messages |
| 3 | Svix CLI | https://github.com/svix/svix-cli, https://docs.svix.com/tutorials/cli |
| 4 | GitHub — Redelivering webhooks | https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks |
| 4 | GitHub — Viewing webhook deliveries | https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries |
| 4 | GitHub — REST API for org webhooks | https://docs.github.com/en/rest/orgs/webhooks |
| 5 | Auth0 — Log Streams | https://auth0.com/docs/customize/log-streams |
| 6 | MCP spec 2025-06-18 — Resources/subscribe | https://modelcontextprotocol.io/specification/2025-06-18/server/resources |
| 7 | CloudEvents Subscriptions API v0.1-wip | https://github.com/cloudevents/spec/blob/main/subscriptions/spec.md |

---

## 1. Stripe Workbench (Dashboard)

- **Who manages:** Stripe-account team members with Developer / Workbench access. Endpoints are scoped to the **account**, not to a per-client grant — the resource owner sees the full list. Stripe Connect platforms can view connected-account-scoped webhook endpoints as platform owner.
- **List/disable surface:** Workbench → Webhooks tab. Each endpoint has Enable/Disable/Delete in the overflow menu. No per-grant scoping because Stripe doesn't model client grants.
- **Delivery health surfaced:**
  - `Event deliveries` tab per endpoint: list of events with status `Delivered | Pending | Failed`, HTTP status code, and next-retry time.
  - "Automatic retries" for up to **3 days** with exponential backoff in live mode (3 retries over hours in sandbox).
  - Stripe auto-disables endpoints after sustained failures (documented as 3 days of continuous failure → email + disable, surfaced separately in best-practices).
- **Secret rotation:** Per-endpoint overflow menu → **Roll secret**. Two modes: immediate-expire, or delayed up to 24h with both old + new active in parallel (Stripe signs with all active secrets).
- **Replay:** Per-event "Resend" action in the Event deliveries view. Manual resend does **not** dismiss Stripe's auto-retry schedule.
- **CLI mirror:** Yes, full parity. `stripe webhook_endpoints list/create/update/delete`, `stripe events list --delivery-success=false`, `stripe events resend <event_id> --webhook-endpoint <we_…>`. Stripe CLI events list only returns last 30 days.

## 2. Standard Webhooks spec

- **Scope of spec:** Mostly wire (signature scheme, headers `webhook-id`/`webhook-timestamp`/`webhook-signature`, idempotency, payload). **But** it has an explicit "Operational considerations" section that prescribes a management surface.
- **What the spec mandates on the management side** (verbatim section titles, captured 2026-05-27):
  - `#### Endpoint management API` — "Having an API to add, remove, and list webhook endpoints enables both webhook consumers and third party developers to build automation on top of webhooks." Treated as a recommendation, not a hard MUST.
  - `#### Visibility into failures and manual retries` — recommended UI/API surface; no schema given.
  - Retries: recommends multi-day exponential backoff + jitter, honor `Retry-After` on 503.
- **Roles:** Spec is silent on operator-vs-client distinction. It assumes a single management API consumed by either the producer's UI or the consumer's automation.
- **Useful quote:** The spec validates that an endpoint-management API is part of "a good webhook experience" — but does not prescribe scoping, audit, or admin override.

## 3. Svix Consumer App Portal

- **Two-tier model — most directly analogous to PDPP's operator-vs-client split:**
  - **Svix Management API** (server-to-server, with the org auth token): the **application owner** (= operator) manages applications, endpoints across all apps, message attempts, replays, and can issue scoped portal tokens. CLI uses this token.
  - **Consumer App Portal** (iframe or React hooks): the **end-customer/consumer** (= client developer) self-serves CRUD on *their own* endpoints, sees their own attempts, can replay their own messages.
- **Capability gating:** `authentication.app-portal-access` accepts a `capabilities` array. `ViewBase` gives read-only. Operator chooses exactly what each consumer-scoped token can do; the same UI re-renders accordingly.
- **Delivery health surfaced (per endpoint):** attempt list with HTTP code, response body preview, next-retry time, "Recover Failed Messages" bulk action, per-message Replay menu, replay-since-timestamp.
- **Auto-disable:** After full retry schedule exhausts, message marked failed; endpoint can be auto-disabled after sustained failure (configurable on the org).
- **Secret rotation:** Available in the consumer portal — endpoint owner rotates their own signing secret. Operator can also force via management API.
- **CLI:** `svix endpoint`, `svix message`, `svix message-attempt list/resend`, `svix listen` (local relay). CLI uses operator-scoped token (`SVIX_AUTH_TOKEN`); there is no separate "consumer CLI."
- **Key insight for PDPP:** Svix solves the exact same problem PDPP faces (multi-tenant, operator-vs-consumer scoping) and chose **one UI rendered with different capability sets**, not two UIs. Same JSON API, different bearer scopes.

## 4. GitHub Org vs Repo webhooks

- **Who manages:**
  - Repo webhooks: repo admins. Scope: that one repo.
  - **Org webhooks: only organization owners.** Scope: all events in the org. Documented as "only organization owners can redeliver webhooks in that organization."
- **Delivery health surfaced:** Settings → Webhooks → click webhook → **Recent deliveries** tab. Shows last 3 days of attempts with request/response payload, HTTP code, GUID for redelivery.
- **Replay:** Per-delivery "Redeliver" button. Programmatic via `GET /orgs/{org}/hooks/{hook_id}/deliveries` + `POST /orgs/{org}/hooks/{hook_id}/deliveries/{delivery_id}/attempts`. Auto-redeliver not built-in; documented Actions workflow recipe using `admin:org_hook` PAT.
- **Auto-disable:** Yes — GitHub auto-disables hooks after sustained 4xx/5xx failures; surfaced as a banner on the hook page.
- **Secret rotation:** Manual via Edit webhook → Secret field. No staged rotation (single active secret).
- **CLI:** Partial via `gh api repos/{owner}/{repo}/hooks/{hook_id}/deliveries` etc. No dedicated `gh webhook redeliver` UX command; users script around `gh api`. `gh webhook forward` exists for local relay (analogous to `stripe listen`).
- **Key insight:** GitHub explicitly models the **owner-scope hierarchy** (org owner vs repo admin) — closest to PDPP's owner-vs-grant question. Each tier has its own URL and permission gate; deliveries are not co-listed across tiers.

## 5. Auth0 Log Streams

- **Audience:** Tenant operator (Auth0 account admin). There is no client-side surface — clients receive events, they do not configure the stream.
- **Dashboard surface:** Monitoring → Streams. Each stream has Pause, View settings, Update, and a **Health** tab.
- **Delivery health:** Up to 3 delivery attempts per log batch. If all 3 fail, an error appears in the **Health** view. After **7 consecutive days of failure, Auth0 automatically pauses the stream**. Resume is operator-manual.
- **Replay:** No first-class replay. Workaround documented: delete + recreate stream with a "Starting Cursor" set within the retention window.
- **Secret rotation:** Per-destination (e.g., custom-webhook URL/auth header) editable in dashboard. No staged rotation.
- **CLI:** Auth0 CLI (`auth0 logs streams`) supports list/show/create/update/delete. Health view is dashboard-only.
- **Key insight:** Pure operator surface, no consumer self-service. The 7-day auto-pause is a notable concrete threshold; the "Health" tab is the most operator-centric framing of any platform here.

## 6. MCP (Model Context Protocol) — important null result

- **Subscription mechanism:** `resources/subscribe` (per-URI) + `notifications/resources/updated`. Capability bit `resources.subscribe: true`.
- **Management surface in the spec: NONE.** The spec defines only:
  - `resources/list`, `resources/templates/list`
  - `resources/subscribe` (per-session, per-URI)
  - `notifications/resources/list_changed`, `notifications/resources/updated`
  - Error codes `-32002` (not found), `-32603` (internal)
- **No spec text for:** listing active subscriptions, force-unsubscribing, viewing delivery/notification history, admin oversight, multi-client cross-grant view.
- **Subscription state is implicitly transport-bound:** subscribe lives within the client↔server session. There is no documented persistence model and no admin tool surface for inspecting subscriptions across sessions.
- **Precedent for admin/operator tools in MCP:** none found in the 2025-06-18 spec. MCP's posture is "tools are what the connected client can do" — admin-only tools would have to be exposed as a separate MCP server (e.g., `pdpp-admin-mcp`) bound to an owner-scoped credential, not mixed into the read-only grant-scoped MCP adapter.
- **Implication for PDPP:** Adding owner controls to the existing read-only, grant-scoped MCP adapter would break MCP's session/scoping model. If MCP exposure is desired at all, it belongs in a separate operator-only MCP server — but no other platform we surveyed does this, and there's no precedent in the spec.

## 7. CloudEvents Subscriptions API (v0.1-wip)

- **Status:** Work-in-progress. Defines a REST-shaped subscription manager.
- **Operations:** `POST /subscriptions` (Create), `GET /subscriptions/{id}` (Retrieve), `PUT /subscriptions/{id}` (Update), `DELETE /subscriptions/{id}` (Delete), `GET /subscriptions` (**Query** — SHOULD be supported, returns list "associated with or otherwise visible to the party making the request").
- **Delivery health attributes:** None defined in the subscription object schema. No `status`, `last_error`, `attempt_count`, `last_attempt_at`. Filters are defined; health is not.
- **Roles:** Spec calls out a "subscription manager" abstraction and notes the producer MAY delegate or assume that role, but does not enumerate operator-vs-subscriber permissions. The Query operation's "visible to the party making the request" line is the only nod to scoping — implementation-defined.
- **Replay/auto-disable:** Not in spec.
- **Key insight:** Pure CRUD shape with no oversight semantics. PDPP's current `/v1/event-subscriptions` already matches this surface. Useful as a structural validation of our own CRUD shape; provides nothing operator-side.

---

## TL;DR for PDPP

| Source | Operator can list across grants? | Health signals exposed | Auto-disable threshold | Replay surface | Secret rotation | CLI |
|---|---|---|---|---|---|---|
| Stripe Workbench | Yes (single account scope) | Status, HTTP code, next-retry, attempt list per event | ~3 days continuous failure → email + disable | Per-event Resend (UI + CLI) | Staged roll (up to 24h overlap) | Full parity |
| Standard Webhooks | "SHOULD have endpoint mgmt API" + "visibility into failures" — no schema | Recommends visibility, no fields | Recommended, no threshold | Recommended | Not specified | N/A (spec) |
| Svix App Portal | Yes (org token); consumer portal scoped to one app | Attempts, body preview, retry-next, replay-since | Configurable | Per-message + bulk recover-failed | Self-serve in portal | Full parity (`svix`) |
| GitHub Org webhooks | Org owner only, org-scoped | 3-day delivery log per hook, request/response payload | Yes (sustained 4xx/5xx) | Per-delivery Redeliver | Manual, no staging | Partial (`gh api`) |
| Auth0 Log Streams | Tenant admin only | Health tab, error logging | 7 days consecutive → auto-pause | None (recreate w/ cursor) | Manual | Yes (`auth0`) |
| MCP Resources | **Not specified — no management surface in spec** | None | None | None | N/A | N/A |
| CloudEvents Subs | Implementation-defined ("visible to the party") | None in schema | None | None | None | N/A |

---

## Verdict: copy / skip / defer

### Copy (high confidence — all major platforms converge here)

1. **Two-tier surface, one data model, capability-gated views** — Svix's model. PDPP's `/v1/event-subscriptions` is the consumer-scoped layer (client bearer). Add `/v1/admin/event-subscriptions` (or scope by claim) that uses the **same record shape** with extra fields visible and extra actions allowed. Do not build a separate admin data model.
2. **Per-subscription attempt log** — Stripe + Svix + GitHub all expose `status | HTTP code | timestamp | response preview | next-retry`. PDPP should persist last N attempts (N=20-50) and expose them on both surfaces; only the operator surface lists across grants.
3. **Auto-disable on sustained failure** — concrete thresholds: Stripe ~3d, Auth0 7d, GitHub on sustained 4xx/5xx. Pick a number (recommend 3d to match Stripe / Svix conventions) and notify the grant owner before disable.
4. **Operator force-disable + audit trail** — GitHub-style explicit owner override, write an event into the audit log when used.
5. **Staged secret rotation** — Stripe's two-secrets-active-up-to-24h pattern. PDPP already signs; add a `secondary_secret` + expiry. Self-service for clients, force-able by operator.
6. **CLI mirror for operator surface** — Stripe/Svix/Auth0 all have parity. PDPP `pdpp` CLI should grow `event-subscriptions list/disable/inspect/attempts` against the owner token (already used by the `pdpp-local-data-access` skill).

### Skip / defer

1. **MCP admin tools.** No precedent in the spec, would violate the read-only/grant-scoped posture of the existing adapter. If demanded later, ship a *separate* `pdpp-admin-mcp` server with owner-only credentials — don't extend the grant-scoped one. Document this as an explicit non-goal.
2. **CloudEvents subscriptions schema.** Our CRUD already matches; the spec adds nothing operator-side and is `v0.1-wip`. Don't refactor toward it.
3. **Replay across grants / bulk replay** (Svix "Recover Failed Messages"). Defer — useful but not in the SLVP. Per-attempt resend is enough for v1; bulk replay raises consent-replay-window questions we haven't shaped.
4. **Embedded consumer portal UI** (Svix iframe pattern). Defer until we have a >1 client developer pilot. Per-grant API + CLI is sufficient until then.

### Open question for the brief

- Should the operator-side list be **flat (all subscriptions across all grants)** or **grouped by grant/client** in the UI? GitHub's org/repo hierarchy and Stripe's flat account list are both well-loved. Recommend grouped-by-client, because PDPP's grant boundary is the consent boundary and operators reason about clients-then-events, not events-then-clients.
