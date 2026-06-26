# Owner Console — Source Inventory & Source Detail Prior Art

**Date:** 2026-06-18
**Owner:** research lens (LENS 3 — source inventory + source detail) for the PDPP owner-console SLVP redesign
**Status:** Research/design only. No product code touched. Extends, does not re-derive, the existing docs.
**Why this note exists (and what it extends):** `sources-slvp-redesign-and-data-health-2026-06-11.md` already settled the *row anatomy* (one `StatusBadge` + one metric + one CTA + peek), the single-voice synthesis layer, the copy vocabulary, and the read-resilience fix. This note **extends** it by going one layer up and one layer down: (a) the **inventory IA** — how a real master-detail list reconciles "source" vs "connection" vs "device/collector" so the owner can answer *what data do I have?*; (b) the **status legend contract** — how leading tools pair every color with a text label and bind that label to the *same predicate* as the rollup count, so "1 needs review" drills to exactly that one; (c) the **multiple-accounts/devices-per-source** model; (d) the **"Collected" basis-label** problem (new-records-this-run vs checked). It draws on Airbyte, Plaid, Sentry, Datadog, GitHub Apps, Tailscale, and Stripe — products that all solve "an inventory of upstream connections, each with health, freshness, sub-streams, and drill-through." It also leans on the sibling doc `explorer-workbench-and-access-transparency-prior-art-2026-06-18.md` for the basis-label and access-transparency precedents (cited, not repeated).

---

## 1. Prior-art sources

Each entry: URL · retrieved 2026-06-18 · the specific observed pattern.

1. **Airbyte — Connection status page** — https://docs.airbyte.com/cloud/managing-airbyte-cloud/review-connection-status (retrieved 2026-06-18).
   - **Connection-level status legend** is an explicit icon+label+description table: **Healthy** ("The most recent sync for this connection succeeded"), **Failed**, plus Running/Pending. *Color is never shown without the word and a one-line predicate definition.*
   - **Stream-level status legend** is a *second, distinct* icon+label table: **Synced** ("The stream's last sync was successful"), **Syncing** ("currently actively syncing… highlights the stream in grey"), **Queued**, **Pending**. A note disambiguates *stream-level "Queued"* (waiting within an active sync) from *connection-level "Queued"* (whole job waiting for data-worker capacity) — and explicitly states that when the connection is queued for capacity, its streams render as **Pending, not Queued.** This is a worked example of "the same word means different things at different zoom levels, so we define each one."
   - **Drill path:** Connections list → select one connection → "breakdown of the status of each Stream in that connection." Master (connection) → detail (per-stream rows).
   - **Per-stream metric with basis:** "each stream displays the time since Airbyte loaded the last record to the destination. You can click **Last record loaded** in the header to optionally display the exact datetime." So the relative time ("3h ago") is the scan value; the absolute timestamp is one click away.
   - **History as a small-multiple:** "Airbyte shows the **Streams status** and **Records loaded** for the last 8 syncs… hover over the graph and select the sync." The count metric ("Records loaded") is tied to a *specific sync run*, not an ambiguous lifetime total.
   - **Per-stream actions menu** (3-dot): "Show in replication table" (jump to schema), "Open details," "Refresh stream" (re-sync historical), "Clear data." Stream rows are actionable, not just status readouts.
   - **Auto-disable as an honest terminal state:** "If a sync starts to fail, Airbyte automatically disables it after multiple consecutive failures or consecutive days of failure" — the system tells you it stopped trying, instead of silently looking stale.

2. **Airbyte — Connections and streams (setup)** — https://docs.airbyte.com/using-airbyte/getting-started/set-up-a-connection (retrieved 2026-06-18). Establishes the noun model: a **connection** is the configured pairing (source → destination) and owns a *set of selected streams*; streams are the sub-objects within a connection. The connection is the unit you name, schedule, and read status for; streams are the detail.

3. **Plaid — Items (item status, error codes, webhooks)** — https://plaid.com/docs/api/items/ (retrieved 2026-06-18).
   - The **Item** is "a Login at a financial institution" — the connection object distinct from the institution (the source) and from the individual **accounts** under it. One Item → many accounts. This is the canonical "one connection, many sub-records under it" model.
   - **Honest, named terminal states via webhooks:** `ITEM_LOGIN_REQUIRED` ("the login details of this item have changed… a user login is required… use Link's update mode to restore the item to a good state"), a *region-split* pair of advance-warning codes — `PENDING_EXPIRATION` ("fired only for Items associated with institutions in Europe (including the UK)… access consent is expiring in 7 days") and its US/Canada equivalent `PENDING_DISCONNECT` ("fired only for US or Canadian institutions… expected to be disconnected… 7 days before"), each pointing the user at update mode — *advance warning, not a surprise break*. And `LOGIN_REPAIRED` ("Fired when an Item has exited the `ITEM_LOGIN_REQUIRED` state without the user having gone through the update mode flow… If you have messaging that tells the user to complete the update mode flow, you should silence this messaging upon receiving the `LOGIN_REPAIRED` webhook"). `LOGIN_REPAIRED` is a direct precedent for PDPP's "stop alarming once the system self-heals" — note it is an **explicit positive recovery event**, not merely the absence of an error.
   - **Error object discipline:** an Item carries a non-null `error` object **only** when calling `/item/get` to view status; otherwise error fields are null. Status is a first-class queryable field on the connection, with `error_code` + `error_type` + human `display_message`.

4. **Plaid — Institutions (institution status / health breakdown)** — https://plaid.com/docs/api/institutions/ (retrieved 2026-06-18).
   - **Source-level health legend, defined in words:** `HEALTHY` ("the majority of requests are successful"), `DEGRADED` ("only some requests are successful"), `DOWN` ("all requests are failing"). Three states, each with a one-line predicate — *the exact pattern PDPP needs for its green/yellow/red.*
   - **Per-capability health, not one blob:** status is computed *per request type* — Auth, Balance, Identity, Transactions updates, Item logins each have their own status object. This separates "can I log in" from "is the data fresh," which maps directly to PDPP's coverage-vs-freshness axes.
   - **Breakdown with explicit basis:** `breakdown` gives `success`, `error_plaid`, `error_institution` summing to 1, over a stated time window ("the most recent few minutes to the past six hours… smaller institutions… longer period… Investment updates… 24 hours or more"). The status legend is *defined by* the underlying success rate, and the window over which it is computed is disclosed.

5. **Plaid — Link update mode** — https://plaid.com/docs/link/update-mode/ (retrieved 2026-06-18). The dedicated *repair* flow that an Item in `ITEM_LOGIN_REQUIRED` enters — re-auth in place, same Item/access_token, accounts preserved. Precedent for "the repair CTA leads to a repair, not a fresh-setup picker" (the Reddit `Reconnect`→dead-end bug in the sibling doc).

6. **Sentry — Issues (list as named, filtered tabs)** — https://docs.sentry.io/product/issues/ (retrieved 2026-06-18). The Issues page is organized into tabs that are each a **named saved filter with the literal query shown**: All Unresolved (`is:unresolved`), **For Review** (`is:unresolved is:for_review`), Regressed (`is:regressed`), Archived (`is:archived`), Escalating (`is:escalating`). The rollup ("For Review") and the drilled list are *the same query* — clicking the tab shows exactly the issues that satisfy that predicate. This is the canonical "the count and the filtered view are bound to one predicate" pattern.

7. **Sentry — Project details / release health** — https://docs.sentry.io/product/projects/project-details/ (retrieved 2026-06-18). Project page rolls up health (crash-free sessions/users, adoption, issue counts) at the project level, then drills into issues. Master (project) → detail (issue) → detail (event). Multi-level master-detail where each level shows its own health summary.

8. **Datadog — Monitors overview + thresholds** — https://docs.datadoghq.com/monitors/ and https://docs.datadoghq.com/monitors/configuration/ (retrieved 2026-06-18). The docs define **alert vs warning as separate thresholds with separate recovery thresholds** ("Alert threshold… Warning threshold… Alert recovery threshold… Warning recovery threshold") — verified verbatim on the configuration page. The yellow (Warn) and red (Alert) states have *explicit numeric predicates*, and recovery is a distinct condition — so a monitor flips back to OK on a defined rule, not vibes. This is the discipline PDPP's green/yellow/red is missing ("no indication of what yellow and green mean"). (Datadog's small fixed status vocabulary — OK / Warn / Alert / No Data / Skipped / Unknown — is observed product behavior, not a list carried verbatim on the cited configuration page.)

9. **Datadog — Monitor status page** — https://docs.datadoghq.com/monitors/status/ (retrieved 2026-06-18). The per-monitor status page header shows the monitor's current status and lets you resolve it; the body offers **Evaluated Data / Source Data / Transitions** graphs so you can "investigate which groups are causing the alert," plus template variables to "scope down the monitor page to specific groups." Drill-through from "this monitor is alerting" to "*these* groups are the ones alerting" — the rollup decomposes into exactly the offending members (verified on the cited page; the OK→Warn→Alert→OK transition timeline is the Transitions graph).

10. **GitHub — Reviewing and modifying installed GitHub Apps** — https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps (retrieved 2026-06-18). For each installed app you can review the *granted permissions* and *which repositories it can access*, and you can **suspend** (temporary block) vs **delete** (permanent removal). Two distinct verbs for two distinct intents; access is enumerated per-resource. Precedent for "what does this app have access to, and how do I pause vs sever it."

11. **Tailscale — Machine names** — https://tailscale.com/kb/1098/machine-names (retrieved 2026-06-18). Verbatim: "When a new machine is added to a Tailscale network, we automatically generate its machine name from its OS hostname… This field gets reported to Tailscale on startup." A messy default (e.g. `laptop-a4og4947`) can be renamed: in the **Machines** page or **Machine Details** page, the ellipsis menu → **Edit machine name** opens an editor with an "**Auto-generate from OS hostname**" checkbox (checked by default; uncheck to pin a custom name and stop automatic renames). This is the "many physical devices, one per row, each carrying an OS-derived but owner-renameable name" model — the closest analog to PDPP's *device-local collectors* (multiple machines running the local-collector CLI under one owner), each of which should get a stable, editable name rather than a raw hostname.

12. **Stripe — Web Dashboard** — https://docs.stripe.com/dashboard (retrieved 2026-06-18). The dashboard separates *operational lists* (Payments, Balance) from *reporting* (Reports hub with filter + custom columns, Sigma for SQL, Data management for imports). The list view is for scanning/triage; the report/query surface is the explicit full-set path. Mirrors the "bounded sample for scanning, named full-set path for completeness" need.

---

## 2. Observed patterns (cross-source synthesis)

**P1 — Every status color is paired with a word AND a one-line predicate definition.** Airbyte's legend table literally reads "Healthy = the most recent sync for this connection succeeded." Plaid defines "HEALTHY = the majority of requests are successful." Datadog defines Warn/Alert by numeric thresholds. *No leading tool ships a bare colored dot.* The legend is part of the product surface, not tribal knowledge.

**P2 — The rollup count and the drilled list are bound to the SAME predicate.** Sentry's "For Review" tab *is* `is:unresolved is:for_review`; clicking it shows exactly those. Datadog's alerting monitor decomposes into exactly the alerting groups. The number you see in the summary and the rows you see after clicking are computed from one query — so "1 needs review" can only ever drill to that one.

**P3 — A strict noun hierarchy, named consistently at every zoom level.** Source/institution (the upstream brand) ⊃ connection/Item (one configured login) ⊃ account/stream (a sub-object) ⊃ record/event. Plaid: Institution ⊃ Item ⊃ Account. Airbyte: Source ⊃ Connection ⊃ Stream ⊃ record. The connection is the unit you name, schedule, status, and act on; everything else is a level above (grouping) or below (detail). The words never swap between list and detail.

**P4 — Health is computed per-capability, not as one blob, then rolled up by a stated precedence.** Plaid keeps Auth/Balance/Transactions/Item-login health as *separate* status objects. Airbyte separates connection-status from per-stream-status. The single badge an owner scans is a *rollup* of underlying axes, and the detail view shows the axes that produced it.

**P5 — Counts always carry a basis: which run, what window, success-vs-total.** Airbyte ties "Records loaded" to a specific sync (last 8 syncs as a small-multiple), not a lifetime total. Plaid's breakdown states the time window it was computed over. The number is never a bare integer; it answers "this run" or "this window."

**P6 — Repair leads to repair; the system self-heals quietly and stops alarming — on an explicit recovery signal.** Plaid's `ITEM_LOGIN_REQUIRED` → update mode (re-auth in place, accounts preserved); `LOGIN_REPAIRED` is a *distinct positive event* that explicitly instructs apps to *silence* the reconnect prompt once healed. Note that Plaid does not rely on "no error this poll" — it fires a dedicated recovery webhook. The verb on the CTA matches the destination, and a recovered connection drops its warning without owner action *when a recovery signal arrives*, not merely when an error stops being observed.

**P7 — Two distinct verbs for pause vs sever, and access is enumerated per resource.** GitHub: suspend (temporary) vs delete (permanent), with per-repo access listed. The owner can always answer "what can this have, and how do I pause vs cut it."

**P8 — Physical devices are a flat, individually-named inventory under one owner.** Tailscale: each machine gets an OS-hostname-derived name on startup that the owner can rename via the Machines/Machine-Details page (Edit machine name; "Auto-generate from OS hostname" toggle) — cited verbatim above. Devices are peers in a flat list, each individually named and addressable, not hidden behind an abstraction. (Per-device owner and last-seen columns are observed Machines-page behavior, not on the cited machine-names page.)

**P9 — Scan list ≠ full-set query; the full-set path is named and discoverable.** Stripe separates Payments list (triage) from Reports/Sigma (the complete, filterable, exportable set). The bounded view advertises where the full set lives.

---

## 3. PDPP implications (tie to surfaces + the owner's complaints)

- **"Can't tell if I'm looking at a source or a connection" / "can one connection have multiple collectors."** PDPP today blurs three nouns. Adopt P3's strict hierarchy and surface it as visible IA: **Source** (Chase, ChatGPT — the brand/provider) ⊃ **Connection** (one configured login/account at that source; Plaid's *Item*) ⊃ **Stream** (transactions, statements, sessions). For device-local sources, the device/collector is a *property of the connection's runtime* (Tailscale's Machines model), shown as "collected by: peregrine-dev, this-mac" — answering "can one connection have multiple collectors" with an explicit list rather than a guess. The Sources page is the **Source** zoom (group cards); expanding a source reveals its **Connections**; opening a connection reveals its **Streams**. This is exactly the dual-list collapse `sources-slvp-redesign-2026-06-11.md` §1.5 Option A proposes — this doc supplies the *naming contract* that makes the collapse legible: each level keeps its noun label in a breadcrumb/eyebrow ("Source · Chase" / "Connection · Chase ••4821" / "Stream · transactions").

- **"No indication of what yellow and green mean."** Apply P1. Every `StatusBadge` color must ship with (a) the word (already done) and (b) a discoverable one-line predicate on hover/tap AND in a persistent legend affordance. Define them in product copy the way Plaid/Airbyte do: **Healthy/green = last run succeeded and data is fresh within its schedule; Needs attention/yellow = the system needs you to do one thing (reconnect/authorize); Cooling off/yellow = rate-limited, the system is retrying, no action needed; Failed/red = last run failed and won't recover on its own.** The legend predicate text is the *same string* the badge tooltip shows and the *same predicate* the rollup counts (see next).

- **"1 needs review" with no way to see which one.** Apply P2 + Sentry's tab model. The health-summary bar cells ("Needs attention (1)", "Degraded (4)") must be **filter controls bound to the identical predicate** that produced the count — clicking "Needs attention (1)" filters the list to exactly that one connection (and ideally scroll-anchors/opens it). The count and the filtered set are one query; there is no path where the number disagrees with the rows. `sources-slvp-redesign-2026-06-11.md` already says "make the inert bar a filter" — this doc pins *why it must be the same predicate*: the bug the owner hit is precisely a count computed by predicate A with no view that re-applies A.

- **"Collected" confusing — many say no change vs how many NEW records.** Apply P5. Replace the ambiguous "Collected" with a **basis-labeled** metric. Per run: **"+N new · M updated · K unchanged (this run)"** with the run timestamp; the lifetime total moves to detail as **"X records total"**. This directly resolves "no change vs new records": "no change" reads as "+0 new · all unchanged," and a real harvest reads as "+312 new." Tie the count to the run (Airbyte's "Records loaded for the last 8 syncs"), never a bare lifetime integer. The sibling explorer doc covers the in-explorer basis label ("6 of 1,183"); this is its inventory-row counterpart.

- **"Can't see run/sink detail from the summary."** Apply P5's small-multiple + Airbyte's drill. Each connection row's metric ("last run · +N new") is itself the drill-through into the **run/sink detail** (the peek/diagnostics surface), and the detail shows the last-8-runs strip (records per run) so a single bad run is visible against a healthy baseline. The stream rows inside expose the per-stream "last record loaded" relative time with absolute on click.

- **"Source vs connection" + multiple accounts.** Plaid's Institution ⊃ Item ⊃ Account is the template: PDPP's Source card shows "2 connections" when the owner has two Chase logins, each its own row with its own health, its own accounts/streams. "Add another account" (P7's add affordance) is visually distinct from the repair CTA — already specified in the sibling doc §1.4; this doc grounds it in Plaid's one-Item-per-login / many-accounts-per-Item model (the `NEW_ACCOUNTS_AVAILABLE` webhook — observed Plaid behavior, not a fetched citation — signals an existing Item gaining accounts, distinct from adding a second Item).

- **"What does ChatGPT have access to / what did ChatGPT read."** That is the access-transparency lens (sibling doc, GitHub Apps P7). The *inventory* contribution here: a connection's detail should show, alongside its health, "**N AI apps can read this**" as a cross-link to the grants surface — so the source inventory and the access surface are two views of one graph, mirroring GitHub showing per-app the repos it can touch.

- **"Feels vibe-coded" / wall-of-text status ("Suppressed evidence. Drain detail gap backlog").** P1+P4: the badge is a *rollup of named axes*; the wall-of-text is internal axis jargon leaking into the owner surface. The fix (already in §1.3 of the sibling doc) is one synthesized sentence; this doc adds the *legend contract* that prevents regression — any new status string must map to a defined predicate in the legend, or it cannot ship.

---

## 4. Concrete affordance / copy / IA recommendations

**4.1 Noun model + breadcrumb (kills source-vs-connection confusion)**
- Three nouns, fixed labels everywhere: **Source** / **Connection** / **Stream** (+ Device/collector as a connection property).
- Every detail surface carries an eyebrow breadcrumb: `Sources › Chase › Chase ••4821 (Connection) › transactions (Stream)`.
- A Source card header reads `Chase — 2 connections · 6 streams · healthy`. Connection row reads `Chase ••4821 · checking + savings · collected by peregrine-dev`. For device-local: `iMessage — 1 connection · collected by: this-mac, mini` (explicit collector list answers "multiple collectors?").

**4.2 Status legend contract (kills "no idea what yellow/green mean")**
- One `StatusBadge` vocabulary (already exists). Add a persistent **"What do these mean?"** disclosure on the Sources page header that renders the legend table (Airbyte-style): Label · color swatch · one-line predicate. Same strings as the badge tooltip.
- Predicate definitions (owner-facing copy):
  - **Healthy** — "Last sync succeeded; data is fresh on schedule."
  - **Cooling off** — "Rate-limited upstream; retrying automatically. No action needed."
  - **Needs attention** — "One thing needs you: <reconnect | authorize | finish setup>."
  - **Failed** — "Last sync failed and won't recover on its own."
  - **Idle / Scheduled** — "Waiting for the next scheduled run."
- Hard rule: a status string may only ship if it has a legend predicate entry (enforce with the negative-copy regression test the sibling doc already mandates).

**4.3 Summary cells = predicate-bound filters (kills "1 needs review, can't find it")**
- Health-summary chips become filter toggles: `All (19) · Needs attention (1) · Cooling off (1) · Failed (0) · Healthy (17)`.
- Clicking `Needs attention (1)` filters the list to exactly that predicate AND, if the result is a single connection, scroll-anchors/expands it (Sentry "For Review" tab behavior). The count and the filtered rows are the *same selector* — share one pure predicate function so they cannot diverge.
- The active filter is shown as a removable pill (Sentry/Datadog), and an empty result reads "No connections need attention" — never a blank.

**4.4 Basis-labeled "Collected" metric (kills new-vs-checked ambiguity)**
- Row metric (this-run basis): `2h ago · +12 new · 3 updated` (omit "0 unchanged" for brevity; show full triple in detail).
- A no-change run reads `2h ago · no new records` (explicitly "checked, nothing new") — not the ambiguous "Collected."
- Detail surface: last-8-runs strip showing records-per-run (Airbyte small-multiple) + `1,183 records total` as the lifetime number, clearly labeled "total."
- Relative time is the scan value; absolute timestamp on hover/click (Airbyte "Last record loaded").

**4.5 Stream rows + drill (master-detail)**
- Expanding a connection shows a per-stream table: `stream name · last record loaded · status (Synced/Syncing/Pending/Failed) · +N this run`.
- Each stream row links into the explorer pre-filtered to that stream (the explorer/jump-to-ID surface from the sibling doc), and a 3-dot menu offers "View in explorer" / "Re-run this stream" (Airbyte per-stream actions) where the connector supports it.

**4.6 Multiple accounts/devices**
- Source card lists each connection as its own row with independent health (Plaid multi-Item). "Add another account" is a ghost/secondary affordance in the Source card header, never adjacent to a repair CTA.
- Device-local connections render the collector list inline; a stale device shows `collected by: this-mac (last seen 6d ago)` (a last-seen/last-active column per device — observed Tailscale Machines-page behavior, not a fetched citation) so "why is this stale" is answerable without leaving the row.

**4.7 Repair-verb-matches-destination + self-heal**
- `Reconnect` only when a packaged re-auth path exists and lands on it (Plaid update mode). Otherwise show honest state + a `Start new setup` link (already specified in sibling doc; reinforced here by the Plaid precedent).
- On self-heal, drop the warning silently (Plaid `LOGIN_REPAIRED`) — no lingering "needs attention" after a run succeeds. **Implementable in PDPP:** the health projection (`reference-implementation/runtime/connection-health.ts`) already derives `healthy` from a *positive* `CollectionSucceeded` event / `latestStatus: "succeeded"` / fresh `last_success_at` (the "clean evidence, fresh enough → healthy" rule), so a successful next run is a real recovery signal the projection can act on — silencing is bound to that signal, not to a mere gap in errors.

**4.8 Full-set path from the inventory**
- Each connection/stream metric is a link into the explorer for the complete record set (Stripe list→Reports separation); the bounded inventory never implies it is the full data.

---

## 5. Anti-patterns to avoid

- **Bare colored dot with no word/predicate.** No leading tool does this; PDPP currently effectively does ("no idea what yellow means"). Color is redundant encoding, never the only encoding (also an a11y requirement).
- **A count whose drill applies a different predicate (or no drill).** The root cause of "1 needs review, can't see which." Never compute a summary number by a selector that has no matching filtered view.
- **A bare lifetime integer labeled "Collected."** Ambiguous between throughput and total; always state the basis (this run / this window / total).
- **Swapping nouns between list and detail** (calling the same thing "source" in the list and "connection" in the detail). Pick Source/Connection/Stream and never deviate.
- **Hiding multiple collectors/accounts behind one summary** so the owner can't tell a source has two logins or two devices. Enumerate them (Plaid/Tailscale).
- **Stacking every internal axis as a sibling badge** ("Suppressed evidence. Drain detail gap backlog"). Roll up to one badge; axes live in detail (already ruled in sibling doc — preserved here).
- **A repair CTA that lands on a fresh-setup picker** (the Reddit `Reconnect` dead-end). Verb must match destination.
- **Leaving a "needs attention" warning up after the connection self-heals.** Silence on recovery (Plaid `LOGIN_REPAIRED`).

## 6. Acceptance checks (owner-walkable, testable)

1. **Legend exists and is reachable.** On the Sources page, an owner can open a legend that lists every status label with its color and a one-sentence predicate, and the predicate text is byte-identical to the badge's hover/tap tooltip.
2. **Color is never alone.** Every status indicator in the inventory renders a text label adjacent to (not only) the color; verifiable by reading the row with color stripped.
3. **Count→drill predicate identity.** Clicking `Needs attention (N)` yields exactly N connections, each of whose badge reads a "needs attention"-class state; clicking `Failed (0)` yields an explicit empty state, not a blank or all rows. (Unit-test the shared predicate function: `summaryCount(pred) === filteredRows(pred).length` for every predicate.)
4. **Single-item drill.** When a summary chip count is 1, activating it surfaces *that one* connection (anchored/expanded), with no scrolling hunt.
5. **Noun consistency.** Walking Sources → a source → a connection → a stream, each surface labels the level with the same fixed noun (Source/Connection/Stream) in an eyebrow/breadcrumb; grep the inventory + detail components for any place the same entity is called by a different noun.
6. **Basis-labeled counts.** No inventory row shows a count without a basis qualifier ("this run" / "no new records" / "total"); a connection whose last run found nothing reads "no new records," not "Collected."
7. **Run detail reachable from summary.** From a connection row, one interaction reaches a detail surface showing per-run record counts for recent runs (≥ last several) and per-stream last-record-loaded times.
8. **Multiple connections/collectors enumerated.** A source with two configured logins shows two connection rows with independent health; a device-local connection shows its collector device(s) by name with last-seen.
9. **Repair leads to repair.** Every `Reconnect`/repair CTA's destination is a re-auth/repair step for that same connection (accounts/streams preserved), never a new-source picker; a connection lacking a packaged repair path shows honest state instead of a misleading `Reconnect`.
10. **Self-heal silences on a positive recovery signal.** After a previously-degraded connection's next run *emits a success signal* (a `CollectionSucceeded`/`succeeded` terminal event with fresh `last_success_at`, per `reference-implementation/runtime/connection-health.ts`), its warning state clears without owner action on the following render. The clear must be driven by the positive `succeeded` evidence (Plaid `LOGIN_REPAIRED` analog), not merely by the absence of a new error — verify the projection input is the success event, so the behavior is implementable rather than aspirational.
