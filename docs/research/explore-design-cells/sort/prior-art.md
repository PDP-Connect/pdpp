# Rich sort — prior art (on disk, product-specific)

Cell: **rich sort** for Explore. Question the recipe forces: *single-key vs multi-key/stacked is
decided BY prior art, not a preset I pick.* Below is the evidence, with real URLs, the canonical
reference, the named anti-pattern, and the honest answer to "how far."

---

## The five products

### GitHub — issues / PR list (the closest analog to a consumer feed)
URL: https://docs.github.com/en/issues/tracking-your-work-with-issues/filtering-and-searching-issues-and-pull-requests
(verified 2026-06-23, section "Sorting issues and pull requests")

- ONE **Sort dropdown** above the list. Options: *Newest created · Oldest created · Most commented ·
  Least commented · Newest updated · Oldest updated · Most-reacted.*
- **Single-key, single menu.** No stacked sort. No drag-to-reorder sorts. No per-key direction picker
  separate from the option (direction is baked into the labeled option — "Newest" vs "Oldest").
- "To clear your sort selection, click **Sort → Newest**." Sort has a **canonical default** (Newest)
  and clearing returns to it.
- Sort is **separate from filter** — the filtered set is the same; only the order changes.

**Why it's the canonical reference here:** GitHub's issue list is a scannable, cross-author,
time-anchored feed with a stable default ordering and a small set of *labeled, direction-baked* sort
options in one dropdown. That is exactly Explore's shape (a cross-source record feed), and it is
unambiguously **single-key**.

### Linear — issue list / board (Display options)
URL: https://linear.app/docs/display-options (section "Ordering")
URL: https://linear.app/changelog/2022-08-18-board-ordering

- Ordering lives in **Display options** (top-right). Order issues *within their groupings* by a
  single property: **Status, Manual, Priority, Last created, Last updated, Due date, Link count.**
- "You can also **reverse** the sort order … except when sorting manually." → one key + a reverse
  toggle, NOT a stack of keys.
- The board-ordering changelog shows the menu as a **single radio list** ("the new board ordering
  menu, with Priority selected") — pick ONE.
- The only "second key" is implicit: when ordered by Priority you may *drag* to fine-tune within a
  priority band. That secondary key is **manual drag** (a domain affordance for a workspace's shared
  triage), not a user-built sort stack — and it is N/A for a read-only personal-data feed.
- Sort key is independent from **group-by** (a separate axis). Linear separates *group* (sectioning)
  from *order* (within-section sort); it does not stack two sort keys.

**Takeaway:** Linear, the canonical "feels like a product" reference, is **single sort key + reverse**,
with grouping as an orthogonal axis. No multi-key stacked sort in the issue list.

### Airtable — grid view (Sort panel)
URL: https://support.airtable.com/docs/sorting-records-in-airtable-views
URL (API): https://support.airtable.com/docs/airtable-web-api-using-filterbyformula-or-sort-parameters

- DOES expose **multi-level stacked sort**: click **Sort** → pick a field → choose direction (the
  options are field-type-aware: text A→Z/Z→A, number 1→9/9→1, date earliest→latest, checkbox ▢→✓) →
  **"Add another sort"** for additional keys → **drag handles** to reorder the keys (hierarchy =
  key order) → **X** to remove a key.
- Per-field direction labels are *semantic to the type* (not a bare asc/desc) — the user never sees
  "asc" on a date; they see "earliest → latest."
- **API**: `sort[0][field]=Rating&sort[0][direction]=desc`, `sort[1]…` — sign-of stacked array.
- **The honesty gotcha (named anti-pattern #1):** "in almost all cases, sorting in **ascending order
  will place blank values first**." Records with no value for the sort field sort to a position that
  surprises the user; Airtable's own FAQ is a workaround for "blank dates at the end." A field-sort
  over sparse personal data WILL hit empty values, and naive asc/desc lies about "earliest."

**Takeaway:** Airtable is the canonical **stacked multi-key** reference — but it is a **power database
table**, where every column is a declared, typed field with full coverage, and the user is a builder.

### Notion — database views (Sort rules)
URL: https://www.notion.com/help/views-filters-and-sorts
URL (API view object): https://developers.notion.com/guides/data-apis/working-with-views

- Database views carry a **`sorts` array** — multiple sort rules, each `{property, direction}`, applied
  in order. The view object literally stores `"sorts": [{ "property": "Last ordered", "direction":
  "descending" }]` and is an ordered list → **stacked multi-key**, saved on the view.
- Sort is a *property of a saved view* (alongside filter, group_by, configuration) — the multi-key
  power lives inside a **named, persisted view**, not as an ephemeral feed control.

**Takeaway:** Notion = stacked multi-key, **but bound to a saved view** (a power-table construct), and
every sort key is a **declared database property** with a known type.

### Stripe — dashboard transaction lists
URL: https://docs.stripe.com/dashboard/basics (Transactions, Reporting)

- Dashboard lists (Transactions, Payments) are **filter-first**; sort is column/recency oriented, not a
  user-assembled multi-key stack. Deep multi-key analysis is pushed to **Sigma (SQL)** / Reports, NOT
  the consumer list UI.

**Takeaway:** Stripe keeps the *consumer list* simple (filter + recency/column sort) and sends true
multi-key/arbitrary-field sorting to a separate analytical surface. A consumer feed does not carry a
power-table sort stack.

---

## The honest answer to "how far" (cite-backed, not assumed)

> **Single-key sort is the SLVP norm for a consumer record FEED. Stacked multi-key sort is a
> power-TABLE affordance, reserved for grid/database surfaces where every column is a declared, typed,
> fully-covered field and the user is a builder operating a saved view.**

Evidence for single-key as the feed norm:
- **GitHub** issue feed: one Sort dropdown, single key, direction-baked options, canonical default. ✓
- **Linear** issue list: single ordering key + reverse; grouping is a separate axis; no sort stack. ✓
- **Stripe** consumer list: recency/column sort; multi-key pushed to SQL. ✓

Evidence that stacked is a power-table thing, not a feed thing:
- **Airtable** stacked sort lives in a **grid view** (typed columns, "Add another sort", drag-reorder). ✓
- **Notion** `sorts[]` array is a property of a **saved database view** with declared properties. ✓

This converges with a HARD platform fact (see `prior-art` companion in the audit, verified in
`reference-implementation/server/records.js:928-972` and `postgres-records.js:150-174`): the PDPP read
server only advertises **one** sortable field per stream — the stream's declared **cursor_field** —
and **multi-key sort is explicitly not implemented** (`records.js:942`). A non-cursor field is rejected
with a typed `invalid_sort`. So even if we WANTED Airtable-style stacked field-sort, the data layer
honestly cannot honor it today, and a personal-data feed should not pretend otherwise.

**Verdict for the design: single-key sort.** A small, labeled, direction-baked sort control over the
record feed (GitHub/Linear pattern), where the *only* offered keys are those the data DECLARES as
sortable (today: the time the records are ordered by, in either direction; plus search's
relevance/recency lens which is descriptor-gated). NOT a user-assembled multi-key stack.

---

## Named anti-patterns to avoid (each cite-backed)

1. **Asc-blanks-first lie (Airtable).** "Sorting in ascending order will place blank values first."
   Over sparse personal data, an `oldest`/ascending sort that silently floats no-value or no-time
   records to the top misrepresents "earliest." → If a record has no value for the sort key, its
   position must be honest (declared/grouped, never silently interleaved as if it had the extreme
   value). For Explore today this is bounded because the only sort key is the declared time field and
   the feed already excludes time-less streams (`explorer-utils.ts:652`: "Streams without a declared
   time field are excluded").

2. **Stacked-sort theatre.** Offering an Airtable/Notion multi-key stack the server can't honor
   (`invalid_sort` on the 2nd key, or on any non-cursor field) — a control that looks powerful and
   does nothing or errors. The owner's Part-0 trap: "a control that's broken, ignored, or useless."

3. **Name-guessed field sort (the cardinal sin).** "There's a field called `amount`/`price`, so add a
   'sort by amount' option." FORBIDDEN — selecting a sort field from a *field name* the connector did
   not DECLARE sortable is exactly the meaning-guessing THE-LENS Gate 1 bans. Only a server-declared
   sortable field (cursor_field today; `x_pdpp_role: amount` is a *presentation* role, NOT a sort
   declaration — see canonical-state check) may ever back a sort option.

4. **Sort that changes membership (NN/g).** Sort must reorder the SAME set; it must never add/drop
   records or shrink/grow the count. URL: https://www.nngroup.com/articles/filters-vs-facets/ — sort vs
   filter are distinct operations; conflating them is a usability + honesty break (count==reachability).

5. **Ordering an unordered set (the descriptor lie).** A `relevance_bounded` ranked sample cannot
   honestly claim "newest first" in-set — the live code already guards this
   (`explore-canvas.tsx:1175`, descriptor-gated). Any new sort control must inherit that guard, never
   bypass it.

---

## Canonical reference (one line)
**GitHub's single Sort dropdown over the issue feed** — one labeled, direction-baked, single-key sort
with a canonical default — is the SLVP pattern Explore's feed should match; Linear corroborates
(single key + reverse, grouping orthogonal). Airtable/Notion stacked sort is explicitly OUT of scope
for the feed (power-table only, and unsupported by the read server).
