# Owner Console Prior-Art: Operator-Persona Gaps

Date: 2026-07-09
Status: Gap-fill research (not a re-derivation of the 2026-06-18 corpus)
Scope: Fills four archetype gaps in the owner-console SLVP prior-art corpus that the
Stripe/Datadog/Plaid-heavy pass under-covered: (A) personal/home-server operator
consoles, (B) long-running sync progress + schedule pause/resume, (C) reconnect vs
credential-update routing, (D) status semantics that avoid "misleading green."

Cross-links into the existing corpus (read these first, do not re-derive):

- `docs/research/owner-console-slvp-prior-art-index-2026-06-18.md` — master index.
- `docs/research/owner-console-recovery-and-liveness-prior-art-2026-06-18.md` — Sentry/Temporal
  recovery-surface archetype (one cause, one closing action, progress, terminal reconciliation).
  This doc's §B/§C extend that pattern to *routing* (which affordance fires) and to
  *long-running* operations, which the recovery doc treats as already-scoped single actions.
- `docs/research/owner-console-source-inventory-and-detail-prior-art-2026-06-18.md` — health/
  freshness/coverage/schedule per source. This doc's §D supplies the status-hierarchy theory
  that inventory page was implicitly assuming but never sourced.
- `docs/research/connector-credential-session-repair-prior-art-2026-07-01.md` — PDPP's own
  credential/session repair design. This doc's §C is prior art that should have informed it;
  read together.
- `docs/research/owner-console-add-data-connector-setup-prior-art-2026-06-18.md` — setup/catalog
  (Stripe/Plaid/GitHub). This doc's §A is the missing "steady state after setup" companion —
  setup doc covers onboarding, this covers ongoing operation.

None of the six home-server/operator products in §A, the sync-progress semantics in §B, the
reconnect-routing patterns in §C, or the status-hierarchy anti-pattern in §D appear anywhere in
the existing corpus. This is genuinely new ground.

---

## A. Personal/home-server operator consoles

The closest persona match to a PDPP owner (self-hosted, single operator, wants "is my system OK"
without reading logs) is under-represented in a Stripe/Datadog-anchored corpus. Five products
checked; two (Home Assistant, Tailscale) have deep, well-documented answers; three (Start9,
Umbrel, Synology) are thinner in public docs but still transferable.

### Home Assistant: Repairs + System Health (strongest match)

- Sources: `home-assistant.io/integrations/repairs/`, `home-assistant.io/integrations/system_health/`,
  `developers.home-assistant.io/docs/core/integration/system_health/`, HA community thread on
  cascading RAG dashboards (`community.home-assistant.io/t/has-anyone-made-a-system-health-dashboard-with-cascading-red-amber-green-statuses/1011065`). Accessed 2026-07-09.
- Pattern: HA splits "is my system OK" into **two separate, differently-shaped surfaces** rather
  than one health page:
  1. **Repairs** (Settings > System > Repairs) — a queue of *actionable* issues Home Assistant
     itself detected that need owner intervention (deprecated integration, config error, device
     needs manual action, a reauth/reconfigure flow pending). Each item either offers a direct
     in-dashboard fix or explicit instructions. The sidebar shows an unread-style count badge on
     "Settings," exactly like the update-count badge — repairs are visually equated with pending
     updates, both "things that want you," not just "things that are broken."
  2. **System Health** — a developer-extensible reporting API where each integration contributes
     a dict of facts (server reachable, request quota remaining, version, connected endpoint).
     Critically, entries can be coroutines: "the frontend will display a waiting indicator and
     will automatically update once the coroutine finishes and provides a result." This means the
     UI has a first-class *loading* state for "we're checking right now," distinct from both
     "healthy" and "unhealthy" — it does not force a premature verdict while the check is in
     flight.
  - The community thread shows real owners independently converging on wanting a **cascading
    Red/Amber/Green rollup** across sub-statuses (HA core, individual devices, backup status,
    update status) — i.e., operators want an aggregate that is provably derived from real child
    states, not a single hand-set flag. This is grassroots evidence for hierarchical status
    (see §D) mattering even at hobbyist scale, not just SaaS-vendor scale.
  - HA does NOT conflate "integration is configured" with "integration is verified working" —
    system_health's reachability checks exist specifically to prove the second, separately from
    the first. This is the same distinction PDPP's source model needs (configured connector ≠
    connector that authenticated ≠ connector with fresh data — see §D).

**Transferable contract for PDPP:**
- Split "needs your attention" (owner-actionable queue, badge-counted like updates) from "system
  facts" (health snapshot, includes async/loading states) as two distinct surfaces, not one
  merged health page — mirrors PDPP's existing Source vs Recovery split but validates it against
  an independent product.
- Every "system fact" that requires a live check (can we reach the provider, is the token still
  valid) needs an explicit **checking-in-progress** UI state, not just healthy/unhealthy — resist
  going straight from "unknown" to a guessed verdict.
- A repairs-style queue should read like a to-do list (one line, one action) — not a diagnostic
  table.

### Tailscale admin console: machine status, key expiry, health checks

- Sources: `tailscale.com/docs/features/access-control/device-management/how-to/filter`,
  Tailscale changelog entries on health-check warnings (IP forwarding, DNS, firewall marking),
  `home-assistant.io/integrations/tailscale/` (documents the exposed entity model). Accessed
  2026-07-09.
- Pattern: Tailscale separates three *independent, differently-timed* facts about a device that a
  naive "online/offline" toggle would collapse:
  1. **Last seen** — a timestamp-based liveness signal (there is deliberately no boolean "online"
     sensor; the HA integration docs note explicitly that consumers must derive online/offline
     from the last-seen timestamp themselves, because point-in-time connectivity is too noisy to
     assert as a single fact).
  2. **Key expiry** — a wholly separate lifecycle clock (device auth key), with its own filter
     (`expired`, `expiry disabled`) independent of whether the device is currently connected. A
     device can be "seen 2 minutes ago" and simultaneously "key expires in 3 days" — two clocks,
     two owner actions, never merged into one flag.
  3. **Health checks** (2025-2026 rollout) — configuration-correctness warnings (misconfigured
     subnet router, DNS conflicts, reverse-path-filter drops) that are neither about liveness nor
     about key expiry — they are "this device is reachable and its credentials are fine, but
     something about how it's configured will bite you." Tailscale's own changelog treats these
     as a third, additive layer, not a modifier of the connectivity status.
  - A live GitHub feature request (`tailscale/tailscale#18188`) shows users explicitly asking for
    a fourth layer — service-level health checks so a *node* being "Online" doesn't imply the
    *service running on it* is actually serving traffic — i.e., users want the same
    configured/reachable/serving distinction HA draws, and complain when a product doesn't offer
    it.

**Transferable contract for PDPP:**
- Do not compress "connector is configured," "credential still valid (has an expiry clock of its
  own)," and "data is actually fresh" into one boolean. Model them as separate clocks/facts the
  way Tailscale models last-seen vs key-expiry vs health-check — this is very close to PDPP's
  actual source-health shape (source configured / credential live / run recently succeeded / data
  fresh) and gives independent primary-source backing for keeping those four facts visually and
  semantically distinct rather than rolling them into a single status pill.
- "Last seen" (a timestamp) is a more honest liveness signal than a boolean online/offline for
  anything with async, poll-based checking — PDPP's source liveness should prefer "last verified
  working: 4 minutes ago" phrasing over a binary green dot wherever the underlying check is
  periodic rather than a persistent connection.

### Start9 StartOS: service dashboard states + Health Checks + Dependencies

- Sources: `docs.start9.com` Managing Services and Dashboard Overview pages, `start9.com/faq`.
  Accessed 2026-07-09. (Public docs are thinner than HA/Tailscale; treat as directional, not
  exhaustively verified against the live 2026 UI.)
- Pattern: a small, explicit state machine for each installed service — **Needs Config / Starting
  / Running / Stopping / Stopped** — plus two additive layers:
  1. **Health Checks**, packager-authored, whose job is explicitly described as conveying "what is
     happening with their service, as well as possible actions they may want to take" — i.e.,
     health checks are required to carry a *next action*, not just a verdict.
  2. **Dependencies**, which tells the owner when a service's own health is gated on a *different*
     service being correctly configured — an explicit dependency-graph disclosure rather than a
     opaque "degraded" on the dependent service alone.
  - The always-visible connectivity indicator (bottom-left corner: connected/not-connected to the
    server itself) is kept separate from any individual service's status — the transport-layer
    fact and the application-layer fact are never merged.

**Transferable contract for PDPP:**
- Every health-check-style status PDPP surfaces should be required to carry a next action, not
  just a color — StartOS makes this a packaging *requirement*, not a nice-to-have.
  Recovery-and-liveness doc (2026-06-18) already argues one-cause/one-action; StartOS is
  independent corroboration that this should be enforced as an authoring rule, not left to
  discretion per surface.
  - Where one source's health is downstream of another PDPP subsystem (e.g., a stream depends on
    a source's credential, or an aggregate depends on multiple upstream connectors), disclose the
    dependency explicitly rather than showing an unexplained "degraded."

### Umbrel and Synology DSM (thin public evidence — noted, not load-bearing)

- Umbrel: public docs/community threads mostly surface known bugs (status desync between actual
  container state and dashboard "Not Running" label after manual intervention) rather than a
  documented design philosophy. The one clear signal: Umbrel's own app-store ecosystem includes a
  third-party container-management app (Arcane) explicitly positioned as making container
  management "feel more like a well-crafted development environment than an administrative
  dashboard" — i.e., even within the Umbrel ecosystem, the built-in app-status surface is
  perceived as not enough, and richer tools get built on top. Weak signal, not a pattern to copy.
- Synology DSM: not independently re-searched in depth this pass (time-boxed); the existing
  HA-community thread references a "Synology System Health widget" being pulled into HA
  dashboards, suggesting DSM's own health page is granular enough to be worth exporting facts
  from, but no primary DSM source was fetched. Flag as an open follow-up if a future pass wants
  it; do not cite DSM specifics from this document.

---

## B. Long-running sync progress + schedule pause/resume

### Airbyte Cloud connection status page

- Source: `docs.airbyte.com/cloud/managing-airbyte-cloud/review-connection-status`,
  `docs.airbyte.com/platform/using-airbyte/core-concepts/sync-schedules`, Airbyte engineering
  blog "How Airbyte 1.0 Monitors Sync Progress and Solves OOM Failures." Accessed 2026-07-09.
- Pattern: each connection has a persistent Status tab showing current status, next-scheduled-sync
  time, and historic sync trend — plus, added specifically to fix a UX gap, **10-second-polled
  real-time progress**: for a live sync, each stream shows how much data has been extracted and
  loaded, how long it's been actively syncing, and how long since data was last loaded. This
  answers three separate owner questions a single spinner cannot: "is it actually moving," "how
  long has this taken," and "has it stalled." Stalled-vs-slow is the actual failure mode a bare
  progress bar can't distinguish, and Airbyte's design explicitly targets it.
  - Rate-limit handling is a first-class UI state, not folded into "syncing": when the source
    itself is throttling, the UI shows an estimated time until the API is available again, with a
    countdown when known. This is a *third* state beyond running/stalled: "we are waiting on an
    external limit, not broken, and here's when it should resume."
  - Two different "Queued" meanings are explicitly kept apart at different granularity: a
    stream-level Queued (waiting within an already-running sync) vs a connection-level Queued
    (the whole job waiting for worker capacity) — collapsing these into one word would mislead the
    owner about what to expect next.
  - Only one sync per connection runs at a time; a newer scheduled run pending against an older
    queued one **replaces** it, so the owner only ever waits on the freshest request, not a stale
    queue.

### Fivetran: paused semantics + historical resync progress

- Source: `fivetran.com/docs/getting-started/fivetran-dashboard/connectors/status`,
  `fivetran.com/docs/connectors/troubleshooting/trigger-historical-re-syncs`, REST API resync
  reference. Accessed 2026-07-09.
- Pattern: Fivetran's `sync_state` field has four values — `scheduled`, `syncing`, `paused`,
  `rescheduled` (rescheduled = "waiting until more API calls are available in the source service,"
  i.e., a named state for exactly the throttled case, distinct from paused-by-owner). Notably,
  **Fivetran does not expose a single percent-complete number for historical resyncs** — instead
  it shows "date fetched up to" vs "total days of history available" plus a running extracted-row
  count. This is a deliberate choice: a percentage implies a denominator the system may not
  actually know in advance (total volume can be unknown or change mid-sync), so Fivetran prefers
  an honest, partial, but truthful progress signal (date-cursor position) over a smooth-looking
  but potentially-fabricated percentage.
  - Pausing has explicit, load-bearing semantics for in-flight requests: "if the connection is
    paused, the historical sync flag is set but the sync doesn't start until the connection is
    unpaused" — a resync request against a paused connector is accepted and queued, not silently
    dropped or errored, and this is documented behavior an owner can rely on.
  - Paused + in-flight interaction is explicit: if a sync is already running when a pause request
    comes in, Fivetran tries to let it finish; only if that fails does the pause request get
    rejected (409). The owner-visible contract is "pausing never corrupts an in-flight sync."

### Plaid update mode + Bank of America 2026 forced-migration case study

- Source: `plaid.com/docs/link/update-mode/`, `plaid.com/docs/errors/item/`. Accessed 2026-07-09.
- Pattern (most relevant to §C but included here for the "claims vs reality" angle): Plaid
  explicitly ties long-running/scheduled disruption to a *proactive webhook*
  (`PENDING_DISCONNECT`) fired **before** the item breaks, with a stated grace window ("one week
  after the webhook fires... if the item hasn't gone through update mode, it will be disconnected
  and enter ITEM_LOGIN_REQUIRED"). This is a pattern for "a scheduled sync-breaking change is
  coming" that gives the owner a deadline and a single fix action ahead of failure, rather than
  waiting for the break to notify.

**Transferable contract for PDPP (§B):**
- A running sync/backfill needs at minimum three owner-visible facts, not one spinner: (1) is data
  currently moving (throughput/last-progress timestamp), (2) how far through is it (progress
  cursor — prefer an honest partial signal like "processed through 2024-03" over a fabricated
  percentage when total volume is uncertain), (3) is it blocked on something external (rate limit,
  with an ETA if known) vs actually stalled.
- Distinguish **connection-level** queued/paused from **stream/table-level** queued/paused in
  copy — do not use the same word for both if the owner-facing implication differs.
- "Paused" needs a documented contract for what happens to in-flight and queued work (does a
  resync request survive a pause? does an in-flight run get allowed to finish?) — PDPP's run/sync
  model should state this explicitly rather than leave it implicit, following Fivetran's
  documented pause-interaction rules.
- Where a scheduled disruption is foreseeable (token/session about to lapse, a provider-side
  migration), prefer proactively surfacing a deadline+single action (Plaid's `PENDING_DISCONNECT`
  pattern) over waiting for the failure state.

---

## C. Reconnect vs credential-update UX

This is the routing question: how do systems decide which single affordance to show an owner when
something in a connection has gone wrong, given multiple different underlying causes (session
expired, password changed, bank blocking, new consent required)?

### Plaid: severity-graded update mode, one entry point for many causes

- Source: `plaid.com/docs/link/update-mode/`, `plaid.com/docs/errors/item/`. Accessed 2026-07-09.
- Pattern: Plaid routes *all* of the following into the **same single UI affordance** (re-launch
  Link in update mode): expired login (`ITEM_LOGIN_REQUIRED`), pending forced disconnect
  (`PENDING_DISCONNECT`/`PENDING_EXPIRATION` webhooks), missing permissions the user didn't
  originally grant, and even a wholesale backend migration (the 2026 Bank of America API cutover).
  The owner never has to diagnose *why* — they get one button, and Plaid internally decides how
  much re-auth to demand:
  - For most institutions, update mode intentionally **minimizes the ask**: "if the Item entered
    an error state because the user's OTP token expired, the user may be prompted to provide
    another OTP token, but not to fully re-login." The severity of the underlying cause
    determines how much friction the single flow imposes, not which flow is shown.
  - Cross-app propagation is explicit: if the same bank login is used in multiple apps and gets
    repaired in one, Plaid fires `LOGIN_REPAIRED` to the others so they can auto-dismiss their own
    "needs attention" state rather than asking the owner to redundantly repair the same
    credential twice.

### GoCardless/Nordigen: EUA vs Requisition — the "refresh doesn't help" trap

- Source: `developer.gocardless.com/bank-account-data/statuses/`, service-terms PDF, and multiple
  independent developer bug reports (Firefly III, Actual Budget, opencollective) converging on the
  same failure. Accessed 2026-07-09.
- Pattern (a negative example worth citing): GoCardless separates a **Requisition** (the
  connection object) from an **End User Agreement** (a time-boxed consent grant, 90-180 days by
  region). Multiple independent open-source integrators hit the same bug: re-linking the account
  (making a new Requisition) silently reused the *old, already-expired* Agreement object, so the
  error persisted even after what looked like a full reconnect. The fix requires recreating the
  Agreement itself, not just the Requisition — but nothing in the UI/API surface tells the
  integrator (or, transitively, the owner) that two different objects need refreshing. The raw
  error is described by the developers themselves as "currently an obscure 401 error" surfaced
  with no actionable copy.
- This is the anti-pattern PDPP's own connector-credential-session-repair doc (2026-07-01) is
  presumably designed to avoid, but it's worth citing directly: **a "reconnect" affordance that
  refreshes the wrong underlying object (session, not consent-grant; token, not the account link
  itself) will look successful and then fail again**, and the owner has no way to know the retry
  didn't touch the actual broken thing.

### Monarch Money / Copilot Money: consumer bank-reconnect journeys

- Source: Monarch Money support content (via search aggregation), Copilot Money Help Center
  articles (`help.copilot.money`). Accessed 2026-07-09.
- Pattern: both apps converge independently on the same three design choices:
  1. A **persistent, named section** for broken connections ("Connections Needing Attention" /
     accounts sorted to the top of Settings > Connections) rather than a transient toast — the
     owner can return to it later without having caught the original notification.
  2. A **single lightweight action** ("Reverify" / "Sign in") that re-runs just the credential
     step, explicitly preserving all historical data — both apps state this guarantee directly in
     support copy, because the obvious owner fear is "will reconnecting wipe my history."
  3. An explicit **verification-after-action** contract: Monarch tells the owner exactly how to
     confirm the fix worked ("give it a few minutes... if the connection is healthy, the last sync
     time advances and new transactions appear; if nothing changes, the link still needs
     attention") — i.e., the product tells the owner what "did it actually work" looks like,
     rather than declaring success the moment the credential step completes.
  - Both explicitly warn against delete-and-recreate as a workaround, because it silently
    discards history — Copilot's help center states this as a direct recommendation against a
    common but destructive user instinct.
  - A named edge case both surface: if the underlying institution *username* changed (not just
    password), the lightweight reverify path cannot work and a genuinely new connection is
    required — this is disclosed as a boundary condition, not left to fail silently.

**Transferable contract for PDPP (§C):**
- Collapse "session expired," "password changed," "provider requires new consent," and "provider
  migrated backend" into **one owner-facing repair affordance**, with the system — not the owner —
  determining how much re-auth friction is actually required (Plaid's model). Do not make the
  owner pick between "reconnect" and "update credentials" as separate menu items if the underlying
  fix is the same flow with variable friction.
  - Before shipping any "reconnect"/"repair" action, verify it actually refreshes *every* object
    that can independently expire (session token AND consent grant AND stored credential) —
    GoCardless's Requisition/EUA split is a documented, still-recurring failure mode where a
    reconnect that only refreshes one object looks successful and silently isn't.
  - State explicitly, in-product, what "the fix worked" looks like (e.g., "last successful sync
    advanced, new records appearing") so the owner isn't left guessing whether a reverify actually
    took — this is the same "terminal reconciliation" idea from the recovery-and-liveness corpus
    doc, but applied specifically to the repair-verification moment, not just the fix action.
  - Explicitly guarantee (and say so) that reconnect/repair never discards history, and name the
    one real boundary case (identity-level credential change forces a genuinely new connection)
    rather than silently failing when it's hit.
  - When the same underlying credential/session serves multiple PDPP surfaces, propagate a repair
    across them (Plaid's `LOGIN_REPAIRED` cross-app pattern) rather than asking the owner to fix
    the same thing more than once if PDPP's own architecture ever has more than one consumer of a
    shared credential.

---

## D. Status semantics: avoiding "misleading green"

### GitHub's own postmortem: the canonical primary-source case study

- Source: GitHub's October 21 post-incident analysis (`github.blog/news-insights/company-news/oct21-post-incident-analysis/`)
  and the GitHub engineering blog on the redesigned status site
  (`github.blog/engineering/infrastructure/introducing-the-new-github-status-site/`). Accessed
  2026-07-09.
- GitHub's own words on the failure: during the October 21 incident, "many portions of GitHub were
  available throughout the incident" but the only available signals were "green, yellow, and red"
  — a single aggregate traffic light that could not represent a partial outage honestly. Their
  stated fix was structural, not cosmetic: split the single status into independently-tracked
  **components** (Git Operations, API Requests, Issues, Pull Requests, Actions, Pages,
  Codespaces), and explicitly **decouple component status from incident lifecycle** — "a
  component's degraded performance could be representative of a wider incident, but updating its
  status alone doesn't allow tracking mitigation steps." Component status is a snapshot fact;
  incident narrative (Identified → Investigating → Monitoring → Resolved) is a separate,
  time-ordered thread. Conflating the two was part of the original failure.

### Atlassian Statuspage: the cascade-rule model

- Source: `support.atlassian.com/statuspage/docs/top-level-status-and-incident-impact-calculations/`,
  `help.statuspage.io/knowledge_base/topics/using-components`. Accessed 2026-07-09.
- Pattern: the industry-standard four-state vocabulary (Operational / Degraded Performance /
  Partial Outage / Major Outage) is aggregated to a top-level status via an explicit **priority
  cascade** ("these rules are applied in an if/else structure, so lower-priority rules only apply
  if higher-priority conditions aren't met") — e.g., any component at Major Outage forces the
  top-level to "Partial System Outage" regardless of how many other components are green. This
  means the aggregate is a **provable function of the children**, not an independently-set flag —
  exactly the property the HA community thread (§A) was asking for by hand.
- Granularity guidance is explicit and numeric: 5-15 components is the cited workable range;
  beyond that, "cognitive load" from an N×M state matrix becomes the actual failure mode, not lack
  of detail. The advice is to group by **what a user depends on**, not by internal
  service-decomposition ("Website" as a parent with "Homepage/Product Pages/Checkout" children),
  and explicitly to choose components based on past incident/impact history, not org chart.
- A named best practice directly opposes minimalism-as-default: "status pages build trust by
  showing more, not less — this runs counter to the instinct most teams have, which is to
  minimize what's visible so the page looks clean and reassuring." This is a direct citation
  against the temptation to hide sub-states to keep a dashboard looking calm.

### Home Assistant / Tailscale (cross-reference from §A)

Already covered above — repeated here only to name the specific transferable principle: both
products keep **configured**, **verified-reachable-right-now**, and **freshness/last-seen** (or,
for HA, "async check still pending") as separate facts rather than folding them into one status
enum. This is the same shape as the GitHub/Statuspage lesson, but at the level of a single
resource's lifecycle rather than a whole system's component tree.

**Transferable contract for PDPP (§D):**
- Any owner-facing aggregate status (a source's overall health, a dashboard's "attention needed"
  count) must be a **derived, provable function of real child states** — never an independently
  settable flag that can drift from the facts underneath it. This is directly checkable: if the
  top-level status and the child statuses can disagree, the aggregation is wrong.
- Keep **status** (a point-in-time fact about a component) and **incident/repair narrative** (a
  time-ordered story with its own lifecycle) as two different data models, per GitHub's stated
  lesson — do not let "the last thing we said about this" double as "the current state."
- Cap owner-facing status granularity to what maps to real owner decisions (roughly GitHub's 7
  components, Statuspage's 5-15 guideline) — grouped by what the owner depends on (a source, a
  stream) not by internal subsystem boundaries, and prefer showing a true partial/degraded state
  over collapsing it to green for calm.
- Never merge "configured" with "verified working" with "data is fresh" into a single pill — keep
  them as separate, independently-truthful facts (HA/Tailscale pattern), and give each an honest
  loading/pending state rather than forcing an early green/red guess while a check is still async.

---

## Summary of new transferable contracts (all sections)

1. Split "needs your attention" (actionable queue) from "system facts" (health snapshot with
   explicit loading states) as two surfaces, not one merged page.
2. Never collapse configured / credential-valid / data-fresh into one status boolean — model as
   independent clocks (HA, Tailscale).
3. Every health-check-style status must carry a next action, not just a color (StartOS).
4. Long-running syncs need three signals — moving/stalled, honest progress cursor, external-block
   with ETA — not a single spinner or a possibly-fabricated percentage (Airbyte, Fivetran).
5. Document what "paused" means for in-flight and queued work; don't leave it implicit (Fivetran).
6. Collapse all reconnect causes into one owner affordance with system-determined friction, not an
   owner-facing menu of causes (Plaid update mode).
7. Verify a "reconnect" action refreshes every object that can independently expire — a partial
   refresh that looks successful is a documented, recurring failure mode (GoCardless EUA trap).
8. State explicitly what "the fix worked" looks like, and guarantee (in-product) that repair never
   discards history (Monarch/Copilot).
9. Any aggregate status must be a provable function of real child states, never independently
   settable — and status (snapshot) must stay a separate model from incident narrative (timeline)
   (GitHub's own postmortem).
10. Prefer showing true partial/degraded detail over hiding it for a calmer-looking page — this is
    stated industry best practice, not merely a plausible inference.
