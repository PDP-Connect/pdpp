# Explore: Filter Rail + Operator Language — SLVP prior art (2026-06-22)

Research question: How do SLVP-grade products present a FILTER RAIL of many facets (sources,
types, tags) AND a typed query/operator language together without confusing users about how the
two relate? Covers: (1) many filter values without an overwhelming wall, (2) legible count
badges, (3) rail↔query relationship (one unified model vs two systems), (4) invert/exclude UX.

## Findings (each tied to a named product/design system)

### F1 — Linear: facet click and typed query are ONE model; the menu shows match counts and is searchable
- "You'll see a menu of filters that you can apply to the current view **along with the number of
  matching issues**. Once you've opened the filter menu, you can move through the menu or use
  **free text search** to find the exact filter you need." → search-within-filters + per-option counts.
- Every selection becomes an editable filter "formula" pill: for `Assignee is Andreas`, clicking
  `is` switches the operator to `is not`; adding a second value auto-changes `is` → `is either of`
  / `is not`. Operators: `is / is not` (one value), `is either of / is not` (many),
  `includes any / all / neither / either / none` (labels & links), `before / after` (dates).
- Negation has no separate UI: "To filter for **no labels**, select all labels and switch the
  operator to **does not include**." Exclusion = same chip, flipped operator.
- Advanced filters add AND/OR + nested groups; plain filters are the unified default.
- Source: https://linear.app/docs/filters

### F2 — Datadog: facet panel and query bar are two views of ONE query, kept in sync bidirectionally
- "The search bar provides the most comprehensive set of interactions... for many cases, the facet
  panel is a more straightforward way to navigate. **The search bar and URL automatically reflect
  your selections from the facet panel**" — and editing the bar reselects facets.
- Clicking a facet writes `key:value` (e.g. `type:api`); a 2nd value of the same facet writes
  `type:("api" OR "api-ssl")`; values from different facets join with a space (AND):
  `type:api region:aws:us-east-2`. So rail clicks AUTHOR the operator language verbatim.
- Qualitative facets list "a count of logs matching each" value; measures get a min/max slider.
- 2025 search bar: syntax highlighting (keys vs values vs free text vs control chars), error
  validation (missing value, unclosed paren), autocomplete "in the order they appear in the facet
  panel," values "in descending order by log count from the past 15 minutes."
- Sources: https://docs.datadoghq.com/logs/explorer/facets/ ,
  https://docs.datadoghq.com/logs/explorer/search_syntax/ ,
  https://docs.datadoghq.com/synthetics/search/

### F3 — GitHub: the sidebar is literally a query-builder; selections write search qualifiers
- "As you choose the data to view, **the filters shown in the search text box are updated
  accordingly**." Sidebar label → `label:"in progress"`, type dropdown → `type:"Bug"`,
  state → `is:open`, author → `assignee:@octocat`.
- Multiple selections join with implicit AND (a space). The 2026-GA advanced UI adds explicit
  `AND`/`OR`, parentheses for nesting, and live qualifier/value suggestions + warnings.
- Invert/presence: prefix `-` negates ANY filter or combination; `has:`/`no:` test
  presence/absence and can themselves be negated with `-`.
- Sources: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests ,
  https://github.blog/changelog/2026-04-02-improved-search-for-github-issues-is-now-generally-available/

### F4 — Sentry: facet map (rail) clicks edit the same token query; counts are result-scoped, not total
- The right-rail "tag summary (facet map)" is "a visualization of the **top 10 keys sorted by
  frequency**," each bar showing the most common value's % ; "**Click on any of these sections to
  further refine your search**" → adds e.g. `browser:Chrome` to the token query.
- Query is `key:value` tokens (`is:resolved`, custom tag `server:web-8`) + optional raw text;
  negation is the `!` operator (`!user.email:example@customer.com`), combinable with `*` wildcards.
- COUNT SEMANTICS (decisive): on issue details, "the event and user counts represent the counts
  **given the search, environments, or time period selected** above. This is **different from the
  counts in the header which are the total counts across the lifetime of the issue**." → leading
  products explicitly distinguish result-set count vs total, and label them differently.
- 2025 redesign: "Organized Filters" categorized menu, smarter key/value suggestions, search
  history, full mouse+keyboard.
- Sources: https://docs.sentry.io/product/issues/issue-details/ ,
  https://docs.sentry.io/concepts/search/ , https://sentry.io/changelog/improved-search-ui/

### F5 — Facet counts: consensus is DYNAMIC, result-scoped counts; never leave 0-count clickable
- Counts speed decisions ("Leather (24)", "Canvas (9)") and "should update dynamically as other
  filters are applied" — if "Nike" is selected, color counts reflect only Nike. `Blue (47)` sets a
  true expectation; `Blue (0)` warns of a dead end.
- Zero-count handling splits two ways, both valid, never "clickable dead end": Google says
  **grey out / disable** ("with zero items, grey out filtering options"); Elasticsuite/Doofinder
  say **hide / show-only-non-empty** via a coverage threshold. Empty-result moments are the single
  most damaging in search (Baymard: ~69% abandon).
- Sources: https://developers.google.com/search/blog/2014/02/faceted-navigation-best-and-5-of-worst ,
  https://www.brokenrubik.com/blog/faceted-search-best-practices ,
  https://baymard.com/ (faceted/empty-results research, cited via brokenrubik/doofinder)

### F6 — Many values without a wall: parent→child scoping + collapsible groups + search-in-filter
- Linear: "To filter by milestones, **filter by project first**" — a parent narrows the child set
  instead of showing every milestone flat (source→stream analog).
- Notion advanced filters: nested **filter groups** mix AND/OR, UI nesting up to 3 levels; turn any
  filter into a group via `•••` → "Add to advanced filter."
- Airtable: grouping makes "neat, **collapsible** sections"; with many groups, right-click header →
  "Collapse all," or add a dropdown/tabbed filter to navigate rather than scroll a flat list.
- Sources: https://linear.app/docs/filters ,
  https://www.notion.com/help/guides/using-advanced-database-filters ,
  https://support.airtable.com/docs/grouping-records-in-airtable

### F7 — Chips are the single unified surface for state; one "Clear filters" regardless of source
- PatternFly: every selection "will always show up as a **chip**"; chips "are used as a way for
  users to view all their selections when the menu... is collapsed"; "Clear filters" sits after
  the last chip and resets the toolbar to one row. Material 3: "do not display a single chip by
  itself — chips should appear in a set"; chips are dismissible (the `×` removes that one filter).
- Sources: https://www.patternfly.org/2022.11/guidelines/filters/ ,
  https://m3.material.io/components/chips/guidelines

## Consensus pattern (what SLVP-grade products converge on)

1. **One model, two surfaces.** The clickable rail/facet panel and the typed operator language are
   NOT separate systems — the rail is a query-BUILDER. Clicking a facet writes the equivalent
   operator/chip into a single shared query (Datadog `key:value`, GitHub qualifiers, Sentry tokens,
   Linear formula pills). Editing the query reselects the rail. The chip row is the one canonical
   view of active state. This is how they dodge "confused about filters vs operators": there is only
   one thing, shown two ways, always in sync (URL-encoded).
2. **Counts are result-scoped and dynamic**, recomputed against the CURRENT query, and visibly
   distinguished from lifetime/total counts (Sentry states this explicitly). Per-option counts live
   in the menu (Linear "number of matching issues", Datadog per-value log counts).
3. **0-count options are never live dead-ends** — grey-out/disable (Google) or hide via
   show-only-non-empty threshold (Elasticsuite). Never silently shrink to nothing.
4. **Many values are tamed by**: free-text search-within-the-filter-menu (Linear, Datadog
   autocomplete, Sentry), parent→child scoping (Linear project→milestone), collapsible/grouped
   sections with collapse-all (Airtable), and top-N-by-frequency-then-more (Sentry top-10 facet map,
   Datadog descending-by-count).
5. **Inversion is the same chip with a flipped operator**, not a separate negative UI: Linear `is`→
   `is not` / `does not include`, GitHub `-`/`no:`, Sentry `!`, Datadog OR-grouping + exclusion.

## RECOMMENDATION for Explore's source/stream rail + con:/stream: operators

Treat the rail and the `con:`/`stream:` operators as ONE query, two surfaces — do NOT ship them as
parallel mechanisms.

1. **Make the rail author operators (unify, don't relate).** Clicking a source writes `con:<key>`;
   clicking a stream writes `stream:<key>`; both immediately render as a removable chip in the same
   query input the user can also type into. Typing `stream:` reselects the rail row. This mirrors
   Datadog/GitHub/Linear exactly and is the single highest-leverage move against the
   "filters-vs-operators confusion." The chip row is the source of truth; the rail is just a faster
   way to add to it.
2. **Group streams under their source (parent→child), collapsible, search-within.** For 70+ stream
   names, never show a flat wall. Render `source → its streams` as collapsible sections (Airtable),
   default-collapse, with a "search streams" box in the rail header (Linear/Datadog). Selecting a
   source first narrows the stream set (Linear's project→milestone pattern). Optionally top-N
   streams-by-record-count then "Show all N" (Sentry top-10).
3. **Counts = matching records in the CURRENT result set, recomputed dynamically, and labeled so
   they're not opaque.** A bare `(12)` is ambiguous; follow Sentry's explicit split — the facet
   count is result-scoped ("12 in current results"), and if you also surface a lifetime/total it
   must be visibly distinct (tooltip "12 of 340 total" or a muted secondary number). Counts must
   honor active chips (selecting `con:github` makes stream counts reflect only GitHub records). This
   directly serves PDPP's count==reachability invariant: the badge is exactly what clicking yields.
4. **0-record streams: disable or hide, never a live dead-end.** Grey-out streams with 0 matches in
   the current result set (Google) or hide them behind "show empty streams" (show-only-non-empty,
   Elasticsuite). This prevents the most damaging UX moment (clicking into nothing) and keeps the
   count-as-promise honest.
5. **Exclusion is the same chip flipped, not a new control.** Support `is-not` by letting a selected
   source/stream chip toggle to `-con:`/`-stream:` (GitHub `-`, Sentry `!`, Linear `is not`). One
   affordance — click the operator on the chip — covers include and exclude; no separate "exclude"
   rail.

Net: a collapsible source→stream rail with result-scoped, reachability-honest counts, whose every
click writes/edits the same `con:`/`stream:` operator chips the user can type — one model, two
surfaces, in sync via the URL — is the SLVP-convergent answer and removes the filter/operator
ambiguity by construction.

## Sources
- https://linear.app/docs/filters
- https://docs.datadoghq.com/logs/explorer/facets/
- https://docs.datadoghq.com/logs/explorer/search_syntax/
- https://docs.datadoghq.com/synthetics/search/
- https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests
- https://github.blog/changelog/2026-04-02-improved-search-for-github-issues-is-now-generally-available/
- https://docs.sentry.io/product/issues/issue-details/
- https://docs.sentry.io/concepts/search/
- https://sentry.io/changelog/improved-search-ui/
- https://www.notion.com/help/guides/using-advanced-database-filters
- https://support.airtable.com/docs/grouping-records-in-airtable
- https://www.patternfly.org/2022.11/guidelines/filters/
- https://m3.material.io/components/chips/guidelines
- https://developers.google.com/search/blog/2014/02/faceted-navigation-best-and-5-of-worst
- https://www.brokenrubik.com/blog/faceted-search-best-practices
- https://baymard.com/blog/faceted-sorting
