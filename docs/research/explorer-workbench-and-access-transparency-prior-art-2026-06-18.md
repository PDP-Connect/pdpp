# Explorer Workbench + Client-Access Transparency — Prior Art

Date: 2026-06-18
Owner: RI owner
Status: Net-new prior-art research filling two gaps not covered by the existing PDPP
research corpus, in support of `docs/inbox/owner-feedback-2026-06-18.md` and the
decisions memo `tmp/workstreams/feedback-priorart-decisions-20260618.md`.

## Why this note exists

The existing repo research already covers control-plane organizing objects
(`control-plane-prior-art.md`), trace/timeline surfaces (`trace-surface-patterns.md`),
reference-implementation packaging (`reference-implementation-ux-prior-art.md`),
the Sources SLVP redesign (`sources-slvp-redesign-and-data-health-2026-06-11.md`),
connector self-service setup (`slvp-ideal-connector-self-service-setup-2026-06-14.md`),
and record-relationship navigation (`record-relationship-navigation-prior-art-2026-06-04.md`).

Two of the six decision areas in the owner's 2026-06-18 walkthrough were **not** deeply
covered by that corpus, so this note adds them:

1. **The record/data explorer as a workbench** — faceted filtering, search syntax +
   autocomplete, time-histogram-as-filter, jump-to-record-by-id, pagination vs hard
   caps, URL-shareable query state. The owner explicitly asked "what prior art research says
   about using both [the stream-detail table and Explore] versus making one really
   good view," and complained that the old time-series chart was removed for
   performance and that results are silently capped.
2. **Client/app access transparency** — how leading products show *which apps have
   access to my data*, *what each app can read*, and *what each app actually
   accessed*. The owner could not answer "what does ChatGPT have access to?" or
   "what did ChatGPT read?" from the current grants/traces surfaces.

## Part 1 — Data explorer / record workbench prior art

### Datadog Log Explorer

Source: <https://docs.datadoghq.com/logs/explorer/> (retrieved 2026-06-18)

The Datadog Log Explorer is the canonical "search a large event/record set"
workbench and the product the owner himself named ("Datadog SLO/SLI is better"). Its
durable layout pattern:

- **One search query bar** with a structured query syntax and **autocomplete** that
  suggests facet keys and values as you type — not a bare text box. The query string
  is the single source of truth for the current view.
- **A facet panel** (left rail) listing the indexed dimensions (source, status,
  service, etc.) with counts; clicking a facet value **adds a filter to the query**
  rather than navigating away. Facets are multi-select.
- **A timeseries histogram** above the result list showing volume over the selected
  time range. The histogram **is itself a filter**: dragging a region on it narrows
  the time window. This is exactly the "interactive chart that can be used to filter"
  that the owner said PDPP removed and should not have.
- **A list/table view** of results with selectable columns; clicking a row opens a
  **side panel** with the full event and a raw/JSON face — the result list and the
  detail share one surface, no context switch.
- **A time-range selector** that is distinct from, and composes with, the query (e.g.
  "Past 15 Minutes" / custom range). Shortcuts and custom ranges live in **one
  control**, not two parallel ones.
- **Saved Views** persist a query + time range + columns; the view is URL-addressable
  so it can be shared and reopened.

Takeaways for PDPP:

- The query bar + facet panel + histogram + result-list + side-panel is *one* surface,
  not a table that hands off to a separate explorer.
- A relative shortcut ("30 days") and an absolute date are two renderings of the same
  control, never two competing controls.
- Caps are replaced by **time-window narrowing + pagination/infinite scroll**, with the
  histogram giving the user the whole-volume context so a narrowed list never reads as
  "your data is missing."

### PostHog filters

Source: <https://posthog.com/docs/product-analytics/trends/filters> (retrieved 2026-06-18)

PostHog models a filter as a three-part tuple that is worth copying verbatim as the
PDPP Explore filter grammar:

1. **The property** — which field to filter on (autocompleted from the known schema).
2. **The operation** — typed to the property: `= equals`, `≠ doesn't equal`,
   `∈ contains`, `∉ doesn't contain`, `~ matches regex`, `> / < / ≥ / ≤` for numerics,
   `is set` / `is not set`. The operator menu **changes based on the field type**.
3. **The comparison value** — and `equals` / `contains` accept **multiple values**
   (OR-within-a-filter), with autocomplete on known values.

Takeaway: PDPP's declared field types (`field_capabilities[].type`, already shipped per
`explorer-record-kind-and-typed-manifest-2026-05-28.md`) are exactly the substrate that
lets the operator menu and value autocomplete be *type-aware* rather than free-text.
This is the principled answer to the owner's "the search input needs autocomplete and it
needs to be fairly intelligent" and "there should be far more ways to sort, possibly
even multiple stacked sorts."

### Algolia / faceted-search UX conventions

Algolia's building-search-UI guidance (the canonical instant-search reference; the
specific in-depth URL 404'd on retrieval 2026-06-18, so this records the well-established
convention rather than a live quote) standardizes:

- **Instant results** as you type (no submit step) — directly answers "why do I have to
  press Enter; why doesn't it auto-refresh."
- **Refinement lists** (multi-select facets) with counts; selecting several refines with
  AND across facets, OR within a facet.
- **Query suggestions / autocomplete** sourced from the index, not hardcoded.
- **URL syncing** of the full search state so a search is shareable and back-button-safe.

Takeaway: instant-search + multi-select facets + URL sync are table stakes; PDPP's
"click a connection, only the first click is honored, wait for refresh" behavior is the
opposite of the instant-refinement standard.

### Synthesis for Part 1

The convergent workbench shape (Datadog + PostHog + Algolia):

> One surface = **query bar (autocomplete) + facet/refinement rail (multi-select,
> counts) + a volume histogram that doubles as a time filter + a result list whose row
> opens an in-place detail panel**, with the entire state encoded in a shareable URL,
> and **pagination instead of silent caps**.

This is one renderer parameterized by scope, which is also the answer to the
"stream-detail table vs Explore are two different renderers" complaint: the stream
detail is this same workbench with the connection+stream pre-applied as facets.

## Part 2 — Client/app access transparency prior art

The owner question is three layered questions, and every strong product answers them as
a **list → per-app detail → activity** hierarchy:

1. Which apps/clients can read my data? (the list)
2. What can this specific app read? (per-app scope detail)
3. What has this app actually read/done? (per-app activity)

### Google — "Apps with access to your account"

Sources:
- "Share some access to your Google Account data with apps from other developers":
  <https://support.google.com/accounts/answer/3466521> (retrieved 2026-06-18)
- "Manage links between your Google Account & apps from other developers":
  <https://support.google.com/accounts/answer/13533235> (retrieved 2026-06-18)
- Live surface: <https://myaccount.google.com/connections>

Pattern:

- A **single "linked apps / connections" list** is the front door — one row per
  third-party app, *grouped by app*, not per-scope or per-grant. (PDPP's bug: ChatGPT
  shows "one grant" at the top while the package actually holds 19 source-bound child
  grants — the grouping object is wrong.)
- Each app row drills into a **per-app detail page** that states, in plain language,
  *"Google has some access to \[app\]"* and lists **exactly which data and services the
  app can access** ("if you authorize a linked app to access only your Google Calendar
  data, they can only access that data"). Access is described in graded tiers:
  *get basic profile* / *view (read) data* / *manage (edit/create/delete) data*.
- The detail page is also the place to **"See details"** and to **remove access** in one
  click, with an explicit consequence warning ("Google loses access … you won't have
  access to features that require this link").

Takeaways for PDPP:

- The list object must be the **client/app**, and "Review \[ChatGPT\]" must open a
  per-app page that shows **all** of that client's grants/scope as one consolidated
  "what it can read" view — never a single child grant masquerading as the whole.
- Describe scope in graded, owner-legible tiers (read vs write; which sources/streams),
  not as raw grant/package nouns the owner never chose ("from the user's perspective it
  was just a bunch of checkboxes").

### GitHub — "Authorized OAuth Apps"

Source: <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/reviewing-your-authorized-applications-oauth> (retrieved 2026-06-18)

Pattern:

- A flat **"Authorized OAuth Apps" list**, one row per app/token, reachable from a
  single Settings → Applications location.
- The guidance is explicitly **review-oriented**: "verify that no new applications with
  expansive permissions are authorized, such as those that have access to your private
  repositories." The surface exists to let an owner *audit* access at a glance.
- **Per-app actions are revoke-first**: a three-dot menu → **Revoke**, plus **Revoke
  all**. Revocation is the primary verb on the access list.

Takeaway: the access list should foreground (a) expansiveness of access and (b)
one-click revoke. PDPP's grant surfaces today bury both behind trace forensics.

### Plaid — consent-time "what you're sharing"

Source: <https://plaid.com/docs/link/> (retrieved 2026-06-18)

Pattern (the consent *creation* half, which sets owner expectations for the later
review surface):

- The Link flow makes the user **select which accounts to share** before any data flows
  ("…selects which accounts to share…") — consent is scoped to specific accounts/data,
  shown concretely at grant time.
- The same concrete framing ("these are the accounts/data this app will see") is what a
  good *review* surface must mirror afterward, so the post-hoc "what can this client
  read" answer matches what the owner agreed to.

Takeaway: the grant-review surface should re-present consent in the **same concrete
terms** the owner saw at consent time (which sources/accounts/streams), closing the owner's
"I can't see what was granted; from the user's perspective it was just checkboxes" gap.

### Synthesis for Part 2

The convergent access-transparency shape (Google + GitHub + Plaid):

> **One client/app list** (grouped by client, revoke-first, access-expansiveness
> visible) → **per-client detail** restating *what this client can read* in graded,
> concrete, owner-legible terms (read/write; which sources/streams) → **per-client
> activity** (what it actually read, and when last used).

PDPP already has the substrate for the third layer — the trace/disclosure spine in
`trace-surface-patterns.md` — but it is currently the *only* way to answer "what did
ChatGPT read," which requires forensics. The fix is to make the per-client page *query*
that spine for the owner (filter disclosures by `client_id`) and present a summary, not
to send the owner into raw traces. "Last used" timestamp (the owner asked for it twice) is a
trivial projection of the same spine.

## Confidence

- **High** that the explorer-workbench shape (query+facets+histogram+list+side-panel,
  URL-encoded, paginated-not-capped) is the correct, well-established target and that
  PDPP's typed field capabilities already support its type-aware filters.
- **High** that the access-transparency hierarchy is list-by-client → per-client scope →
  per-client activity, and that PDPP's current "one grant shown for a 19-grant package"
  is a grouping-object bug, not a rendering bug.
- **Medium** on the exact PDPP component decomposition (one workbench vs workbench +
  thin stream-table wrapper) — that is a build decision for the owner-reviewed mock, not
  settled by prior art alone.

## Sources

- Datadog Log Explorer — <https://docs.datadoghq.com/logs/explorer/> (2026-06-18)
- PostHog Filters — <https://posthog.com/docs/product-analytics/trends/filters> (2026-06-18)
- Algolia Building Search UI (in-depth UI/UX patterns; canonical reference, specific
  in-depth page 404'd at retrieval) — <https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/in-depth/> (2026-06-18)
- Google — Share some access to your Google Account data — <https://support.google.com/accounts/answer/3466521> (2026-06-18)
- Google — Manage links between your Google Account & apps — <https://support.google.com/accounts/answer/13533235> (2026-06-18)
- GitHub — Reviewing your authorized OAuth apps — <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/reviewing-your-authorized-applications-oauth> (2026-06-18)
- Plaid — Link overview — <https://plaid.com/docs/link/> (2026-06-18)
