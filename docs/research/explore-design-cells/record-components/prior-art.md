# Prior art: one shared record/row primitive across table + feed + peek + detail

**Research question.** For PDPP "Explore," the SAME personal-data record must render identically across a list-table view, a feed/timeline view, a peek panel, and a full detail page — via SHARED reusable components from a common brand/design-system package, not separate raw render paths that can drift. This file captures how Linear, Stripe, Airtable, Notion, and GitHub (Primer) solve the same problem, with real citable sources and named patterns/anti-patterns.

All quotes/specifics below are from the cited canonical pages (fetched 2026-06-23).

---

## TL;DR — the one pattern to adopt

**Adopt Airtable's + Notion's field-type cell-renderer registry, expressed in code with GitHub Primer's `DataTable` column-definition API (`field` + `renderCell`) over a headless record model.**

That is: a **single record model** (one normalized record object with typed fields) feeds **one registry of per-field-type cell renderers** ("how does a `currency` / `date` / `linked-record` / `select` field draw itself"). Every surface — table, feed, peek, detail — consumes the SAME registry. The *surface* only owns layout chrome: the **table** owns sortable columns + density + frozen columns; the **feed** owns day-grouping + timeline ordering; the **peek/detail** own which fields show and at what size. None of them re-implements value formatting.

This is the convergent answer because two independent products (Airtable, Notion) ship exactly this — a field/property *type* owns its rendering, and a *view* is just a layout config that selects/orders/sizes those same field renderers — and because Primer's `DataTable` gives a concrete, copyable code shape for it (`columns[].field` for the default renderer, `columns[].renderCell(row)` for a custom one). Linear (one issue object across list/board/timeline/split) and Stripe (Sail components reused across dozens of surfaces) corroborate the *organizational* discipline but publish less mechanism.

**Best single fit:** Notion's `view` model — "a view defines how pages in [a] data source are filtered, sorted, and displayed," while the per-property display config (`status_show_as`, `date_format`, `card_property_width_mode`) is keyed by property *type* and reused identically across `table | board | gallery` — is the cleanest published statement of "shared record primitive, surface-specific layout only."

---

## Per-product findings

### Notion — `view` is a layout config over a shared data source; property *type* owns rendering

- **Canonical ref:** https://developers.notion.com/guides/data-apis/working-with-views (Views API, version `2025-09-03`+) and https://www.notion.com/help/intro-to-databases
- **Pattern name:** **"property-type renderer + view-as-configuration."** One data source = one set of pages (records). A `view` object is *only* a filter/sort/display config layered on top: `{ "type": "table" | "board" | "gallery" | "list" | ..., "configuration": { "properties": [{property_id, visible, width}], "group_by": {...} } }`.
- **What's shared (record primitive):** the **page** and its **properties**. Crucially, *how a property renders* is keyed by property type and travels with the field across every view. From the Views API property-config table:
  - `status_show_as: "select" | "checkbox"` — how a status property displays
  - `date_format: "full" | "short" | "month_day_year" | "relative" | ...` and `time_format: "12_hour" | "24_hour" | "hidden"` — date rendering config carried by the date property
  - `card_property_width_mode: "full_line" | "inline"` — how a property draws in board/gallery cards specifically
  - This is a **cell-renderer registry keyed by property type**: the date field knows how to draw itself; table, board, and gallery all consume the same renderer and only differ in layout config.
- **What's surface-specific:** `width` ("table views only"), `frozen_column_index`, `show_vertical_lines`, `wrap_cells` (table chrome); `group_by`, `cover`, `card_layout: "compact"`, `cover_size` (board/gallery chrome). "Linked database" / linked views explicitly exist "for showing the same underlying data in multiple places."
- **Anti-pattern avoided:** **per-view re-formatting.** Notion never lets a board card format a date differently from a table cell — the date *property* owns its format, so the value can't render two ways. The view only chooses visibility, order, width, grouping.

### Airtable — field *type* is the renderer; record-detail layout reuses the same fields as List/Grid/Gallery/Kanban/Timeline

- **Canonical refs:**
  - Views: https://www.airtable.com/guides/build/create-custom-views-of-data — "Grid view displays data as a series of rows and columns, with each record a row, and each field a column."
  - Field types: https://support.airtable.com/docs/supported-field-types-in-airtable-overview
  - Record detail: https://support.airtable.com/docs/airtable-interface-layout-record-detail
- **Pattern name:** **"field-type cell renderer reused across grid + record-detail + gallery + kanban + timeline."** A *field* (its type) is the single source of truth for how a value is entered and displayed; every layout reuses that field's renderer.
- **What's shared (record primitive):** the table's fields and their type-driven rendering. The record-detail layout is built from the *same fields* as every other view — "By default, the primary field for the record is used as the title," and the detail page's **Fields** section just selects/orders/hides those existing fields (deleting one "removes it from the record detail page not from the underlying source table"). A single-select field's renderer is reused everywhere; on a detail page it can switch *appearance* (Field / Stepper / List) without changing the underlying field — i.e., one renderer, surface-tunable appearance.
- **What's surface-specific:** Grid = rows/columns/density/sort; Gallery = cover image, "one record at a time"; Timeline = horizontal swimlanes grouped "by any of your table's fields"; Kanban = grouping. Capabilities differ per surface (e.g. "Only List and Grid currently support unlinking. Gallery, Kanban, and Timeline allow linking only"), but the *field renderer* is constant.
- **Anti-pattern avoided:** **detail-view re-implementing its own field formatting.** The detail page can't invent a new currency/date/select renderer; it draws from the same field-type system, so grid and detail agree by construction.

### GitHub / Primer — `DataTable` column-defs (`field` / `renderCell`) + `ActionList.Item` slot primitive; both built on `useSlots`

- **Canonical refs:**
  - https://primer.style/components/data-table (experimental `DataTable`)
  - https://primer.style/components/action-list (`ActionList` — "ready")
  - https://primer.style/product/getting-started/react/extending-components/ (the `useSlots` slot system that powers both)
- **Pattern name(s):**
  1. **"column definition with a shared cell render fn."** `DataTable` takes `data` + `columns[]`; each column is `{ header, field?, renderCell? }`. `field: ObjectPaths<Data>` ("the key of the object or a string that accesses nested objects through `.`") gives the *default* renderer; `renderCell: (data: Data) => React.ReactNode` overrides it ("provide a custom component or render prop to render the data for this column in a row"). `rowHeader: boolean` marks the identity column. Real example:
     ```tsx
     columns={[
       { header: 'Repository', field: 'name', rowHeader: true },
       { header: 'Type', field: 'type' },
       { header: 'Updated', field: 'updatedAt',
         renderCell: row => <RelativeTime date={new Date(row.updatedAt)} /> },
     ]}
     ```
     `sortBy: boolean | 'alphanumeric' | 'datetime' | ((a,b)=>number)` lives on the *column def*, not the cell — so sorting (a table concern) is separable from rendering (a shared concern).
  2. **"single compound `ActionList.Item` primitive."** A list row is one item primitive with named slots: `ActionList.LeadingVisual`, `ActionList.TrailingVisual`, `ActionList.Description`. The *same* `ActionList` is reused inside `ActionMenu` overlays, etc. (the DataTable row-actions example nests `<ActionList>` inside `<ActionMenu.Overlay>`).
  3. **`useSlots` (the deeper primitive).** Both patterns sit on one mechanism: "When a Primer compound component receives children, it walks them once and matches each against a config of `{slot-name: Component}`... The same matching applies whether the parent is `ActionList.Item`, `FormControl`, `Dialog`, `PageLayout`, or `PageHeader`." So the *visual primitive* (a slotted item: leading visual + body + trailing visual + description) is genuinely shared across many containers.
- **What's shared vs surface-specific:** shared = the cell renderer (`renderCell`) and the slotted item primitive. Surface-specific = `DataTable` owns columns/sort/`align`/`width: 'grow' | 'auto'`/pagination; `ActionList` owns vertical single-column list semantics.
- **Honest caveat:** Primer does **not** publish a *single* primitive that `DataTable` rows and `ActionList` items literally share at the leaf — `DataTable` is a separate (experimental) component from `ActionList`. They share the **`useSlots` mechanism and design tokens**, and `renderCell` is the seam where you *plug in* a shared cell renderer. Primer gives you the *API shape* to enforce "one cell renderer," not a finished shared row leaf.
- **Anti-pattern avoided:** **inline ad-hoc cell formatting.** Primer pushes formatting into a `renderCell` function (a reusable unit, e.g. `<RelativeTime/>`) instead of hand-formatting strings per column, so the same renderer can be lifted out and reused by a detail view.

### Linear — one issue object across list / board / timeline / split / fullscreen

- **Canonical ref:** https://linear.app/now/how-we-redesigned-the-linear-ui (Karri Saarinen / Yann-Edern Gillet, "How we redesigned the Linear UI (part Ⅱ)")
- **Pattern name:** **"one structured-layout system, many displays."** "Linear relies on a set of structured layouts that support the navigation elements and content... as well as the actual display: **list, board, timeline, split, and fullscreen.**" The redesign worked "by type of view (list, board, split, etc.)" to "ensure that every decision worked in all cases" — i.e., a shared design substrate validated across every surface so the issue renders consistently.
- **What's shared:** the issue's identity/status/assignee/title presentation; the stated goal is "a more cohesive, timeless UI" that reduces "visual noise" and maintains "visual alignment" across views, plus side panels "to display meta properties" (the peek surface).
- **What's surface-specific:** density and hierarchy of navigation chrome per display; board grouping vs list rows vs timeline.
- **Anti-pattern avoided:** **per-view drift** — Linear's explicit method is to test each decision in *all* view types so list and board don't diverge.
- **Caveat:** this is a *design* writeup, not a component-architecture spec. Linear does not publish its internal component API; treat it as corroboration of the discipline (one record, validated across all surfaces), not a copyable mechanism.

### Stripe — Sail design system reused across dozens of internal/external/embedded surfaces

- **Canonical refs:**
  - https://stripe.dev/blog/migrating-to-typescript — "Our JavaScript projects make heavy use of Sail, a shared design system."
  - https://portfolio.chsmc.org/sail (Chase McCoy, who led Sail 2020–2024) — "Creating a customizable design system for Stripe products, internal tools, and embedded surfaces... supports dozens of internal, external, and embedded product surfaces."
  - Context: https://newsletter.pragmaticengineer.com/p/stripe-part-2 — "Stripe's design system is how the company builds all its products. Sail is a collection of components, like this `ListPage`."
- **Pattern name:** **"single shared design system (Sail) is the only build path."** Components like `ListPage` are reused across product, internal-tool, and embedded (Connect) surfaces; the same components power customer-customizable embedded UIs.
- **What's shared:** the component library itself — one `ListPage`/table/object primitive instead of per-team re-implementations.
- **What's surface-specific:** Sail is "customizable," so embedded surfaces re-skin shared components rather than forking them.
- **Anti-pattern avoided (named by Stripe):** **tight coupling / per-surface re-implementation.** Stripe's own TS-migration blog calls out that "the Dashboard codebase has tight coupling between disparate components" as the problem state — the fix is leaning harder on the shared Sail system, not parallel render paths.
- **Caveat:** Stripe publishes *that* Sail exists and is the single build path, but **not** the cell/row primitive's API. The `ListPage` detail comes from Pragmatic Engineer (paywalled secondary) and a former Sail lead's portfolio (primary practitioner), not a Stripe API doc. Strong on discipline, thin on copyable mechanism.

---

## Synthesis: the SLVP-convergent pattern

Two products publish the *mechanism* (Airtable field types, Notion property-type config); one publishes the *code API* (Primer `DataTable`); two publish the *discipline* (Linear, Stripe). They converge on one architecture:

**Shared headless record model → field-type cell-renderer registry → presentational row/cell components → consumed by every surface's layout config.**

1. **One record model (headless).** A normalized record = `{ identity, title, fields: Field[] }` where each `Field` has a `type` and `value`. This is Notion's "page + typed properties" and Airtable's "record + typed fields."
2. **One cell-renderer registry keyed by field type.** `renderers[field.type](field.value, { density, surface })`. A `date` renderer, a `currency` renderer, a `select`/`status` renderer, a `linked-record` renderer. This is the single source of truth that makes "a record can't render two different ways" *structurally true*. (Airtable field types; Notion `status_show_as`/`date_format` keyed by property type.)
3. **One presentational row/cell primitive (slotted).** A single slotted item — identity/leading visual + title + preview/value + trailing meta — à la Primer `ActionList.Item` on `useSlots`. The table row, feed row, and peek header all instantiate this primitive; the registry fills the value slots.
4. **Surface = thin layout config only.**
   - **Table:** column defs (`field` | `renderCell`), `sortBy` per column, density, frozen/`rowHeader` identity column. (Primer `DataTable`.)
   - **Feed/timeline:** day-grouping / time ordering / swimlanes wrapping the *same* rows. (Airtable Timeline swimlanes; Notion `group_by`; Linear list/board/timeline.)
   - **Peek + detail:** which fields are visible, order, and size — same renderers, bigger/stacked layout. (Airtable record-detail "Fields" section selecting the same table fields; Notion `properties[].visible`.)

**Concrete PDPP shape (recommended):**
```
record-model.ts        // headless: Record, Field{type,value}, classifyRecordKind
field-renderers.ts     // registry: Record<FieldType, (value, ctx) => ReactNode>  ← single source of truth
RecordRow.tsx          // slotted presentational primitive (leading/title/preview/trailing)
  ├─ table:  columns[].renderCell = (row) => <RecordCell field=.../>   // + sortBy, density
  ├─ feed:   <DayGroup><RecordRow .../></DayGroup>                      // + time ordering
  ├─ peek:   <RecordRow variant="peek" /> + <FieldList renderers=.../> // shared renderers
  └─ detail: <FieldList renderers=.../>                                // same registry, stacked
```
The table's `renderCell` and the detail's `FieldList` both call **the same `field-renderers` registry** — that single shared dependency is what guarantees identical rendering. The brand/design-system package owns `RecordRow`, `RecordCell`, and the renderer registry; surfaces import them and add only layout.

---

## Anti-patterns to avoid

1. **Two parallel render paths that drift.** A list-table component and a feed component each formatting fields their own way. (Stripe explicitly frames "tight coupling between disparate components" as the failure state; the fix is one shared system.) → Enforce a single `field-renderers` registry imported by both.
2. **Detail view re-implements its own field formatting separate from the list.** The #1 way a record renders two ways. Airtable/Notion structurally prevent this — the field/property type owns rendering everywhere. → Detail = same renderers, different layout; never a fork.
3. **Field-type formatting duplicated per surface.** A `currency` field formatted in 4 places. → One renderer per field type; surfaces pass a `ctx` (density/surface), they don't re-format.
4. **Sorting/density logic leaking into the cell renderer.** Mixing a *table* concern (sort strategy) into the shared cell makes the cell un-reusable in a feed. → Keep `sortBy` and density on the column-def/surface (Primer puts `sortBy` on the column, not the cell), keep the cell pure-presentational.
5. **A "row" that's secretly a table-row (`<tr>`/`<td>`) and can't live in a feed.** Coupling the shared primitive to table markup blocks reuse. → The shared primitive renders semantic-neutral content; the *table surface* wraps it in `<tr>`, the *feed* wraps it in a list item. (Primer's `useSlots` item is markup-agnostic; only the container fixes semantics.)
6. **Field-name guessing instead of declared types.** (PDPP-specific, consistent with SLVP discipline.) A renderer that sniffs field *names* instead of dispatching on a declared field *type* will render the same record differently as data shifts. → Dispatch on declared type only; honest generic fallback otherwise.

---

## Source reliability notes

| Product | Mechanism published? | Source strength |
| --- | --- | --- |
| Notion | **Yes** — Views API: property-type display config, view-as-config | Primary (official API docs) — strongest |
| Airtable | **Yes** — field-type system + record-detail reuses table fields | Primary (official support docs) — strong |
| GitHub/Primer | **Yes** — `DataTable` column-defs + `ActionList` + `useSlots` | Primary (official design-system docs) — strong on API shape; no single shared leaf primitive |
| Linear | Discipline only | Primary (Linear's own blog) but *design*, not component API |
| Stripe | Existence + discipline only | Mixed: Stripe's own TS blog confirms Sail; `ListPage` detail is Pragmatic Engineer (secondary, paywalled) + ex-Sail-lead portfolio (primary practitioner). **Could not find a Stripe-published doc of the cell/row primitive's API.** |

**Product with no clean primary mechanism source:** **Stripe** — Sail is confirmed real and the single build path, but Stripe does not publish Sail's component API; the `ListPage`/cell-primitive specifics come from secondary/practitioner sources, not stripe.com docs.
