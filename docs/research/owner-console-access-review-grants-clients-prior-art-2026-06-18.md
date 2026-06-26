# Access Review / Grants / Clients — Prior Art (Lens 6)

Date: 2026-06-18
Owner: RI owner
Status: Net-new prior-art research deepening the **access-review** dimension of the
owner console redesign.
Why this note exists (and what existing doc it extends): This note **extends Part 2 of**
`explorer-workbench-and-access-transparency-prior-art-2026-06-18.md` (which established
the Google / GitHub OAuth / Plaid-consent basics and the list → per-app detail → activity
hierarchy). It does **not** re-derive that hierarchy; it goes deeper on two things that
doc only sketched:

1. The **grant/package hierarchy** — how leading products structure "what a client can
   read" as a per-resource, graded scope matrix (not a flat token), so PDPP's "one grant
   shown for a 19-grant package" and "internal source path leaked into the package" bugs
   have a principled target shape.
2. The **CAPABILITY vs ACTIVITY split** — products keep "what this client *can* read"
   (the grant) strictly separate from "what this client *actually* read / last used" (the
   access log), and surface both. PDPP today can answer neither cleanly, which is why the owner
   could not answer "what does ChatGPT have access to?" or "what did ChatGPT read?"

This note also aligns with the internal design contract `A5. Access, grants, reads, and
clients` already written into `Design: Owner Console Product Experience` (Appendix A) —
this note is its prior-art backing.

---

## 1. Prior-art sources (each with URL + retrieval date + observed pattern)

### Google — "Manage links between your Google Account & apps"
URL: <https://support.google.com/accounts/answer/13533235> (retrieved 2026-06-18)
Live surface: <https://myaccount.google.com/connections> (retrieved 2026-06-18; the page
itself is auth-gated so only the connections IA is observable unauthenticated)

Observed pattern (verbatim-anchored):
- The front door is a single **linked-apps list** at `/connections`, **grouped by app**.
  The same support page documents **two directions** of link, each with its own fixed
  phrasing template: an app reading the owner's Google data appears under *"{App name} has
  some access to your Google Account"*, while Google reading the linked app appears under
  *"Google has some access to your {app name} account."* The **PDPP-relevant direction is
  the former** (an external app reading the owner's data), so the citable disambiguation
  string here is *"{App name} has some access to your Google Account."* Either way Google
  **collapses multiple link types of the same app into one app row**, then expands them
  inside the app's detail — exactly the grouping object PDPP gets wrong.
- The per-app detail uses that fixed phrasing template — for the owner's-data-being-read
  direction, *"\[app name\] has some access to your Google Account"* — then a **"See
  details"** affordance that lists the concrete access, then **"Delete link" → "Confirm"**
  as the terminal action.
- Removal carries an explicit, plain-language **consequence statement**: *"If you delete
  this link, Google loses access to your account on the app. You won't have access to
  features that require this link on any device where you're signed in."*

### Google — "See devices with account access" (the activity counterpart)
URL: <https://support.google.com/accounts/answer/3067630> (retrieved 2026-06-18)

Observed pattern:
- Distinct from the *capability* surface above, Google maintains an **activity / recent-use
  surface** (`google.com/devices`) framed around *"where you are or were signed in …
  recently"* and *"make sure no one else has signed in."* The job is **audit of actual
  use**, not configuration of permission. Google keeps these two surfaces separate and
  cross-links them. This is the canonical CAPABILITY-vs-ACTIVITY separation.

### GitHub — "Reviewing and revoking authorization of GitHub Apps"
URL: <https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps> (retrieved 2026-06-18)
(Same content served at the legacy `/reviewing-your-authorized-integrations` path.)

Observed pattern:
- *"You can review the GitHub Apps that you have authorized, and you can revoke your
  authorization."* The surface's stated purpose is **review then revoke** — revocation is
  the primary verb, consistent with the OAuth-apps list already cited in the prior doc.

### GitHub — "Reviewing and modifying installed GitHub Apps" (capability granularity)
URL: <https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps> (retrieved 2026-06-18)

Observed pattern:
- *"When you install a GitHub App, you grant the app the organization and repository
  permissions that it requested. If the app requested repository permissions, you also
  specify which repositories the GitHub App can access."* — capability is **two-axis**:
  *what kind of permission* × *which specific resources (repos)*.
- *"You can review the permissions that you granted and change the repositories that the
  GitHub App can access. If you no longer use an app, consider suspending or deleting…"* —
  a non-destructive **suspend** sits beside delete (a softer revoke), and **the resource
  set is editable after the fact** (you can narrow which repos), not only all-or-nothing.

### GitHub — Fine-grained personal access tokens (the per-resource scope matrix)
URL: <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens> (retrieved 2026-06-18)

Observed pattern (the strongest prior art for a **graded per-resource scope matrix**):
- A fine-grained token is defined by a **resource target** (an owner whose repos the
  token can touch) plus a **per-permission access level**. From the docs' URL-parameter
  table: *"Permissions can be set to `read`, `write`, or `admin`, but **not every
  permission supports each of those levels**."* — i.e. the access matrix is **typed per
  resource**; some resources are read-only by nature.
- The **Account permissions** table enumerates dozens of resources each with its allowed
  levels, e.g. `emails` → `read, write`; `user_events` (Events) → `read`; `profile` →
  `write`; `plan` → `read`; `followers` → `read, write`. The key shape: **one row per
  resource, the cell is the chosen access level, and the *available* levels are
  constrained by the resource type.** A resource the token does not name is simply absent
  (= no access).
- Tokens also carry an **expiration** (default 30 days; non-expiring allowed but
  org-policy-blockable) — capability is **time-bounded**, a first-class field.

### Stripe — API keys (standard vs restricted)
URL: <https://docs.stripe.com/keys> (retrieved 2026-06-18)

Observed pattern:
- Stripe distinguishes **standard keys** (full read/write) from **restricted keys**, which
  exist specifically so a credential can be **least-privilege scoped per resource**.

### Stripe — Best practices for managing secret API keys (restricted-key scoping)
URL: <https://docs.stripe.com/keys-best-practices> (retrieved 2026-06-18)

Observed pattern (the per-resource scope grid — the cleanest version of a capability grid
in the corpus):
- The fetched best-practices page states the **least-privilege principle in prose**:
  create **restricted keys that grant only the specific permissions the integration
  needs**, scoping access **per resource** and preferring **read-only** where a write
  level is not required. The literal **None / Read / Write** three-state grid (one cell
  per Stripe resource — Charges, Customers, Invoices, …) is the **Stripe Dashboard
  restricted-key creation UI** *(observed dashboard behavior, not text on this doc page)*;
  the doc page supplies the principle, the Dashboard supplies the grid. The default for an
  unselected resource is **None** (deny-by-default). Together they are the canonical
  "per-resource none/read/write scope matrix" the owner's lens calls out.
- Best-practice framing: a key should be **the minimum scope that still works**, and keys
  are **independently revocable/rollable** so blast radius is contained — capability is
  designed to be *auditable at a glance* (which resources, what level) and *revocable in
  isolation*.

### Plaid — Data Transparency Messaging (DTM)
URL: <https://plaid.com/docs/link/data-transparency-messaging-migration-guide/> (retrieved 2026-06-18)

Observed pattern (the consent-time *concrete-terms* contract that a review surface must
mirror):
- DTM *"provides end users with a greater understanding of the **types of data** that they
  share … a user is informed of the **specific data types** that you are requesting and
  **the reason** that you are requesting them (use cases)."* — capability is presented as
  **(data type × purpose)**, in the user's own terms, not as scope strings.
- Critically for the grant/package model: *"If you want access to **additional data** …
  **or to use the data for additional use cases**, they must consent to sharing that data
  through a **separate consent flow**."* — **each new data type or new purpose is its own
  consent event.** A "package" is therefore an accreting set of discrete, individually
  consented grants — exactly the shape PDPP's 19-child-grant ChatGPT package actually has,
  and the reason collapsing it to "one grant" is dishonest.
- The disclosures render at the **Account Select** pane (which accounts/data) and the OAuth
  handoff — so consent is *per-account* and *per-data-type*.

### Plaid — Portal ("my connections")
URL: <https://my.plaid.com/> (retrieved 2026-06-18)
Observed pattern: Plaid Portal is marketed as *"the convenient way to manage your financial
data"* — a **consumer-facing, per-connection management surface** where the end user (not
the app developer) can see and manage which apps are connected to which financial accounts.
(The post-login connection list is auth-gated; the IA — a per-connection management hub
owned by the data subject — is the citable pattern.)

### Apple — "Manage your apps with Sign in with Apple"
URL: <https://support.apple.com/en-us/102571> (retrieved 2026-06-18; canonical numeric
article URL — verified exact title and quotes). (The legacy `HT210426` redirect form was
not directly confirmed to still resolve, so this note cites only the canonical `102571`.)

Observed pattern:
- A single in-Settings list — **Settings → \[your name\] → Sign in with Apple** — lists
  **the apps/developers you've used Apple ID with**; selecting one shows its detail and a
  **Delete** (stop using) action with on-screen confirmation.
- Consequence is stated plainly: *"When you stop using your Apple Account with an app,
  you're signed out … you might receive an email … that the app has revoked your Sign in
  with Apple account … you have to share your name and email address with the app again."*
  Apple frames the **minimal data shared (name + email)** as the capability, so the owner
  always knows the exact data surface even for the lightest grant.

---

## 2. Observed patterns (cross-source synthesis)

**P1 — The grouping object is the client/app, and multiple grants collapse into it.**
Google explicitly collapses multiple link types of the same app into one app row, then
expands them in detail. Apple lists one row per app/developer. GitHub lists one row per
authorized app. None of these surface a single child grant as if it were the whole — the
app is the noun, the grants are its contents.

**P2 — Capability is a per-resource, graded matrix, deny-by-default.** Stripe (None/Read/
Write per resource — least-privilege principle documented, the three-state grid observed in
the Dashboard restricted-key UI), GitHub fine-grained tokens (read/write/admin per resource, levels
constrained by resource type, unnamed resource = no access), and GitHub Apps (permission ×
which repos) all model "what it can read" as **one row per concrete resource with a graded
cell**, where absence means no access. Free-text scope strings appear nowhere in the
owner-facing layer.

**P3 — Capability and activity are separate, cross-linked surfaces.** Google keeps "apps
with access" (capability) distinct from "devices/recent activity" (what actually
happened). The review job ("is this still right?") and the audit job ("did something read
my data?") are answered by different views with different framings — but both exist.

**P4 — Capability re-presents consent in the *same concrete terms* the owner agreed to.**
Plaid DTM shows data types + purpose at consent; the review surface must echo those, not
translate them into internal nouns. Each new data type / purpose is its own consent event,
so a "package" is an honest accretion of discrete grants.

**P5 — Revocation is the primary verb, with a softer "suspend" where useful, and an
explicit consequence statement.** GitHub ("review … and revoke"; suspend beside delete),
Google ("Delete link → Confirm" + loses-access warning), Apple ("Delete" + email/
re-share consequence). The destructive action is one click from detail, guarded by a
plain-language consequence and a confirm.

**P6 — Capability is time-bounded and independently revocable.** GitHub tokens carry
expiration; Stripe keys are independently rollable; both contain blast radius. "Last used"
/ expiry are first-class, not buried.

---

## 3. PDPP implications (tie to specific surfaces + the owner's complaints)

- **"What does ChatGPT have access to?" (capability) — unanswerable today.** PDPP shows
  "one grant" at the top of the ChatGPT client while the package actually holds ~19
  source-bound child grants. Per **P1/P2/P4**, the ChatGPT client detail must consolidate
  all child grants into **one capability matrix**: rows = sources/streams the client can
  read, cells = graded access (read-only is PDPP's reality, so the column is honest about
  that), bounds = time/change window, and absence = no access. This is the Stripe/GitHub
  matrix applied to PDPP sources instead of Stripe resources or GitHub repos.

- **"What did ChatGPT read?" (activity) — must be a separate, summarized view.** Per
  **P3**, PDPP already has the substrate (the trace/disclosure spine in
  `trace-surface-patterns.md`), but it is currently the *only* path and requires forensics.
  The client detail must **query that spine filtered by `client_id`** and present a
  read-history summary + **last-used / last-read timestamps** as first-class facts —
  Google's "recent activity" counterpart. Owners must never be sent into raw traces to
  answer this.

- **The internal source-path leak into the package is a P4 violation.** A package that
  surfaces an internal/maintenance source path is presenting *package mechanics* where the
  owner expects *the data types they consented to*. The capability matrix must be built
  from owner-consented sources/streams; internal maintenance sources and raw child-grant
  structure are **excluded from the owner-facing scope summary** (matching the A5 contract
  already written: "Internal maintenance sources, package mechanics, and raw grant child
  structure do not replace the owner-facing scope summary").

- **"From the user's perspective it was just a bunch of checkboxes."** Per **P4**, the
  review surface should re-present those checkboxes as the concrete (source × stream ×
  read/none × time-bound) they amounted to — Plaid's "data types + reason" echoed back —
  so the owner can recognize what they agreed to.

- **Revoke-first, with consequence copy.** Per **P5**, "Revoke access" must be the primary
  action on the ChatGPT client detail (and a "Revoke all" / per-grant revoke for the
  package), guarded by a plain-language consequence ("ChatGPT will no longer be able to
  read your … data; existing reads are not recalled") + confirm. PDPP buries revocation
  behind trace forensics today.

- **"Can't tell if I'm looking at a source or a connection."** The access-review surface
  is a *third* noun — the **client/app** — and must be visually and route-named distinct
  from Sources (where data comes from) and Connections (configured ingest). The list is
  "AI apps that can read your data," not a sources or runs list.

---

## 4. Concrete affordance / copy / IA recommendations

**IA — three named surfaces, one hierarchy (client → capability → activity):**
- Route `/clients` (nav label e.g. **"AI app access"** — route name == nav label, fixing
  the "routes named differently than nav" complaint). One row **per client/app**, never
  per grant. Each row shows: client name, **scope summary** ("Reads 4 sources" / "Reads
  Amazon, ChatGPT, …"), **last read** timestamp, status, and a kebab → **Revoke**.
- Route `/clients/[clientId]` — the **capability** view. Header: *"\[ChatGPT] can read"*
  followed by the **capability matrix**:
  - One row per **source/stream** the client can read (consolidated across all child
    grants in the package).
  - A graded access cell — for PDPP today the honest values are **Read** / **No access**;
    leave room for a Write/None column shape so the grid generalizes (mirrors Stripe
    None/Read/Write and GitHub read/write/admin). Resources not granted are **not shown**
    (or shown greyed as "No access"), never omitted silently from the count.
  - Per-row **bounds**: time window / change scope, matching consent.
  - A **provenance line** restating consent terms in the owner's words (Plaid DTM echo),
    not internal source paths.
- A **"What \[ChatGPT] has read"** tab/section on the same detail page — the **activity**
  view: a read-history list filterable by source, stream, and time, with **last-used /
  last-read** pinned at top. This is a *projection of the disclosure spine filtered by
  `client_id`*, presented as a summary, with a "View raw traces" escape hatch for the rare
  forensic case.

**Copy:**
- List row: "Reads {N} sources · Last read {relative time}". If never read: "Granted
  {date} · Not yet read" (an honest activity zero, not silence).
- Capability header: "{Client} can read the following data" — graded, concrete.
- Revoke consequence: "{Client} will immediately lose access to your data. It can't read
  anything new. Data it already read isn't recalled." → **Revoke** / **Cancel**.
- Suspend (optional, GitHub-style softer stop): "Pause access — {Client} can't read until
  you resume. Its grants are kept."

**Capability vs activity must be labeled as such** so the owner never confuses "can read"
with "did read": header words "can read" (capability) vs "has read" (activity).

**Package honesty:** if a client holds a multi-grant package, the detail shows "Granted
across {N} sources" and the matrix expands all of them; "Revoke all" revokes the package,
and each row can be revoked individually (Plaid's per-data-type consent → per-row revoke).

---

## 5. Anti-patterns to avoid

- **A1 — Surfacing one child grant as "the grant."** (Current ChatGPT bug.) Violates
  P1/P4. The client, not a grant, is the row; the matrix consolidates all grants.
- **A2 — Leaking internal/maintenance source paths or raw grant/package nouns into the
  owner-facing scope.** Violates P4 and the A5 contract. Show consented data types, not
  mechanics.
- **A3 — Making the disclosure/trace browser the only way to answer "what did it read."**
  Forces forensics; violates P3. Provide a summarized, client-filtered activity view with
  last-read first-class.
- **A4 — Conflating capability and activity in one ambiguous list** (e.g. showing scope
  rows that look like read events, or "Collected"-style counts that don't say
  capability-vs-activity). Mirrors the owner's "Collected confusing — no change vs new records"
  ambiguity; keep "can read" and "has read" lexically and structurally separate.
- **A5 — Free-text scope strings** ("scope: records:read source:*") as the owner-facing
  capability. No cited product does this; use a graded per-resource matrix.
- **A6 — Revocation buried below detail or behind traces.** Revoke is a primary verb on
  both list and detail (P5), with a consequence statement and confirm.
- **A7 — Wall-of-text scope copy** ("Suppressed evidence. Drain detail gap backlog"). The
  matrix is the explanation; prose is one plain sentence of consequence, not a paragraph.

---

## 6. Acceptance checks (owner-walkable, testable)

1. From the nav, an owner can reach a surface whose **route name matches its nav label**
   and that lists **AI apps/clients**, one row per client (not per grant). Assert: ChatGPT
   appears exactly **once** even though its package holds multiple child grants.
2. Opening the ChatGPT client shows a **capability matrix**: every source/stream it can
   read is a row with a graded access cell; the **count of sources in the header equals the
   number of consolidated rows** (no "1 grant" while 19 exist).
3. The capability view contains **no internal/maintenance source path** and **no raw
   grant/package id** in owner-facing text; scope is stated as owner-consented data types.
4. The page has a clearly **separate "has read" (activity) section** that lists reads
   filterable by source/stream/time and shows a **last-read timestamp**; for a client that
   never read, it explicitly says "Not yet read" rather than showing blank.
5. The owner can answer **"what does ChatGPT have access to?"** from the capability view
   alone and **"what did ChatGPT read?"** from the activity view alone — neither requires
   opening raw traces.
6. **Revoke** is reachable in one click from both the client row (kebab) and the client
   detail, shows a **plain-language consequence + confirm**, and (where modeled) a softer
   **suspend/pause** exists beside it.
7. Capability uses the words **"can read"** and activity uses **"has read"** (or
   equivalents) — a reviewer can confirm the two are never lexically merged.
8. Revoking the package removes the client from the list; revoking a single row narrows the
   matrix and updates the header count (per-grant granularity preserved, Plaid-style).

---

## Sources
- Google — Manage links between your Google Account & apps — <https://support.google.com/accounts/answer/13533235> (2026-06-18)
- Google — Connections (live IA) — <https://myaccount.google.com/connections> (2026-06-18)
- Google — See devices with account access (recent activity) — <https://support.google.com/accounts/answer/3067630> (2026-06-18)
- GitHub — Reviewing and revoking authorization of GitHub Apps — <https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps> (2026-06-18)
- GitHub — Reviewing and modifying installed GitHub Apps — <https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps> (2026-06-18)
- GitHub — Managing your personal access tokens (fine-grained per-resource permissions) — <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens> (2026-06-18)
- Stripe — API keys (standard vs restricted) — <https://docs.stripe.com/keys> (2026-06-18)
- Stripe — Best practices for managing secret API keys (prose: least-privilege, per-resource read-only scoping; the literal None/Read/Write grid is the Dashboard restricted-key UI, observed behavior) — <https://docs.stripe.com/keys-best-practices> (2026-06-18)
- Plaid — Data Transparency Messaging migration guide (data type × purpose, per-consent) — <https://plaid.com/docs/link/data-transparency-messaging-migration-guide/> (2026-06-18)
- Plaid — Portal "my connections" (consumer-facing connection management) — <https://my.plaid.com/> (2026-06-18)
- Apple — Manage your apps with Sign in with Apple — <https://support.apple.com/en-us/102571> (2026-06-18)
- Internal: `explorer-workbench-and-access-transparency-prior-art-2026-06-18.md` (Part 2 — extended here)
- Internal: `Design: Owner Console Product Experience`, Appendix A §A5 "Access, grants, reads, and clients" (contract this note backs)
