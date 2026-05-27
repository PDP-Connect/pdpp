# SLVP Reference Implementation — Prior-Art Synthesis

Status: captured
Owner: RI prior-art right-hand
Created: 2026-05-27
Updated: 2026-05-27
Related:
- `design-notes/full-context-refresh.md`
- `docs/agent-workstream-playbook.md`
- `docs/voice-and-framing.md`
- `spec-core.md`
- `spec-collection-profile.md`
- `design-notes/schedule-manual-attention-prior-art-2026-05-21.md`
- `design-notes/2026-05-16-run-automation-assistance-and-capability-gaps.md`
- `design-notes/retained-size-and-data-explorer-substrate-2026-05-22.md`
- `design-notes/client-event-subscriptions-and-freshness-2026-04-26.md`
- `design-notes/source-webhooks-and-event-driven-collection-2026-05-15.md`
- `design-notes/connection-first-collection-identity-2026-05-18.md`
- `design-notes/local-collector-durable-work-substrate-2026-05-19.md`
- `design-notes/mcp-server-design-research-2026-05-21.md`
- `openspec/changes/canonicalize-public-read-contract`
- `openspec/changes/define-schedule-manual-attention-policy`
- `openspec/changes/add-client-event-subscriptions`
- `openspec/changes/republish-remote-surface-as-opendatalabs`
- `openspec/changes/make-remote-surface-oss-publishable`

## Purpose

This note is the 2026-05-27 prior-art sweep across the six currently tracked PDPP reference-implementation (RI) decision areas. The repo already has deep prior-art notes for most of these topics; the value-add here is a single readable synthesis that maps each finding to the Core / Collection Profile / Reference-Implementation boundary, marks SLVP confidence, and names the construction primitives the RI should not negotiate away.

Per `voice-and-framing.md`, none of these decisions become PDPP Core unless explicitly noted. The default home is the RI; the Collection Profile companion is touched only where a runtime contract has earned standardization.

Confidence labels used throughout:

- **[SLVP]** — confident: build it this way for the next tranche.
- **[OPEN]** — real tradeoff the owner must still call; not a blocker.
- **[DEFER]** — explicitly out of scope for the SLVP bar.
- **[N/A-Core]** — not protocol-relevant; RI/Collection-Profile only.
- **[ANTI]** — prior art shows the failure mode; design must avoid this.

---

## Topic 1 — Scheduled / background jobs that need human attention

### Boundary

[N/A-Core] / Collection-Profile-light / **RI-owned.** Core grants and disclosure remain unaffected. The Collection Profile already allows runs to finish in non-`succeeded` terminal states (`failed`, `cancelled`); SLVP needs the RI to attach durable lifecycle to *why* a run is non-green, not to push attention semantics into the wire protocol.

### Findings (synthesized from `design-notes/schedule-manual-attention-prior-art-2026-05-21.md` and `design-notes/2026-05-16-run-automation-assistance-and-capability-gaps.md`, plus a 2026-05-27 cross-check)

- Temporal schedules separate execution policy (overlap, catchup, `pause_on_failure`) from workflow logic. https://docs.temporal.io/schedule (accessed 2026-05-27)
- GitHub Actions environments separate the *triggered job* from the *approval gate* with wait timers up to 30 days — useful prior art for "this run is alive but stopped waiting for a human". https://docs.github.com/en/actions/reference/deployments-and-environments (accessed 2026-05-27)
- Prefect automations split triggers from actions and treat notification, schedule pause/resume, and run suspend/resume as composable. https://docs.prefect.io/v3/concepts/automations (accessed 2026-05-27)
- Fivetran distinguishes active, broken, delayed, incomplete, and paused; alerts split blocking errors from non-blocking warnings. Crucially, Fivetran auto-pauses connectors after a sustained failure window (currently 14 days). https://fivetran.com/docs/getting-started/fivetran-dashboard/connectors and https://fivetran.com/docs/getting-started/fivetran-dashboard/alerts (accessed 2026-05-27)
- Plaid Item repair uses explicit relink flows (`ITEM_LOGIN_REQUIRED`, `PENDING_DISCONNECT`); `LOGIN_REPAIRED` lets apps suppress repair UI when the issue self-heals. https://plaid.com/docs/api/items/ (accessed 2026-05-27)
- Zapier's "decide how your Zap handles errors" pattern shows per-connection failure policy beats one global rule. https://help.zapier.com/hc/en-us/articles/14167175792909 (accessed 2026-05-27)
- Sidekiq's dead-set / Solid Queue's `failed_executions` and Que's `error_count` all model the same primitive: failures are durable rows with retry ladders, not log lines. https://github.com/sidekiq/sidekiq/wiki/Error-Handling, https://github.com/rails/solid_queue (accessed 2026-05-27)
- MDN push/notifications guidance separates permission, subscription, test, and delivery state — the four-fact model the dashboard needs. https://developer.mozilla.org/en-US/docs/Web/API/Push_API/Best_Practices (accessed 2026-05-27)

### SLVP direction

- **[SLVP] Three load-bearing RI nouns**: `schedule` (intent + eligibility), `run` (bounded attempt), `attention_request` (durable typed task). Already aligned with `openspec/changes/define-schedule-manual-attention-policy`.
- **[SLVP] Run terminal vocabulary**: `succeeded`, `succeeded_with_gaps`, `failed_retryable`, `failed_not_retryable`, `waiting_for_operator`. Cancelled stays from the Collection Profile.
- **[SLVP] Attention lifecycle**: open → acknowledged → snoozed → resolved → superseded → expired. Notification is *delivery evidence on the task*, not the task itself.
- **[SLVP] Dedup key for attention**: `(connection, schedule, attention_kind, affected_account_or_resource)`. Recurrence increments `occurrence_count` and `last_seen_at` rather than spawning new prompts.
- **[SLVP] Catchup default**: at most one latest-state run after attention clears. Broader backfill must be connector-declared and bounded.
- **[SLVP] Auto-pause-after-threshold** (Fivetran shape) with explicit "Resume" CTA. The threshold is per-connection policy, default conservative (e.g. 7 days of failure).
- **[SLVP] Trigger kind is metadata** (`manual` | `scheduled` | `retry` | `webhook`), not separate execution paths. From `2026-05-16-run-automation-assistance-and-capability-gaps.md`.
- **[SLVP] Notification taxonomy**: action-required vs informational; per-channel opt-in; quiet hours apply to informational only.
- **[ANTI] Replaying every missed schedule tick** after attention clears. The unbounded-catchup failure mode is named in the prior-art note.
- **[ANTI] Connector-specific state enums** (`chatgpt_push_pending`, `chase_otp_pending`) as durable model. They are incidental; reduce to durable axes (progress posture, owner action, response obligation, urgency).
- **[OPEN] Quiet hours**: single local window vs. per-channel windows. Recommend single window for SLVP.
- **[DEFER] Snooze ladders, smart-quiet-hours learning**, mute-by-source — accrete only after the durable task exists.

### Promotion status

Already promoted: `define-schedule-manual-attention-policy`, `add-run-automation-policy-model`. SLVP work fits inside these; no new OpenSpec change required.

---

## Topic 2 — Data explorer / search / timeline UX

### Boundary

**RI-owned**, with backend hooks that *might* climb into the canonical public read contract. The retained-size projection and faceted browsing live in `_ref` and dashboard UI. Field-typed cards, view tabs, and per-record schema hints are the only items that could need Core/Collection-Profile thinking, and only if exposed to clients.

### Findings (synthesized from `retained-size-and-data-explorer-substrate-2026-05-22.md`, `add-dashboard-records-explorer/design.md`, and a 2026-05-27 cross-check)

- PostgreSQL materialized views are the closest stock primitive but lack incremental maintenance; PDPP needs explicit projection hooks + dirty-row marking. https://www.postgresql.org/docs/current/rules-materializedviews.html (accessed 2026-05-27)
- BigQuery `INFORMATION_SCHEMA.TABLE_STORAGE` distinguishes current vs long-term vs time-travel bytes — same shape PDPP needs (`current_record_json_bytes`, `record_history_json_bytes`, `blob_bytes`). https://cloud.google.com/bigquery/docs/information-schema-table-storage (accessed 2026-05-27)
- Datadog Logs Explorer separates *facets* (qualitative dimensions) from *measures* (quantitative with units, e.g. bytes). https://docs.datadoghq.com/logs/explorer/facets/ and https://docs.datadoghq.com/logs/explorer/ (accessed 2026-05-27)
- Kibana / Elastic Discover field statistics show the "understand this slice" mode before visualization — top values, distributions, cardinality, examples. https://www.elastic.co/guide/en/kibana/current/discover-field-statistics.html (accessed 2026-05-27)
- Metabase drill-through models the "click a number → see the records" pattern PDPP needs for token-efficient AI exploration. https://www.metabase.com/learn/metabase-basics/getting-started/drill-through (accessed 2026-05-27)
- Algolia/Meilisearch faceted-search APIs limit facets to declared dimensions, not arbitrary JSON paths — the right discipline for an agent-facing API. https://www.algolia.com/doc/guides/managing-results/refine-results/faceting/ (accessed 2026-05-27)
- Stripe Sigma exposes structured tables with bounded query semantics rather than arbitrary BI; useful precedent for an opinionated "what an owner can ask" surface.
- Splunk Pivot / Looker LookML show the cost of letting users author arbitrary group-bys — recommend system-authored dimensions only for SLVP.

### SLVP direction

- **[SLVP] Retained-size read model with explicit grain**: global, connection, stream, retention-class, optional top-N. Already aligned with `add-retained-size-read-model` + `add-dashboard-summary-read-model`.
- **[SLVP] Typed measures vs dimensions** (Datadog discipline). Bytes are typed measures; connection/connector/stream/retention-class/time-bucket are dimensions.
- **[SLVP] Finite, system-authored dimension set**. No arbitrary JSON path drilldowns in SLVP.
- **[SLVP] Honest freshness/staleness metadata per aggregate family**. A row that is hours-stale must say so.
- **[SLVP] Drilldown affordance** (Metabase-style): "show me the records behind this number" — the dashboard explorer's peek pane already does this via `?peek=<connector>::<stream>::<id>`.
- **[SLVP] Records explorer remains connection-first**. URL chips encode `connection=` and `stream=`; identity flows from canonical `connection_id`.
- **[SLVP] Token-efficient AI exploration**: agents call the canonical query API with `Prefer: count=estimated`, then drill into specific records. Counts and date-histograms should be opt-in and cost-graded.
- **[SLVP] Saved views = URL state**, not server-stored objects. URL round-trip is the persistence model.
- **[SLVP] Partial-results transparency**: `meta.warnings` is the place to surface "estimated count downgraded", "approximate facets", "blob index incomplete".
- **[OPEN] Date histograms**: are they an `_ref` capability or part of the canonical read contract? Recommend `_ref` for SLVP, climb to canonical only with evidence.
- **[OPEN] Field-level statistics** (Kibana shape) — privacy implications (top-values reveal). Defer unless a concrete consumer asks.
- **[DEFER] Typed manifest stream schemas** (per `add-dashboard-records-explorer/design.md` §"Backend / API gaps"). Card dispatch, view tabs, and grant projection chip all need this. Promote separately if/when a consumer arrives.
- **[ANTI] Per-view ad hoc SQL on the request path** — the current dashboard symptom that motivated `retained-size-and-data-explorer-substrate`. Aggregations belong in maintained projections.
- **[ANTI] Generic BI/group-by engine** in SLVP scope.

### Promotion status

Backend substrate covered by `add-retained-size-read-model`, `add-dashboard-summary-read-model`, `add-dashboard-records-explorer`. The "promote to canonical read contract" decisions for date histograms / facets are gated on `canonicalize-public-read-contract` — no new change needed yet.

---

## Topic 3 — Canonical read / query API design

### Boundary

**Core-adjacent.** This is the public read contract that clients use under a grant — fully Core-relevant. The implementation lives in the RI, but the contract is normative.

### Findings (synthesized from `openspec/changes/canonicalize-public-read-contract/design.md` and `tmp/workstreams/canonical-read-contract-right-hand-report.md`, which is itself a 2026-05 prior-art deep-dive)

Existing prior art (each URL accessed 2026-05-27):

- JSON:API — `data`/`links`/`meta` envelope, sparse fieldsets, relationship inclusion; intentionally underspecified filters. https://jsonapi.org/format/ — take envelope discipline, not filter ambiguity.
- OData — `$select`/`$expand`/`$orderby`/`$count`/server-driven next links. https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part2-url-conventions.html — take metadata + count vocabulary, not the `$filter` DSL.
- GraphQL Relay — opaque cursors, refetchable identity. https://relay.dev/graphql/connections.htm and https://graphql.org/learn/global-object-identification/ — `totalCount` is deliberately outside the connection spec; don't retrofit everywhere.
- FHIR Search — capability statement + non-fatal `OperationOutcome`. https://www.hl7.org/fhir/search.html — strongest precedent for portability-grade API; PDPP's `meta.warnings` is the FHIR `OperationOutcome` analogue.
- Stripe — `expand[]` is one-hop inline (no JSON:API `included` sidecar). https://docs.stripe.com/api/expanding_objects and https://docs.stripe.com/api/pagination — pragmatic and agent-friendly.
- Elasticsearch — aggregations + approximate counts. https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations.html — full DSL out of scope; honest approximation discipline in scope.
- PostgREST — `Prefer: count=none|planned|estimated|exact`. https://postgrest.org/en/stable/references/api/pagination_count.html — best cost-shape for counts.
- MCP — `inputSchema` / `outputSchema` / `structuredContent` / `readOnlyHint`. https://modelcontextprotocol.io/specification/2025-06-18/server/tools — carrier, not contract.

### SLVP direction

All of these align with the in-flight `canonicalize-public-read-contract`. Stated as crisp invariants:

- **[SLVP] Canonical record address**: `(connection_id, stream, record_id)` on every record-bearing public read result. `connector_instance_id` deprecated alias during migration only.
- **[SLVP] Uniform envelope** `{ object, data, has_more?, links: { self, next }, meta: { count, warnings } }`.
- **[SLVP] Strict validation**: unknown params/fields/operators/sort/expansion reject with typed errors. No silent no-op. Migration-era aliasing emits structured warnings.
- **[SLVP] Projection**: `fields=` allowlist applies to top-level and expanded records. No FHIR-style `_summary` + `_elements` dual mechanism.
- **[SLVP] Expansion**: one-hop inline `expand[]` for manifest-declared parent→child relations; `expand_limit` for has-many. No reverse joins, no nested expansion in SLVP.
- **[SLVP] Filters**: `filter[field]=value` and `filter[field][op]=value` with per-field operator capabilities from `/v1/schema`. No OData boolean expression DSL.
- **[SLVP] Sort**: sign-prefix (`sort=-emitted_at,name`) over schema-advertised sortable fields.
- **[SLVP] Pagination**: opaque cursor + `has_more` + `links.next`. Offset pagination is sandbox/legacy only.
- **[SLVP] Counts graded**: `Prefer: count=none|estimated|exact`; response carries `meta.count = { kind, value? }`; downgrade emits a warning.
- **[SLVP] Capability document**: `/v1/schema` enumerates streams, fields, filterable + sortable + expandable + projectable surfaces, search modes, count support, granted connections.
- **[SLVP] Search-as-records**: hits carry the same `(connection_id, stream, record_id)` identity; never reconstructed by the consumer.
- **[SLVP] MCP mirrors REST**, never solves ambiguities differently. Tool I/O schemas are derived from the canonical contract, prose `content[]` is a summary.
- **[OPEN] Reverse-expand / belongs-to** beyond one hop — wanted by AI agents, but blows up enforcement complexity. Probably needs to be a separate, scoped capability declaration when promoted.
- **[OPEN] Cross-stream "recent feed"** (the `add-dashboard-records-explorer` design surfaces this as a Backend Gap). A cheap `_ref/records/recent` is operator-only for now; promotion to public canonical surface requires a use case.
- **[OPEN] Date histograms / facet counts** in the canonical contract — defer until a client needs them; currently `_ref` only.
- **[DEFER] Aggregation tree** (Elasticsearch shape). Off-bar for SLVP.
- **[ANTI] Filter DSL** (OData/SQL-like). Hard to validate, hard to enforce projection on, hard to render in consent surfaces.
- **[ANTI] Per-surface drift** (MCP solving ambiguity differently from REST). Already a stated invariant.

### Promotion status

`canonicalize-public-read-contract` is active. SLVP fits inside it. The "open" items above (reverse-expand, recent feed, date histograms) should remain design-note material until a concrete consumer pins them.

---

## Topic 4 — Client event subscriptions / webhook-like channels

### Boundary

**Core-adjacent, RI-implementable.** The grant model and resource server are Core; the subscription protocol is a Core extension. The first tranche is reference-only per `add-client-event-subscriptions`.

### Findings (synthesized from `design-notes/client-event-subscriptions-and-freshness-2026-04-26.md`, `source-webhooks-and-event-driven-collection-2026-05-15.md`, the 2026-05-27 dispatched research below)

See companion file `slvp-client-event-subscriptions-prior-art-2026-05-27.md` for the per-platform deep dive (Stripe, Plaid, Google Workspace, Microsoft Graph, GitHub, MCP, WebSub/SSE/WebPush, CloudEvents).

Key cross-platform findings:

- **Hint-only is the safer default for personal data.** Stripe embeds objects; Google/Plaid/MS Graph default to hint + fetch. Personal data is grant-projected; embedding bypasses the projection enforcement that lives in the RS query path. PDPP should hint first.
- **Subscription audience binding** uses the same authentication primitive as record reads. Google validates via Pub/Sub IAM; MS Graph uses the subscription's client; Stripe signs with a per-endpoint secret. PDPP's equivalent: the grant-scoped client token *authorizes* subscription creation; payload delivery is signed independently with a per-subscription HMAC key.
- **Expiry + renewal** is universal (Google `expiration`, MS Graph `expirationDateTime`, push-subscription resigning). PDPP subscriptions should have explicit `expires_at` tied to grant expiry, and renewal that re-checks grant validity.
- **Lifecycle events** matter: MS Graph emits `Microsoft.Graph.subscriptionRemoved` and `Microsoft.Graph.missed`. PDPP needs `grant.revoked` and `freshness.changed`.
- **Retry ladders** converge on exponential backoff with a few hours of attempts, then dead-letter or notify (Stripe 3 days, MS Graph up to 4h). Idempotency via event id is universal.
- **CloudEvents envelope** (https://cloudevents.io/, accessed 2026-05-27) is a vendor-neutral shape that costs nothing to adopt and pays back when bridging into Knative/AWS EventBridge/Azure EventGrid.

### SLVP direction

- **[SLVP] First tranche is hint-only**, grant-scoped, projection-safe. Payload contains `(event_type, subscription_id, grant_id, stream?, since_cursor?, occurred_at, event_id)`. Client fetches records with `changes_since`.
- **[SLVP] Event types in v0.1**: `records.changed`, `grant.revoked`, `subscription.expiring`, `freshness.changed`. No connector-specific events.
- **[SLVP] Delivery**: webhook POST to a client-registered URL is the canonical transport. SSE/WebSocket are optional second tranche; MCP `notifications/resources/updated` is a separate carrier (in-process subscription, not durable).
- **[SLVP] Signing**: HMAC-SHA256 with a per-subscription secret returned at creation time; `X-PDPP-Signature: t=<ts>,v1=<hmac>`; replay window 5 minutes. Mirrors Stripe but with one twist: PDPP also includes `audience` in the signed payload (the subscription URL) to prevent cross-subscription replay.
- **[SLVP] Idempotency**: every event has an `event_id` (UUID + monotonic sequence). Clients dedupe on `event_id`. Server retains the id for re-delivery for the retention window.
- **[SLVP] Retry ladder**: exponential backoff up to 24h, then dead-letter. Owner sees dead-lettered events in the dashboard.
- **[SLVP] Subscription lifecycle**: created (with grant binding), active, expiring-soon (event), expired, revoked (event), failed (after threshold of consecutive failures — the Sidekiq/Fivetran shape).
- **[SLVP] CloudEvents envelope** for the outer JSON shape; this costs nothing and earns interop. Concretely: `specversion: "1.0"`, `id`, `source: <RS URL>`, `type: "org.pdpp.records.changed"`, `time`, `datacontenttype: "application/json"`, `data: { ... }`.
- **[OPEN] Client-triggered refresh** (the `request refresh` affordance in the existing design note). Recommend: typed best-effort endpoint that returns `queued | already_fresh | needs_owner_attention | unsupported`; never guarantees fresher data.
- **[OPEN] Freshness inspection endpoint** — `/v1/streams/{name}/freshness` returns `last_observed_at`, `last_collected_at`, `next_attempt_at` (informational), and an honest "no upstream API; depends on owner attention" flag.
- **[DEFER] Embedded payloads** — only when a client + connector both prove they want it and grant projection can be enforced cheaply.
- **[DEFER] Subscription-creation through agent / DCR** — for SLVP, the existing scoped-grant flow plus an explicit subscription-create call is enough.
- **[ANTI] Reusing owner tokens, client grant tokens, or device-collector credentials** for subscription signing — already named in `source-webhooks-and-event-driven-collection-2026-05-15.md`.
- **[ANTI] Inventing a separate scope vocabulary for subscriptions** — subscription authority *is* the existing grant.
- **[ANTI] Treating "no events for stream X" as silence vs as "stream not subscribable"**. Capability discovery must say which streams emit events.

### Promotion status

`add-client-event-subscriptions` is the active OpenSpec change covering tranche 1. The freshness-inspection and client-triggered-refresh items remain design-note candidates until evidence arrives. No new OpenSpec change recommended now; promote the freshness endpoint via a follow-on change when a consumer asks.

---

## Topic 5 — Connection / account / device management UX

### Boundary

**RI-owned.** The Core spec has no opinion on multi-account UX. The Collection Profile gains `connection_id` only as a normative term (already the direction of `define-connector-instances`).

### Findings (synthesized from `connection-first-collection-identity-2026-05-18.md`, `source-instances-and-multi-account-configurations-2026-04-24.md`, plus the 2026-05-27 dispatched research)

See companion file `slvp-connection-and-device-ux-prior-art-2026-05-27.md` for the per-product deep dive (Plaid, Fivetran, Airbyte, Slack, GitHub, 1Password, Tailscale, Syncthing, Dropbox, Google).

Cross-product consensus (each URL accessed 2026-05-27):

- **Auto-label + rename, never lose the system identifier.** Plaid recommends app-side nickname layered over `institution.name + account.mask`. https://plaid.com/docs/link/duplicate-items/
- **Schedules attach to the connection**, not the connector type. Universal at Fivetran/Airbyte/Hevo/Stitch. https://fivetran.com/docs/core-concepts/syncoverview, https://docs.airbyte.com/platform/using-airbyte/core-concepts/sync-schedules
- **Remove ≠ Delete data.** Plaid `/item/remove`, Fivetran delete, Airbyte delete, Dropbox unlink, Tailscale device removal — all retain destination data. Only Airbyte's explicitly-renamed "Clear" wipes records; it carries a heavy confirmation.
- **Device key expiry + tagged exemptions** (Tailscale shape, 180d default, exempt servers). Useful for local exporters that should not silently lapse.
- **Persistent identifier for dedupe** (Plaid `persistent_account_id`). The same Item re-linked must dedupe.
- **Webhook on revocation upstream** (Plaid `USER_ACCOUNT_REVOKED`) propagates retirement to consumers.

### SLVP direction

- **[SLVP] Connection is the owner-facing primary noun.** `connection_id` is canonical public identity; `connector_instance_id` is internal; `connector_id` is connector type. Already aligned with `define-connector-instances` and `canonicalize-public-read-contract`.
- **[SLVP] Auto-label + rename + show system label.** Auto-label is `<connector_display_name> · <account_handle> · <optional_suffix>`. Owner-set label appears primary; auto-label appears as subtitle.
- **[SLVP] Three explicit verbs on connection menu**: `Pause`, `Retire` (revoke binding; keep records), `Delete Records…` (typed-confirmation destructive flow, separate from retire). No conflated "Delete connection".
- **[SLVP] Six-state setup machine**: `draft` → `ready` → `paused` ↔ `error` → `needs_reconnect` → `retired`. Maps cleanly to Plaid `ITEM_LOGIN_REQUIRED`, Fivetran auto-pause, Stripe restricted/disabled.
- **[SLVP] Schedules are per-connection** with `{ mode: "interval" | "manual", value, paused }`. Cron is `[DEFER]`.
- **[SLVP] Devices and exporters as bindings under a connection.** Per `connection-first-collection-identity-2026-05-18`. A binding becomes a first-class object only when it earns independent lifecycle/authority/schedules/health/grants/storage.
- **[SLVP] Persistent dedupe key**: hash of `(connector_id, account_subject, exporter_kind)` so a re-linked account does not spawn a duplicate connection.
- **[SLVP] Device key expiry + tagged exemptions**. Local collectors enrolled as "exporter" devices get a default 90d key window; "service-class" devices can opt out.
- **[SLVP] Last-seen + version surfaces** on connection detail panel for each device binding.
- **[SLVP] Retiring a connection emits an internal event** (and a client event, per Topic 4): `connection.retired`. Records remain queryable under the retired connection's `connection_id`.
- **[OPEN] Multi-tenant / multi-owner switcher UX** (Slack/GitHub icon stack) — recommended pattern *if* PDPP ever needs multi-owner instances. Currently single-owner; defer.
- **[OPEN] Built-in seed connection** (1Password "Personal" vault pattern) — useful if PDPP ships a self/local connection at install. Owner call.
- **[OPEN] `draft` vs first-run validation** — Airbyte uses `sync_on_create:false`; Plaid validates inside Link. Recommend `draft` with a "Run now" CTA that does the validation.
- **[DEFER] Account picker / "use existing OAuth account" reuse across connections** — useful for multi-Gmail scenarios; defer until the connection model is settled.
- **[ANTI] No-rename-after-create** (Fivetran's well-known pain). Renaming must be free.
- **[ANTI] Conflating "Delete" verb** with "Clear records" — Airbyte explicitly renamed for this reason.
- **[ANTI] `device` as a first-class peer of `connection`** in the public model. Devices are binding-shaped under a connection. Already named in `connection-first-collection-identity-2026-05-18`.

### Promotion status

`define-connector-instances` is the umbrella OpenSpec change; SLVP work fits inside it. Some specifics (key-expiry policy, persistent dedupe identifier, retire vs delete-records UX) are still design-note candidates; promote into `define-connector-instances` only if they earn durability — they probably will.

---

## Topic 6 — Remote-browser / surface substrate OSS posture

### Boundary

**RI-owned.** Browser automation is a polyfill per `voice-and-framing.md`; the `@opendatalabs/remote-surface` package is reference infrastructure that happens to be usable by non-PDPP consumers.

### Findings (synthesized from `make-remote-surface-oss-publishable`, `republish-remote-surface-as-opendatalabs`, `browser-binding-launch-direction-2026-05-18.md`, and the 2026-05-27 dispatched research)

See companion file `slvp-remote-surface-oss-posture-prior-art-2026-05-27.md` for the per-project deep dive (n.eko, Kasm, Selkies, noVNC/Guacamole, browserless, Browser-Use Cloud, Playwright, Patchright).

Cross-project consensus (each URL accessed 2026-05-27):

- **n.eko** (Apache-2.0) explicitly is *not* a multi-tenant production service — it's a single-room reference. https://github.com/m1k1o/neko. PDPP can vendor its protocol/adapter cleanly without inheriting product semantics.
- **Selkies-GStreamer** is MPL-2.0, which is downstream-permissive if PDPP keeps Selkies code in its own files. https://github.com/selkies-project/selkies
- **Kasm CE / Workspaces** is dual-licensed and not modular enough to extract just the substrate.
- **Playwright** (Apache-2.0) demonstrates the right boundary: protocol-level surface, no opinion on auth or product. Patchright fork shows the cost of stealth opinions.
- **Browserless / Stagehand / Anthropic Computer Use cloud** demonstrate the *anti*-shape for a generic OSS package: SDKs assume hosted runtime, billing, session lifetime, captcha-solving partners — none of which belong in a substrate.

### SLVP direction

All consistent with `republish-remote-surface-as-opendatalabs`:

- **[SLVP] `@opendatalabs/remote-surface` is Apache-2.0**, `LICENSE` ships in tarball.
- **[SLVP] Default `exports` are host-neutral** (geometry, pointer, IME, clipboard policy, CDP/n.eko adapters, leases, diagnostics, testing). PDPP-shaped concepts (`_ref`, `run_id`, `interaction_id`) live under `./reference`.
- **[SLVP] Validator restricts reference-token allowlist to `dist/reference/**`.**
- **[SLVP] Engines `>=24`** (2026 LTS). `publishConfig.access = public`. `publishConfig.provenance` opt-in.
- **[SLVP] No multi-tenant safety claim** in README. The package explicitly punts isolation to the host (matches n.eko, Playwright, browserless).
- **[SLVP] No hosted-runtime assumptions.** No billing, no session lifetime opinions, no captcha integration. Reference (`./reference`) may add PDPP run/interaction semantics, but the substrate must not.
- **[SLVP] Stable protocol-level public API**, semver-respected, with a deprecation horizon for `./server` re-exports captured *before* the first npm publish (release-management decision, non-blocking for SLVP).
- **[SLVP] CI publication checks** — tarball hygiene, type declarations, dependency-graph boundary, allowlist enforcement.
- **[OPEN] Browser launch direction.** Per `browser-binding-launch-direction-2026-05-18.md`, the spec has `browser_automation` (runtime-provided CDP) but the RI uses connector-self-launched. Recommend: keep both, document `browser_self_launch` as a separate binding/capability before the rename ships; do not silently absorb the mismatch.
- **[OPEN] LICENSE copyright line** — deferred until first public publish per `republish-remote-surface-as-opendatalabs` proposal.
- **[OPEN] Telemetry / opt-in diagnostics** — n.eko has none; browserless does. Recommend zero default telemetry; allow embedding host to add its own.
- **[DEFER] Hosted reference at `remote-surface.opendatalabs.org`** or similar — not SLVP scope. The package alone is the product.
- **[DEFER] Multi-room / orchestration substrate** (Kasm/Selkies territory). PDPP needs single-surface leases; orchestration is the host's problem.
- **[ANTI] PDPP-internal types leaking into the default export.** Already named in `make-remote-surface-oss-publishable` and `republish-remote-surface-as-opendatalabs`.
- **[ANTI] AGPL** for the substrate — would deter downstream commercial embedding. Apache-2.0 is correct.
- **[ANTI] Optional-peer-dep tricks** that hide non-trivial runtime requirements; declare deps explicitly.

### Promotion status

Covered by `make-remote-surface-oss-publishable` and `republish-remote-surface-as-opendatalabs`. The only design-note candidate is **`browser_self_launch` binding vocabulary**; per `browser-binding-launch-direction-2026-05-18.md` this should be promoted before any manifest binding vocabulary change. Proposed OpenSpec name: `add-browser-self-launch-binding-vocabulary` (do not create now — design-note only until owner accepts).

---

## Cross-topic invariants

A few invariants the SLVP work must not violate, surfaced repeatedly across all six topics:

1. **`connection_id` is the durable owner-facing identity** — for records, schedules, attention, subscriptions, devices, retained-size aggregates, search hits, MCP outputs.
2. **Capability discovery is one document**: `/v1/schema`. Read API, search, expansion, counts, filterable/sortable fields, subscribable events, granted connections. No per-surface re-derivation.
3. **Non-fatal lossiness is `meta.warnings`**, not silence. Approximate counts, downgraded modes, deprecated aliases, missing capability — all warn.
4. **Honest progress > false green.** Runs can finish `succeeded_with_gaps`. Connections can be `error` with old data still queryable. Aggregates can be stale and must say so.
5. **Hint-only > embedded payload** for personal-data event delivery, until proven otherwise.
6. **Polyfill framing for browser automation** — never the headline; `./reference` subpath; `browser_self_launch` semantics surfaced honestly.
7. **Retire ≠ Delete records** — three verbs, never collapsed.

These invariants belong in the spec/spec-collection-profile/RI architecture documents (likely the latter for #1, #2, #3, #4, #7; spec-core for #5; voice-and-framing already covers #6). They are not new — this note compiles them.

---

## What would benefit from a worker-lane dispatch next

Owner-only decisions blocking nothing immediately, but worth pinning:

1. **Auto-pause threshold default** (Topic 1). Fivetran ships 14 days; PDPP could be more conservative (7) or per-connector. Worker can survey, but the default is an owner call.
2. **Date-histogram + facet exposure in the canonical contract** (Topics 2, 3). Worker can survey demand from MCP/agent usage; owner decides whether to promote.
3. **CloudEvents envelope vs PDPP-native envelope** (Topic 4). Worker can pilot a small CloudEvents-shaped payload against the existing subscription tranche; owner decides whether to adopt.
4. **Persistent connection dedupe identifier** (Topic 5). Worker can draft a `connection_persistent_id` scheme; owner accepts shape.
5. **`browser_self_launch` binding vocabulary** (Topic 6). Worker can draft an OpenSpec change for review; do not create without owner approval.
6. **Reverse-expand capability discovery** (Topic 3). Worker can survey agent demand; owner decides scope and shape.

Dispatch-friendly worker lanes:

- **Lane A — Canonical read contract conformance harness extensions**: add tests for graded counts, warning surface, and identity invariance under `canonicalize-public-read-contract`.
- **Lane B — Attention task lifecycle implementation**: ship the open/acknowledged/snoozed/resolved/superseded/expired state model under `define-schedule-manual-attention-policy`.
- **Lane C — Records explorer canonical envelope consumption**: simplify the existing dashboard explorer post-attribution once search hits carry `connection_id` directly.
- **Lane D — Subscription tranche 1 implementation**: ship the hint-only webhook delivery + HMAC signing + idempotency dedup under `add-client-event-subscriptions`.
- **Lane E — Remote-surface republication**: execute the rename + subpath split + license posture under `republish-remote-surface-as-opendatalabs`.

None of these require new OpenSpec changes. They execute the active ones.

---

## Decision log

- 2026-05-27: Synthesis written by RI prior-art right-hand. Six topics mapped against existing prior-art notes and OpenSpec changes; deep-dives dispatched for client event subscriptions, connection/device UX, and remote-surface OSS posture. Companion notes saved alongside this file.
