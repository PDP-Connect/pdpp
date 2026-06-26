# Owner Console — Product Gestalt and Personal-Data Dignity (Prior Art)

**Date:** 2026-06-18
**Owner:** Claude (research lens 1 of the owner-console SLVP redesign corpus)
**Status:** Research/design only — no product code, no deploy, no live-stack ops.
**Why this note exists (and what it extends):** The owner console currently reads as
"fairly vibe-coded" and that "blocks my ability to share this out" (the owner). The other
corpus docs attack *specific surfaces* — explorer/filters/access-transparency
(`explorer-workbench-and-access-transparency-prior-art-2026-06-18.md`), sources/health
(`sources-slvp-redesign-and-data-health-2026-06-11.md`,
`slvp-connector-health-FINAL-design-2026-06-15.md`), connector setup
(`slvp-ideal-connector-self-service-setup-2026-06-14.md`,
`slvp-ideal-browser-device-connector-setup-2026-06-14.md`), mobile master-detail, traces,
control plane, relationships, stuck-run liveness, and scheduled human help. **This doc is
the orthogonal lens: the whole-product gestalt** — what makes a multi-object operator
surface feel like ONE designed product instead of stitched admin panels, and how to signal
trust/dignity for *intimate personal data specifically*. It does NOT re-derive the
per-surface docs; it gives them a coherence and dignity spine and cites them where they own
the detail.

---

## 1. Prior-art sources

Each entry: URL + retrieval date 2026-06-18 + the specific observed pattern.

### Coherence / opinionated craft

1. **Linear — The Linear Method (Principles & Practices).**
   <https://linear.app/method> and <https://linear.app/method/introduction> (retrieved 2026-06-18).
   Framed as reviving "a lost art of building true quality software," with a small set of
   explicit, named principles. "Meaningful direction": even amid small tasks, the product
   keeps reminding everyone of *purpose and long-term goals*. "Mix feature and quality
   work": treat bugs/quality as first-class scheduled work, and "invest in tooling… a force
   multiplier." Pattern: a *stated, opinionated method* that the product visibly obeys, so
   every screen feels like it came from the same point of view.

2. **Linear — Now / Craft channel.**
   <https://linear.app/now> (retrieved 2026-06-18). Linear publicly curates a "Craft" feed
   of polish work alongside Changelog/News. Pattern: craft is a *named, owned category*,
   not incidental — the team signals that detail-level finish is part of the product
   identity, which is exactly the signal a "shareable" surface needs.

3. **Stripe — Web Dashboard (Home / primary navigation).**
   <https://stripe.com/docs/dashboard> (retrieved 2026-06-18). One persistent left
   primary-nav; a single **Home** page that "provides analytics and charts… also surfaces
   important notifications, like unresolved disputes or identity verifications," and is
   *customizable* via an "Your overview" widget add/remove/Apply flow. Pattern: one
   coherent home that both *summarizes* and *routes to the few things that need you*, and
   the same nav vocabulary persists everywhere.

4. **Stripe — Developer tools surface (Workbench / Console / Developers Dashboard).**
   <https://stripe.com/docs/development> (retrieved 2026-06-18). Tools are presented as one
   labeled family — "Workbench" (debug/manage/grow your integration), "Stripe Console"
   (conversational analysis of your data), "Developers Dashboard" (API request & event
   activity) — each with a one-line purpose statement. Pattern: even the power-user
   surfaces are *named with a noun and a one-line job*, so nothing feels like an und
   ifferentiated "advanced" dumping ground.

5. **Stripe — Payments APIs: the first 10 years.**
   <https://stripe.com/blog/payment-api-design> (retrieved 2026-06-18). Stripe's design
   essay on consistency, naming, and backward-compatible evolution of object models.
   Pattern: object *naming and shape are treated as product surface* — the same discipline
   that makes the dashboard's nouns (Customer, Charge, Dispute) read as one designed system.

6. **Vercel — Deployments overview & Managing Deployments.**
   <https://vercel.com/docs/deployments/overview> and
   <https://vercel.com/docs/deployments/managing-deployments> (retrieved 2026-06-18). A
   deployment is a first-class, immutable, addressable object with a clear lifecycle and a
   bounded verb set: **Redeploy, Inspect** (view logs/build output), **Assign a Custom
   Domain**, **Promote to Production**. Pattern: every list row drills into a *detail* with
   logs and the same few verbs; "promote to production" gives a status transition a single
   dignified word instead of a config dance.

7. **Supabase — Platform overview.**
   <https://supabase.com/docs/guides/platform> (retrieved 2026-06-18). A "hosted platform…
   without needing to manage any infrastructure"; each project bundles a known set of
   capabilities (Postgres DB, Auth, Storage, etc.) behind one project dashboard. Pattern: a
   technically deep, multi-subsystem product unified under one project shell so it still
   "feels designed," not like a pile of services.

### Calm agency / command surface

8. **Raycast — Manifesto ("We've all felt it").**
   <https://www.raycast.com/manifesto> (retrieved 2026-06-18). Explicit thesis: tools cause
   "switching between apps and contexts," "simple actions turn into long series of clicks,
   causing us to forget our intentions." Goal is *Flow* — "distractions aren't just easier
   to resist but are completely out of sight." Pattern: design *for the user's intention*,
   minimize click-chains, keep the surface calm.

9. **Raycast — Home / AI.**
   <https://www.raycast.com/> and <https://www.raycast.com/core-features/ai> (retrieved
   2026-06-18). "Your shortcut to everything" — a single keyboard-first command surface
   over many heterogeneous extensions, presented as one calm launcher. Pattern: many
   objects/actions, one consistent entry affordance and interaction grammar.

10. **Tailscale — Quickstart / admin console (Machines page).**
    <https://tailscale.com/kb/1017/install> (last validated by Tailscale Jan 5, 2026;
    retrieved 2026-06-18). The admin console centers a **Machines** page where every device
    gets a human-readable auto-generated name you can rename "to help you locate and
    organize devices." Console sections (Machines, Users, DNS, ACLs, settings) are plain
    nouns; the install/onboarding flow is narrated step-by-step ("Take me home" at the end).
    Pattern: networking — an intrinsically gnarly admin domain — rendered as humane, named
    objects with editable friendly labels and a guided first run.

### Consent / ownership dignity for intimate data

11. **Plaid — Why Plaid (ownership framing + portal CTA).**
    <https://plaid.com/why-plaid/> (retrieved 2026-06-18). Verbatim: "When you connect to an
    app with Plaid, you're in control of who has access to your financial data," paired with
    a lock spot-illustration and a direct CTA: **"Manage your connections with Plaid
    Portal »"** → my.plaid.com. Pattern: ownership stated in second person *at the surface*,
    plus a single concrete place to see and revoke access.

12. **Plaid — Consumer safety & "How Plaid works, explained."**
    <https://plaid.com/safety/> (retrieved 2026-06-18). Verbatim: "Each account connection
    starts with you, only happens with your permission, and you can choose to stop sharing
    at any time." Plain-language Q&A ("What is Plaid, and is it safe?", "What if I can't
    connect?" → troubleshooting). Pattern: dignity = *agency stated plainly* (starts with
    you / your permission / stop anytime) + a calm self-serve recovery path for failure.

13. **Plaid — How we handle your personal financial data.**
    <https://plaid.com/how-we-handle-data/> (retrieved 2026-06-18). Verbatim: "Plaid puts
    you in control of your financial data… people have a right to their financial
    information… your right to decide where, how, and with whom your data is shared."
    Pattern: a *first-principles ownership manifesto* for intimate data, in the product's
    own voice.

14. **Plaid — Portal (my.plaid.com).**
    <https://my.plaid.com/> (retrieved 2026-06-18). "The convenient way to manage your
    financial data" — one consumer surface to see connections and stop sharing. Pattern: the
    *post-consent* counterpart to Link — one place to answer "who has access and how do I
    revoke," mirroring the concrete terms shown at consent time.

15. **Plaid — Link / item lifecycle (consent re-presented; honest disconnect states).**
    <https://plaid.com/docs/link/> and <https://plaid.com/docs/api/items/> (both retrieved
    2026-06-18; the Items page was re-fetched this session to confirm the state wording
    below verbatim; Link consent pattern also captured in the existing explorer/access doc).
    Link makes the user *select which accounts to share* before data flows; the item
    lifecycle has explicit, named, owner-actionable states. Verbatim from the Items webhook
    reference: `PENDING_DISCONNECT` is *"Fired when an Item is expected to be disconnected.
    The webhook will currently be fired 7 days before the existing Item is scheduled for
    disconnection. This can be resolved by having the user go through Link's update mode."*
    (US/CA; the EU/UK counterpart is `PENDING_EXPIRATION`, *"fired … expiring in 7 days …
    resolved by … update mode."*). Pattern: consent is scoped to concrete accounts/data, and
    degradation is communicated *ahead of time* as a *named state with a stated remedy and a
    deadline*, never a silent failure. NOTE on borrowing this in product copy: the literal
    string `PENDING_DISCONNECT` is a Plaid webhook code, not owner-facing UI copy — borrow
    the *shape* (advance-warning named state + remedy verb + deadline), not the token.

> Failed/blocked fetches this session: `tailscale.com/blog/how-our-free-plan-stays-free`
> (HTTP 404), `linear.app/blog/all-the-tiny-things-that-make-linear-feel-fast` (HTTP 404),
> and transient DNS ETIMEOUT on first attempts for `supabase.com`/`stripe.com`/`vercel.com`
> (all recovered on retry against canonical doc paths).

---

## 2. Observed patterns (cross-source synthesis)

Reading 8 SLVP-tier and adjacent products together, "feels like ONE designed product" and
"I'd proudly show this" reduce to a small number of repeatable moves:

- **One persistent shell, plain-noun nav, vocabulary that never renames itself.** Stripe,
  Tailscale, Vercel, Supabase all keep a single primary nav of concrete nouns (Home /
  Machines / Deployments / Customers), and the route, the page H1, and the nav label are the
  *same word*. Coherence is mostly *naming discipline*, not visual flourish.
- **A single Home that summarizes AND routes to "the few things that need you."** Stripe
  Home pairs at-a-glance analytics with "important notifications, like unresolved disputes."
  The home is the product's point of view about *what matters now*, not a generic dashboard.
- **Every list row is a first-class object with a detail page and a bounded verb set.**
  Vercel deployments: row → detail with logs (Inspect) + a small fixed verb menu (Redeploy,
  Promote, Assign domain). The verbs are *the same everywhere*; you never wonder what you can
  do to a thing.
- **Status is a named state with a remedy, never raw evidence.** Vercel (Ready/Building/
  Error + Inspect logs), Plaid (`PENDING_DISCONNECT` → update mode). Color/badge always has a
  legend or a hover that says what it means and what to do.
- **Opinionated, stated method shows through.** Linear literally publishes its method and a
  "Craft" feed; the product visibly obeys it. The felt result is "someone with taste decided
  this," the opposite of "vibe-coded."
- **Calm = fewer click-chains, intention-first.** Raycast designs to *the user's intention*
  and keeps distractions "out of sight"; one consistent command grammar over many objects.
- **Dignity for intimate data = second-person agency, stated plainly, with a single revoke
  surface.** Plaid says "you're in control," "starts with you," "stop sharing at any time,"
  and gives one Portal to act on it. Ownership is *language plus an affordance*, not a policy
  PDF.
- **Humane labels for machine objects.** Tailscale auto-generates friendly device names and
  lets you rename them. Personal data sources/connections deserve the same: a name the owner
  recognizes, not a connector key.
- **Guided, narrated first run, with a clear "you're done" ending.** Tailscale's quickstart
  walks add-device → add-second-device → "Take me home." Beginnings and endings are designed.

---

## 3. PDPP implications (tie to surfaces and to the owner's complaints)

| the owner's complaint (proof phrase) | Gestalt principle violated | Product precedent |
|---|---|---|
| "routes named differently than nav" | naming discipline / one vocabulary | Stripe/Tailscale plain-noun nav where route = label = H1 |
| "feels fairly vibe-coded" / "blocking my ability to share this out" | no stated point of view; inconsistent shell | Linear Method + Craft feed (visible taste) |
| "'1 needs review' with no way to see which one" | Home must route to the things that need you | Stripe Home surfacing "unresolved disputes" as clickable |
| "no indication of what yellow and green mean" | status = named state + legend/remedy | Vercel Ready/Building/Error + Plaid `PENDING_DISCONNECT` |
| "can't tell if I'm looking at a source or a connection" | first-class objects with stable identity & humane names | Tailscale Machines (named, renamable device objects) |
| "what does ChatGPT have access to / what did it read" | one revoke/transparency surface, consent re-presented | Plaid Portal + "you're in control of who has access" |
| "'One Thing Needs You' vs 'three things wrong'" | single honest priority model on Home | Stripe Home notifications (count must equal the routable list) |
| "wall-of-text status ('Suppressed evidence. Drain detail gap backlog')" | calm, intention-first copy; remedy not evidence-dump | Raycast "out of sight" + Vercel "Inspect" hides logs behind a verb |
| "blinking cursor; no progress indicator" (local recovery) | designed beginnings/endings; honest liveness | Tailscale narrated quickstart with a "done" state |
| "Collected confusing — no change vs how many NEW records" | named state with a number that means one thing | Vercel build outputs; Stripe overview widgets |

These map onto concrete surfaces: the **Home/overview** (Stripe-Home model), the **left
nav + route naming** (one vocabulary), the **Sources vs Connections** object model
(Tailscale Machines), the **grant/access-transparency** surface (Plaid Portal — detailed in
the explorer/access doc, which this gestalt lens endorses and frames), and **status copy
everywhere** (named-state-plus-remedy). This doc supplies the *connective tissue*; the
per-surface docs own the mechanics.

---

## 4. Concrete affordance / copy / IA recommendations

> **Corpus de-confliction (read first).** Four of this section's recommendations (4.3, 4.4,
> 4.5, 4.6) share concrete territory with two same-day sibling lenses that this gestalt lens
> deliberately does NOT re-derive. A reviewer merging the corpus must treat those sibling
> docs as the *single owning authority* for the mechanics; this doc states only the
> cross-product gestalt RULE and points at the owner:
> - **`owner-console-source-inventory-and-detail-prior-art-2026-06-18.md` OWNS:** the
>   canonical Source / Connection / Stream (+ device-as-connection-property) noun set (its
>   §4.1); the status-legend-bound-to-rollup-count contract — i.e. the legend predicate text
>   and the rollup-count predicate are one selector (its §4.2 + §4.3 + acceptance #1/#3); and
>   the **"Collected" new-vs-checked basis-label** wording (`+N new · M updated · K
>   unchanged (this run)` / `no new records`, its §4.4). My 4.3/4.4/4.5 below must NOT
>   restate these as competing definitions — where the wording diverges, that doc wins.
> - **`owner-console-access-review-grants-clients-prior-art-2026-06-18.md` OWNS:** the
>   apps-with-access per-app capability matrix, the "can read" vs "has read" split, the
>   revoke/consequence copy, and the route/nav noun for that surface (its §4). My 4.6 below
>   is the gestalt/dignity *framing* for it only; the IA and route name come from that doc.
>
> So: 4.3/4.4/4.5/4.6 state a RULE ("status is a named state with a legend bound to the same
> predicate as its count"; "Collected must declare the delta"; "apps-with-access is one
> dignified Portal-style surface") and cite the owning doc for the exact noun set, legend
> strings, delta wording, and matrix mechanics. The canonical noun set, the status legend,
> and the Collected-delta phrasing are each stated authoritatively in exactly ONE doc — not
> here.

**4.1 One vocabulary, enforced.** The gestalt RULE this doc owns: there is exactly ONE noun
per object, and route slug = nav label = page H1 *identical* (case aside), with a
build-time/test assertion that every nav item's `href` last segment matches its label slug.
(Stripe/Tailscale precedent.) The corpus needs a *single* canonical noun set; the
per-surface lenses, not this gestalt doc, are the owning authority for each individual noun.
The access-review lens (`owner-console-access-review-grants-clients-prior-art-2026-06-18.md`
§4, "IA — three named surfaces") already picked the **access/clients** noun: route
`/clients`, nav label **"AI app access"** (its own acceptance check #1 asserts route name ==
nav label). **This doc defers to that choice** rather than introducing a competing "Apps
with access" label — so the corpus is consistent, the gestalt RULE (route == nav == H1)
holds, and vocabulary-parity check #1 in *this* doc cannot pass while contradicting the
access doc. Working canonical set, with the owning lens for each noun named: **Home**
(gestalt), **Sources** (source-inventory lens), **Data / Explore** (record-workbench lens),
**AI app access** (access-review lens — its label, not ours), **Runs** (evidence/runs lens),
**Settings**. If a single human-readable phrase is preferred over "AI app access" at
merge time (e.g. to better answer the owner's "what does ChatGPT have access to"), that decision
is the access lens's to make and ripple — this doc just enforces that whatever is chosen is
used identically as route, nav, and H1, and is not duplicated under a second name elsewhere.
Kill any route whose slug disagrees with its nav label.

**4.2 Home = "Your data, and what needs you."** Top: a calm one-line ownership statement
in second person — e.g. *"This is your data. You decide what's collected and which apps can
read it."* (Plaid voice). Below: an **at-a-glance** strip (sources connected, records held,
AI apps with access — using whatever the access-review lens names that surface, not a
competing label) and a **Needs you** list whose *length equals the headline count* — if the
headline says "3 things need you," there are exactly 3 clickable rows, each routing to the
exact object. Never show a count without its list (fixes "1 needs review with no way to see
which one" and "One Thing vs three things"). (Stripe Home precedent.)

**4.3 Sources vs Connections must carry a humane name (RULE; noun set owned elsewhere).**
*Gestalt RULE this doc asserts:* every object the owner sees has a **humane, editable
display name** as its primary label, with the connector key / machine id shown only as small
secondary metadata, so the owner can answer "what am I looking at" in one glance — a card
header like `ChatGPT · personal · 1,183 records · last collected 2h ago`. (Tailscale
renamable-Machines precedent.) *The canonical noun set itself — Source / Connection / Stream,
with device-as-connection-property — is OWNED by
`owner-console-source-inventory-and-detail-prior-art-2026-06-18.md` (its §4.1 + breadcrumb
contract + acceptance #5).* This doc does not re-define those nouns or their hierarchy; it
only adds the cross-product dignity rule (humane name primary, machine id secondary). On any
divergence in noun wording, the source-inventory doc wins.

**4.4 Status = named state + legend bound to the same predicate as its count (RULE; legend
strings owned elsewhere).** *Gestalt RULE this doc asserts:* no color ships without (a) a
state word, (b) an inline-reachable legend, and (c) a single remedy verb when not green; and
internal diagnostic prose ("Suppressed evidence. Drain detail gap backlog") never appears on
a summary — it lives behind an **Inspect** verb on the detail (Vercel "Inspect logs" model).
*The authoritative status legend — the exact label set, the one-line predicate text, AND the
contract that the legend predicate is the SAME selector as the rollup count (so "1 needs
review" drills to exactly that one) — is OWNED by
`owner-console-source-inventory-and-detail-prior-art-2026-06-18.md` (its §4.2 status-legend
contract + §4.3 predicate-bound filters + acceptance #1/#3).* This gestalt doc does not
publish a competing legend vocabulary; further per-domain detail lives in
`slvp-connector-health-FINAL-design` and `trace-surface-patterns`. Where this doc's
illustrative state words differ from the source-inventory legend, that doc's legend is
canonical.

**4.5 "Collected" must declare the delta (RULE; exact wording owned elsewhere).** *Gestalt
RULE this doc asserts:* a completed run never shows a bare verb like "Collected"; it leads
with the number the owner cares about — NEW records — and distinguishes "checked, nothing
new" from "no run happened." *The canonical delta phrasing — `+N new · M updated · K
unchanged (this run)` and the no-change form `no new records`, plus the rule that lifetime
total moves to detail labeled "total" — is OWNED by
`owner-console-source-inventory-and-detail-prior-art-2026-06-18.md` (its §4.4 +
acceptance #6).* This doc adopts that wording by reference rather than inventing a second
phrasing; the earlier illustrative `42 new records (1,141 unchanged)` form is subordinate to
the source-inventory wording at merge time.

**4.6 Apps-with-access = a Plaid-Portal-style single surface (gestalt/dignity framing only;
IA + route name owned elsewhere).** *Gestalt/dignity RULE this doc asserts:* there is ONE
dignified, owner-owned surface to answer "who can read my data and how do I stop them," and
its header speaks in second-person ownership voice — *"You're in control of what each app can
read. Stop sharing anytime."* (Plaid "you're in control" + Portal precedent). *The
per-app capability matrix, the "can read" vs "has read" split, the revoke/consequence copy,
and — critically — the route/nav noun for this surface are OWNED by
`owner-console-access-review-grants-clients-prior-art-2026-06-18.md` (its §4 "three named
surfaces": route `/clients`, nav label "AI app access").* This doc supplies only the
dignity/voice framing and defers the route name to §4.1 above (which itself defers to the
access lens) — so the apps-with-access noun is stated authoritatively in exactly one place,
not here.

**4.7 Designed beginnings and endings for long operations.** Any flow that hands the owner a
CLI command (local recovery) must (a) show the command in a copy-button block, (b) state
what success *looks like* ("you'll see `enrolled` and a record count"), and (c) provide a
liveness/progress affordance instead of a blinking cursor — at minimum a "Checking…" →
"Done / Still running" state the console can poll or the CLI can emit. End every guided flow
with an explicit "You're done — here's what changed" panel. (Tailscale narrated quickstart +
"Take me home" precedent; ties to `slvp-ideal-stuck-run-liveness`.)

**4.8 Bounded samples must label their basis and offer the full set.** "6 of 1,183" must
read `Showing 6 of 1,183 — most recent` (or "random sample"), with a **View all 1,183** link
and a discoverable **Jump to ID** input that gives feedback (found → scrolls/opens; not found
→ inline "No record with that ID"). (Detail owned by the explorer doc; gestalt rule: *no
number without its basis and its escape hatch*.)

**4.9 A stated point of view, lightly surfaced.** Add a short, linkable **"How this works"**
/ principles page in the product's own voice (Linear Method + Plaid manifesto precedent):
*"Your data lives on hardware you control. Nothing is collected without you connecting it.
No app reads it without a grant you can revoke."* This is the single biggest "not
vibe-coded / I'd show a friend" lever — it tells the visitor someone *decided* what this
product believes.

**4.10 Calm copy default.** One sentence per state; verbs over jargon; second person.
Replace operator/debug nouns in owner-path copy (drain, backlog, suppressed evidence,
detail-gap, materialization) with owner words or hide them behind Inspect. (Raycast
intention-first + the existing copy/vocab audit.)

---

## 5. Anti-patterns to avoid

- **Renaming objects between nav, route, and page title.** The single fastest "stitched
  panels" tell. (Direct hit on the owner's route/nav complaint.)
- **Counts without lists.** "N need review" with no clickable N. Always render the list the
  count summarizes.
- **Color without legend.** Yellow/green with no inline "what this means / what to do."
- **Evidence dumped on summaries.** Internal diagnostic strings ("Suppressed evidence")
  shown on the owner's at-a-glance path instead of behind an Inspect verb.
- **Exposing the machine identity instead of a humane name.** Showing only connector keys /
  IDs so the owner can't tell a source from a connection.
- **Silent degradation.** A connection going stale/disconnected with no named state and no
  remedy. Do the opposite: Plaid's advance-warning-with-remedy pattern (the
  `PENDING_DISCONNECT` webhook fires 7 days ahead with update mode as the stated fix) — but
  borrow the *shape* (named advance-warning state + remedy verb + deadline), not Plaid's
  internal webhook token as owner copy.
- **Blinking-cursor handoffs.** Handing off to a CLI with no success criteria, no progress,
  no "done."
- **Policy-PDF dignity.** Putting "you own your data" only in a legal page rather than in
  second-person product copy at the surface plus a revoke affordance.
- **Bare samples.** "6 of 1,183" with no basis label and no path to the full set or a record
  by ID.
- **No stated point of view.** Shipping competent screens with no visible belief about what
  the product is for — reads as generated, not designed.

---

## 6. Acceptance checks (owner-walkable, testable)

A reviewer can verify each by walking the console:

1. **Vocabulary parity.** For every primary-nav item, the route's final slug, the nav label,
   and the destination page's H1 are the same word. (Automatable: assert nav `href` slug ===
   label slug; assert page H1 === label.) The *value* of each noun comes from its owning lens
   — in particular the access surface uses the access-review doc's chosen route/label ("AI
   app access" / `/clients`), not a label invented here — so this check passing in this doc
   never contradicts a sibling doc's chosen route name.
2. **Count = list.** On Home, the "needs you" headline number exactly equals the number of
   clickable rows in the needs-you list, and each row routes to the specific object. No
   headline count exists anywhere without an adjacent enumerable list.
3. **Legend present.** Every status badge (any color) exposes, inline within one
   interaction, a sentence stating what the state means and (if not healthy) the remedy verb.
   No color appears without a reachable legend.
4. **Source vs connection is answerable in one glance.** Each card's header line states the
   object type, the human account name, the record count, and last-collected time, with the
   connector key only as secondary metadata. A first-time viewer can say "this is a source
   named X" without opening detail.
5. **Apps-with-access answers the ChatGPT question.** There is exactly one route (named per
   the access-review lens — "AI app access" / `/clients`, not a label coined here) listing
   the AI apps that can read the owner's data; opening an app shows *what it can read*
   (concrete sources/streams matching consent), *when it last read*, and a working **Revoke**.
   Header copy uses second-person ownership language. (Matrix/IA mechanics are verified by the
   access-review doc's own acceptance checks; this check verifies only the gestalt: one
   surface, dignified voice, answerable in-place.)
6. **Delta-honest collection copy.** A completed run never says bare "Collected"; it states
   new vs unchanged counts (or "no new records"). The NEW number is the lead.
7. **No evidence on summaries.** No internal diagnostic string ("Suppressed evidence", "Drain
   detail gap backlog", "materialization") appears on any at-a-glance/summary surface; such
   strings appear only behind an explicit Inspect/detail verb.
8. **Designed handoff.** Any CLI handoff shows a copyable command, a stated success
   criterion, and a non-static progress/liveness affordance (not a bare blinking cursor), and
   the flow ends with a "what changed" confirmation.
9. **Sample basis + escape hatch.** Any "M of N" sample states its basis (most recent /
   random) and offers both "view all N" and a working jump-to-ID with success/failure
   feedback.
10. **Stated point of view exists.** There is a linkable, second-person "how this works /
    your-data principles" page, reachable from Home, in the product's own voice — such that a
    reviewer would be comfortable showing the console to a friend as a *designed* product.
