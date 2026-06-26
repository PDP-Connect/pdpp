# Design: unified record presentation — one shared record primitive across table + feed + peek + detail

**Cell:** unified record presentation (Gate 3 "ONE unified record presentation everywhere"; Part-0 trap
"the same record looking different in two places").
**Pinned tip:** deploy tree `<deploy-worktree>`, tip `36d51f49` (verified
`git rev-parse HEAD`).
**Prior art:** `./prior-art.md` (Airtable/Notion field-type renderer registry + Primer `DataTable`
`columns[].field`/`renderCell` + `ActionList.Item` slotted primitive; Linear/Stripe corroborate the
discipline).
**Status:** design only; >95% confidence claimed ONLY after step-6 Codex LAND.

---

## 1. The defect, re-audited BY CONTENT on `36d51f49`

The Phase-0 audit is correct: feed-row, peek, and detail-page already SHARE the honesty engine; the
**per-stream list TABLE is a separate raw-column path.** Verified file:line on the pinned tip:

**A. The shared (honest) path — already converged on three surfaces:**
- The headless record model + honesty engine: `buildRecordPreview(kind, data, fieldTypes, roles)` →
  `packages/operator-ui/src/lib/record-preview.ts:383`. It dispatches a TYPED card only from a
  manifest-DECLARED role; with no declared roles it returns the honest generic key/value card
  REGARDLESS of heuristic kind (`record-preview.ts:399-401`). This is exactly the prior-art
  "field-type/role renderer registry" — it is the single source of presentation truth.
- The row projection: `rowPrimary(preview, fallback)` → `record-preview.ts:471`; `rowSecondary(preview)`
  → `record-preview.ts:492`. RL1 strict source order (declared title → body → amount → author → first
  honest generic field → neutral fallback), NEVER a stream name / kind noun / summary.
- **Feed row** consumes it: `apps/console/src/app/dashboard/explore/explore-canvas.tsx:1540`
  (`primaryLine = rowPrimary(...)`), `:1549-1550` (`derived = !declaredTitle` → generic weight when not
  declared), `:1571-1573` (leading kind glyph slot, prior-art Primer `leadingVisual`).
- **Peek + Detail H1** consume it:
  `apps/console/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx:185-190`
  (`declaredRolesFromCapabilities` → `classifyRecordKind` → `buildRecordPreview` → `rowPrimary(detailPreview, null)`;
  `hasDisplayTitle` guard prefers the mono record key over `"Record"` when nothing is declared,
  `:242-247`). `RecordInspector` renders the field table via the brand `RecordBody`
  (`apps/console/src/app/dashboard/components/record-inspector.tsx:156`).

**B. The divergent (raw) path — the stream TABLE, verified `records/[connector]/[stream]/page.tsx`:**
- **H1 is the stream NAME in mono**, not a record/record-set title via the engine:
  `title={<code className="font-mono">{streamName}</code>}` (`page.tsx:406`). (Acceptable as a *stream*
  page H1 — the H1 here names the stream, not a record — but see §4: it must read as a deliberate,
  consistent header, not the raw-mono default.)
- **Zero references to the honesty engine** — confirmed by grep: no `buildRecordPreview` / `rowPrimary`
  / `classifyRecordKind` / `declaredRolesFromCapabilities` in the file. The table is a pure raw path.
- **The identity cell diverges.** The desktop table leads every row with a `date` column then an `id`
  column rendering `truncate(r.id, 32)` in `font-mono` as a prominent linked cell (`page.tsx:481-488`).
  The feed leads with a kind GLYPH + `rowPrimary` CONTENT. **So a record's identity line renders two
  different ways:** raw `id`-mono in the table, declared-content-or-honest-generic in the feed/peek.
- **Cell values** use `cellText` = `formatDeclaredAmount(...) ?? stringifyCell(...)` (`page.tsx:352-356`).
  Money formatting IS shared (good); everything else is `stringifyCell` — fine for a *column value* but
  there is no record-level primary/secondary at all.
- **The mobile `RecordCard`** (`page.tsx:742-783`) renders a `<dl>` of timestamp + `id` (mono) + every
  selected column as `humanized?`-no — raw field-NAME `<dt>` → value `<dd>`. No shared primary, no kind
  glyph, no declared title — fully divergent from the feed row a phone shows in Explore.

**What the table renders that the shared path does not:** (1) the **raw `id` as a prominent leading
column** (identity key promoted to a primary visual — Gate-1 "identity keys never a title/H1" applies to
the *visual lead*, not just literal `<h1>`); (2) **sortable raw-field columns** (`date`/`id`/<field
names>, `page.tsx:459-465`) — a legitimate TABLE affordance, not a defect; (3) a **mobile card** that
re-implements its own field-name `<dl>` instead of reusing the feed-row primitive.

**Decisive fact for feasibility:** the table page **already fetches `streamMetadata`** (which carries
`field_capabilities` incl. declared roles) — `page.tsx:201,215,236` — and already calls
`deriveDeclaredFieldTypes` for money. So computing the honest preview is **a pure transform on data
already in hand; no new fetch, no new request.** Consolidation is additive, not architectural surgery.

---

## 2. Prior-art-chosen architecture (cited)

Adopt the SLVP-convergent pattern from `prior-art.md` — **headless record model → shared presentational
row primitive → surface owns only layout** — realized against PDPP's EXISTING engine, NOT a parallel one.
**`RecordPreview` (`record-preview.ts:58`) IS the headless record model the prior art prescribes** —
already role/type-dispatched, already the single object the feed/peek/detail normalize into. This cell
does NOT add a second model; it adds the ONE missing layer (the shared presentational cell) and wires the
table in via Primer's column-def `renderCell` API. Mapping is 1:1:

| Prior-art layer (Airtable/Notion/Primer) | PDPP existing primitive | Gap to close |
|---|---|---|
| headless record model (typed fields) | `buildRecordPreview` + `classifyRecordKind` + `declaredRolesFromCapabilities` | **none — `RecordPreview` is the canonical model; nothing duplicates it** |
| projection (primary/secondary) | `rowPrimary` (`:471`) / `rowSecondary` (`:492`) | none — already the single projection |
| field-type cell-renderer registry | `RecordBody` (brand, `record-render.tsx`) + `formatDeclaredAmount` | shared by peek/detail; table cell values use `cellText` (already amount-shared) |
| **slotted presentational CELL** (Primer `ActionList.Item` / `DataTable` `renderCell`) | **MISSING** — feed inlines its own `<span>` identity; table leads with raw `id`-mono; mobile card its own `<dl>` | **build `RecordIdentity` (a thin renderer over `RecordPreview`)** |
| surface = thin layout config | feed=day-group; table=column-defs/order/picker; peek/detail=field list | keep — surfaces stay surface-specific |

**The one new shared component: `RecordIdentity`** — the "row identity" cell the prior art calls
`ActionList.Item` / the table's `rowHeader` `renderCell`. It is a **thin presentational renderer over the
canonical `RecordPreview`** (NOT a new model — see §3): its single input is `(preview, recordKey, opts)`.
It is **markup-neutral** (renders `<span>`s only — anti-pattern #5: a `<tr>`-coupled row can't live in a
feed), so the table wraps it as the leading-column `renderCell(row)` inside a `<td>`, the feed wraps it
in its `<li>`/button, the detail/peek header uses it directly. Because all four read the SAME
`RecordPreview`, the record's identity **cannot render two ways** (prior-art TL;DR + anti-patterns #1/#2).

**Table integration = a column-def registry (Primer `DataTable`), not a bespoke leading cell.** The
table's columns become an array of `{ field | renderCell, header, ... }`; the FIRST column is the shared
`recordIdentity` column whose `renderCell(row) => <RecordIdentity preview={...} />`; the remaining
columns keep their existing `cellText`/FK-link/amount renderers. `order` (asc/desc) and the column
**picker** live on the column-defs/surface, never inside `RecordIdentity` (anti-pattern #4).

Home: `packages/operator-ui/src/components/record-identity.tsx` (operator-ui, alongside the engine and
the `views/` the feed lives in). **Purity constraint (RSC-safe, §7): no `"use client"`, no hooks, no
browser/server side-effects, no server-only imports — a pure formatter of `RecordPreview` → JSX.** Atoms
it needs are client-safe brand atoms (`CopyMono`, `IcTimestamp`); `kindGlyph`/`KIND_GLYPHS` are currently
private to `explore-canvas.tsx:1501` — **promote them** to `record-identity.tsx` so feed + table share
ONE glyph map, not two.

---

## 3. Canonical-state check (the highest-value step)

**The ONE canonical object is the EXISTING `RecordPreview`** (`record-preview.ts:58`) and its projection
`rowPrimary`/`rowSecondary` — full stop. This cell **does NOT introduce a second presentation model.**
(Codex review #2: an independent `RecordIdentityModel` carrying its own primary/secondary/kind/key would
be a parallel object that can drift — the exact anti-pattern #1/#2 this cell exists to kill. Rejected.)

`RecordIdentity` consumes `RecordPreview` directly. The only new helper is a **stateless view-adapter
with NO independent selection rules** — it just reads slots the engine already computed:

```
recordIdentityView(preview: RecordPreview | null, recordKey: string) → {
  primary:   rowPrimary(preview, recordKey),          // engine's projection — not re-derived
  secondary: rowSecondary(preview),                   // engine's projection — not re-derived
  isDerived: !(preview?.title ?? preview?.body ?? preview?.amount ?? preview?.author),
  kind:      preview?.kind ?? "generic",
}
// NO field selection, NO title guessing, NO new heuristic — every value is read straight off
// `RecordPreview`. If a surface needs the preview it builds it via the SAME buildRecordPreview call.
```

**The image-mark signal is SURFACE-SUPPLIED, not preview-derived (Codex re-review).** On `36d51f49`,
`entryHasImage` (`explore-canvas.tsx:287-290`) reads `entry.blobAffordance?.state === "available"` — a
feed-ENTRY signal that `RecordPreview` does NOT carry (it has no blob/image field). So the view-adapter
canNOT honestly derive `hasImage` from the preview without re-guessing. The honest fix: `hasImage` is an
**explicit boolean prop each surface passes** (the feed from `entryHasImage(entry)`, the table/detail
from the same `blobAffordance` it already resolves via `buildPeekFields`/`RecordInspector`'s
`blobAffordance`). The cell renders the "image" mark iff that prop is true — it never sniffs the preview
for an image. This keeps the cell a pure formatter and the image signal a declared/server one (Gate-1
"render richly from RELIABLE signals only — never from guessing").

The feed row's `explore-canvas.tsx:1540-1559` IS this view logic today, inlined. **Extract it once** into
`recordIdentityView` and have the feed row, the table identity column's `renderCell`, the mobile card
header, and the detail H1 all call it over a `buildRecordPreview` they each construct from data in hand.
One canonical model (`RecordPreview`), one projection (`rowPrimary`/`rowSecondary`), one view-adapter, one
cell — surfaces differ only in wrapper markup + which EXTRA columns/fields they add. The table must NOT
keep its own identity rendering (that would be the second drift path; anti-pattern #1).

**Non-overlap (kept separate, correctly):** the table's **column picker** (`ColumnsMenu`,
`page.tsx:382-389`), its **global `order` asc/desc** (`page.tsx:106-108,150`), **horizontal-scroll
density**, FK-link cells, and reverse-child links are TABLE-specific layout (prior-art: order/picker live
on the column-defs/surface, not the cell; anti-pattern #4). The over-time chart, date controls, and
rich-sort cells are OTHER cells — `RecordIdentity` does not touch them.

---

## 4. Honesty semantics — centralized in the shared component (the point of the cell)

Today honesty is enforced THREE times (feed inline, detail inline, peek inline) and NOT AT ALL in the
table's identity rendering. After this cell, the identity invariants are enforced ONCE inside
`recordIdentityView`/`RecordIdentity` (over the already-honest `RecordPreview`), and every surface
inherits them. The invariants the cell carries (all already live in `buildRecordPreview`; the cell's job
is to be the ONLY consumer for identity, never to re-derive):

1. **Declared-or-honest-generic title.** Primary comes from `rowPrimary` → declared role-backed slot,
   else first honest generic `label: value` field, else neutral fallback. No field-NAME guessing
   (`record-preview.ts:399-401` already forbids it; the cell never adds its own guess).
2. **Identity keys never styled as a title (visual-hierarchy invariant).** *Scoped precisely:* the engine
   ALREADY omits pure identifier fields (`id`/`*_id`/uuid) from generic-primary selection
   (`record-preview.ts:336-340`, `IDENTIFIER_FIELD_RE`) — so a raw key is never the *content* title.
   Showing `id` as a mono COLUMN is therefore allowed (it's a machine value in a grid); the breach the
   table commits is a **visual-hierarchy / cross-surface-consistency** one, NOT a "raw id is forbidden"
   one — the table makes the raw-`id` mono cell the prominent LEADING column ahead of content, so the
   same record's row leads with its uuid in the table but with declared content in the feed. The fix:
   the LEADING column becomes `RecordIdentity` (declared content when present; `isDerived`/quiet
   treatment otherwise, mirroring `explore-canvas.tsx:1549-1550,1576`). The record key stays fully
   reachable — as a quiet mono token, the existing `CopyMono`, and the row link — just no longer the
   visual lead. (Whether `id` survives as a non-leading mono column or a trailing token is a layout
   choice in the <5% residual; identity-parity holds either way.)
3. **Mono discipline.** Mono ONLY for machine values: the record key, timestamps, declared
   `currency`/amount columns. The primary content line and any humanized field label are SANS. The table
   keeps `font-mono` on the **key token and timestamp column** (machine values — correct) and on declared
   foreign-key link cells; it must NOT apply mono to the new content-primary line.
4. **Money stays declared-only** via `formatDeclaredAmount` (already shared, `page.tsx:354`,
   `record-preview.ts`); the cell does not re-format money — it delegates to the same path.

**Table-specific vs shared — the seam (prior-art anti-pattern #4/#5):**
- **Shared (becomes `RecordIdentity`):** the record's **identity/title/preview** (primary content +
  honest secondary + kind glyph + key token). Renders identically in the table's leading cell, the feed
  row, the mobile card header, and the detail/peek title.
- **Table-keeps (surface layout):** sortable **raw-field columns** (column header = humanized field
  label naming a DECLARED field — legitimate grid behavior, NOT a guessed title), the **column picker**,
  **density**, the **timestamp column**, **foreign-key link cells**, **reverse-child links**,
  horizontal scroll. Sorting/density never leak into the shared cell.
- **The table H1** keeps naming the STREAM (it is a stream page, not a record), but renders via a shared
  `PageHeader` title treatment, not a bare raw-mono default — consistent with detail/feed headers. (Low-
  risk copy/style, in the <5% residual; the *record-identity* convergence is the load-bearing change.)

---

## 5. The shared-component API (exact props + states)

`packages/operator-ui/src/components/record-identity.tsx`. **RSC-purity constraint (Codex review #7): no
`"use client"`, no React hooks, no browser/server side-effects, no server-only imports — a pure formatter
of `RecordPreview` → JSX, callable in BOTH a client component (the feed) and a server component (the
table/detail). Its only imports are the engine projections (`rowPrimary`/`rowSecondary`), the glyph map,
and client-safe brand atoms (`CopyMono`, `IcTimestamp`). It does NOT import `entryHasImage` (a feed-entry
helper) — the image signal arrives ONLY as the surface-supplied `hasImage` boolean prop.**

```ts
// The stateless view-adapter (§3): reads slots the engine already computed. NO new model, NO fetch,
// NO selection rules. `preview` is the caller's buildRecordPreview output (the ONE canonical model).
export interface RecordIdentityView {       // derived ONLY from the preview — no image, no key state
  primary: string;            // = rowPrimary(preview, recordKey)
  secondary?: string;         // = rowSecondary(preview)
  kind: RecordKind;           // = preview?.kind ?? "generic"  (leading glyph + a11y)
  isDerived: boolean;         // true when NO declared title → quiet/generic treatment (never bold title)
}
export function recordIdentityView(preview: RecordPreview | null, recordKey: string): RecordIdentityView;

// The markup-NEUTRAL presentational cell (anti-pattern #5: renders ONLY <span>s — no <tr>/<td>/<li>).
export interface RecordIdentityProps {
  preview: RecordPreview | null;   // the canonical model the surface already built
  recordKey: string;               // raw key → quiet mono token (when showKey); never the visual lead
  /** SURFACE-SUPPLIED reliable image signal (NOT preview-derived — see above). The feed passes
   *  entryHasImage(entry); the table/detail pass their resolved blobAffordance?.state === "available". */
  hasImage?: boolean;              // default false
  /** Host-surface layout role. Controls spacing + whether secondary shows. NOT a behavior switch. */
  variant: "feed" | "table-cell" | "card" | "header";
  showGlyph?: boolean;             // default true
  showKey?: boolean;               // default: variant === "feed" || "card"
  className?: string;
}
export function RecordIdentity(props: RecordIdentityProps): ReactElement;
// internally calls recordIdentityView(preview, recordKey), then renders ONLY <span>s:
//   [glyph?] [primary (sans; weight 500 when !isDerived, generic weight when isDerived)]
//   [image mark? — from the hasImage PROP] [secondary (muted sans)] [recordKey (mono, muted, when showKey)]
```

States the cell must cover (each a test row in §6):
- **Declared title** (role-backed): primary = declared title, weight-500 sans, `isDerived=false`.
- **No declared role** (generic): primary = first honest `Label: value`, generic weight, `isDerived=true`.
- **Body-less / search-hit** (feed only; table always has a body): primary = neutral fallback (key) →
  `isDerived=true`, mono-secondary key shown; never a faked title.
- **Image present**: caller passes `hasImage` → "image" mark rendered before primary (parity with feed
  `explore-canvas.tsx:1577`). The cell never sniffs the preview for an image.
- **Empty/absent values**: primary degrades to fallback, never throws; `stringifyCell` "" handling holds.

**Consolidation — what code is deleted/replaced (each surface ends up consuming the SAME cell — no
surface keeps its own identity rendering):**
- `explore-canvas.tsx:1540-1559` inline identity derivation → deleted; `FeedRow` builds its
  `RecordPreview` (already does, via `entry.preview`) and renders
  `<RecordIdentity variant="feed" hasImage={entryHasImage(entry)} ...>` (keeps its own
  `<button>`/arrow/Open chrome). The image signal stays `entryHasImage`, now passed as the prop.
- `page.tsx` (table) **column-defs**: the table's columns become a `{ field | renderCell, header }[]`
  array; the FIRST column is the shared `recordIdentity` column with
  `renderCell: (row) => <RecordIdentity variant="table-cell" preview={buildRecordPreview(...)} recordKey={row.id} hasImage={blobState(row)==="available"} />`
  (the table resolves the same declared `blobAffordance` the detail page already reads). The standalone
  prominent `id`-mono lead column is removed as the lead; timestamp stays its own column; the raw key
  survives as a quiet token / non-leading mono column. Remaining columns keep their existing
  `cellText`/FK-link/amount `renderCell`s.
- `page.tsx` `RecordCard` (mobile, :742-783) → header becomes `<RecordIdentity variant="card">` + the
  existing remaining-columns `<dl>` (the columns are table layout, kept).
- detail H1 (`[recordKey]/page.tsx:241-247`) → **MUST** consume the shared cell: render
  `<RecordIdentity variant="header">` over its already-built `detailPreview` (`:188`). Its current inline
  `rowPrimary(detailPreview, null)` (`:189`) is functionally correct today but is a SECOND copy of the
  view logic — it is replaced by `recordIdentityView`, NOT left as an optional parallel path (Codex
  review #6: optional sharing leaves a drift path; the thesis is ONE shared cell). The `hasDisplayTitle`
  key-fallback (`:190,242-247`) folds into the cell's `isDerived` + `showKey` handling.
- `kindGlyph` + `KIND_GLYPHS` promoted out of `explore-canvas.tsx:1501` into `record-identity.tsx`; the
  feed imports them from there (one glyph map, not two).

---

## 6. Executable test matrix

Co-located unit tests (`record-identity.test.tsx`, operator-ui node:test) + an acceptance assertion in
the console suite. **The load-bearing test is T1 — and it must be CONCRETE, not "compare to a string"
(Codex review #5).**

**T1 fixture harness (executable, not hand-wavy).** Define a `FIXTURES` array — one seeded record per
record kind: `declared-title` (role-backed), `generic` (no roles), `money` (currency-declared), `image`,
`id-only` (no readable content). For EACH fixture R, render the SAME `RecordPreview` through each of the
four surfaces and assert on the produced DOM:
```ts
// One preview per fixture, built once via the canonical engine.
const preview = buildRecordPreview(classifyRecordKind(...).kind, R.data, R.types, R.roles);
// Render the shared cell in each surface variant + the two host components:
const cells = {
  feed:   render(<RecordIdentity variant="feed"       preview={preview} recordKey={R.id} />),
  table:  render(<RecordIdentity variant="table-cell" preview={preview} recordKey={R.id} />),
  card:   render(<RecordIdentity variant="card"       preview={preview} recordKey={R.id} />),
  header: render(<RecordIdentity variant="header"     preview={preview} recordKey={R.id} />),
};
// PARITY assertions (the anti-drift contract), per fixture:
for (const c of Object.values(cells)) {
  expect(c.querySelector("[data-rr-x='primary']")?.textContent).toBe(EXPECTED[R].primary); // identical text
  expect(c.querySelector("[data-rr-x='glyph']")?.textContent).toBe(EXPECTED[R].glyph);      // identical glyph
  expect(c.querySelector("[data-rr-x='primary']")?.className).not.toMatch(/font-mono/);     // T5 mono
  expect(c.querySelector("[data-rr-x='primary']")?.dataset.derived).toBe(String(EXPECTED[R].isDerived));
}
```
The cell exposes stable `data-rr-x` selectors (`glyph`/`primary`/`secondary`/`key`) so the assertions are
DOM-level, not snapshot-fragile. Parity is proven because all four call the SAME `recordIdentityView`
over the SAME `preview` — the test catches any surface that forks. A companion integration test renders
the real `FeedRow`, the real table identity-column `renderCell`, and the real detail `PageHeader` over one
fixture and asserts the same `data-rr-x='primary'` text in all three (proves the HOST wiring, not just the
cell in isolation).

| # | Test | Assertion | Guards |
|---|---|---|---|
| T1 | Same-record cross-surface parity | the fixture harness above: per kind, `data-rr-x='primary'` text + glyph + `derived` flag are IDENTICAL across feed/table/card/header, AND identical in the real `FeedRow` / table `renderCell` / detail `PageHeader` host render | Gate 3 unify; Part-0 "same record two places" |
| T2 | Declared-title record | role-backed `R` → `primary` = declared title, `data-derived=false`, weight-500 sans | §4.1 |
| T3 | Undeclared record (no roles) | `R` with no `x_pdpp_role` → `primary` = first honest `Label: value`, `data-derived=true`, generic weight; NOT a field-name-guessed title | Gate-1 no-name-guess; `record-preview.ts:399` |
| T4 | Identity key never the visual lead | `R` whose only content-ish field is `id`/uuid → `data-rr-x='primary'` is the neutral fallback/quiet treatment, NOT a bold title; the raw key appears only in `data-rr-x='key'` (mono) | Gate-1 keys-never-title (visual-hierarchy scope, §4.2); `record-preview.ts:336-340` |
| T5 | Mono discipline | `data-rr-x='primary'` has NO `font-mono`; `data-rr-x='key'` + timestamp DO | Gate-1 mono-only-machine |
| T6 | Money still declared-only | a `currency`-declared amount renders via `formatDeclaredAmount` (e.g. `$30.00`); an undeclared number renders neutral, no fabricated `$` | Gate-1 amounts-declared; `page.tsx:354` |
| T7 | Image mark parity | passing `hasImage` (the surface-supplied reliable blob signal — `entryHasImage(entry)` in feed, `blobAffordance?.state==="available"` in table/detail) renders the "image" mark; the cell renders NO mark when the prop is false, and NEVER sniffs the preview for an image | §5; Gate-1 reliable-signals-not-guessing; `explore-canvas.tsx:287-290` |
| T8 | Markup-neutral | `<RecordIdentity>` renders no `<tr>/<td>/<li>` (DOM assert) so it embeds in a table cell AND a feed list | anti-pattern #5 |
| T9 | Table affordances preserved | after the swap the stream table STILL exposes: the **column picker** (`ColumnsMenu`, `page.tsx:382-389`), the **global `order` asc/desc** control, the **timestamp column**, **FK link cells**, **reverse-child links**, horizontal scroll. (NOT "per-field sortable headers" — those do not exist on `36d51f49`; `order` is a single global asc/desc read by `readRecordOrder`/applied at `page.tsx:150`.) | Codex #4; table-specific kept |
| T10 | No new fetch | the table page issues the SAME RS requests as before (identity is a pure transform on `streamMetadata` already fetched, `page.tsx:201,215,236`) | §1 feasibility |
| T11 | Single glyph source | feed and table import the SAME `kindGlyph`/`KIND_GLYPHS` from `record-identity.tsx` (no second copy) | §5 consolidation |
| T12 (DOM/live) | Side-by-side render | live desktop+mobile: a record opened in Explore vs the same record's row in its stream table show the SAME primary line + glyph (the owner red-line: lived-in, not "CSS is present") | Gate-4 feel; Part-0 meta-trap |

T1–T11 are code-gated (CI). T12 is the execution-time live verification (Playwright/darshana), not a
design gate — listed so the executor knows the acceptance bar.

---

## 7. Bounded <5% residual (does NOT touch correctness/honesty)

- The table **H1 style** (stream name): keep naming the stream; whether it stays mono-code or moves to a
  sans stream-label with a mono key token is a low-risk header-copy choice deferred to the SLVP-feel
  integration pass. (Identity-of-records convergence — the load-bearing change — is fully specified.)
- Exact **glyph set / spacing tokens** for `variant="table-cell"` density vs `variant="feed"` — visual
  polish within the existing brand tokens; both render the SAME primary content, only padding differs.
- Whether the demoted record **`id` survives as a non-leading mono column or a trailing quiet token** —
  layout position only; identity-parity (the LEAD = `RecordIdentity`) holds either way.

None of the residual can make a record render two *different* primaries or violate an honesty invariant —
those are all pinned by §4 + the T1–T8 matrix.

---

## 8. Self-critique vs THE-LENS Part 0 + gates (incl. Codex review resolution)

- **Part-0 "same record two places" / "Explore vs stream-table divergence is confusing me" (6/18):**
  directly closed — ONE canonical model (`RecordPreview`), one view-adapter, one cell; T1's fixture
  harness + the host-render integration test prove parity at DOM level. ✓
- **Part-0 "meaning guessed from names":** the cell adds ZERO new inference; it only consumes
  `buildRecordPreview`, which already forbids name-guessing (`record-preview.ts:399`). T3/T4. ✓
- **Part-0 "claimed done by code, not lived-in":** T12 is explicitly a live desktop+mobile side-by-side,
  flagged as the real acceptance — design does NOT claim done. ✓
- **Gate-1 keys-never-title + mono-discipline + amounts-declared:** centralized in the shared cell,
  T4/T5/T6. The breach is scoped correctly (§4.2, Codex #3): the engine already omits identifiers from
  generic-primary (`record-preview.ts:336-340`), so this is a **visual-hierarchy** demotion of the raw-`id`
  LEAD column, not a claim that `id`-as-column is forbidden. ✓
- **Gate-3 "ONE unified record presentation; a settled, prior-art-grounded decision, not two parallel
  half-views":** decision = shared `RecordIdentity` cell over the canonical `RecordPreview`, table wired
  via a Primer `DataTable` column-def `renderCell` registry (`prior-art.md`); table keeps grid
  affordances, record identity is shared, detail is NOT left optional (Codex #6). ✓
- **Gate-4 row scannability:** the table row gains the same leading-glyph + content-primary the feed has
  (prior-art Primer `leadingVisual`), without losing columns. ✓
- **RSC boundary (Codex #7):** the cell is a pure formatter — no `"use client"`, no hooks, no server-only
  imports — so it is safe in the client feed AND the server table/detail; constraint stated in §5. ✓
- **Honest residual:** the over-disclosure/per-connection-scope item (Part B Gate-1) is OUT of scope —
  a protocol-team server-enforcement gap, not record-presentation. Flagged, not silently absorbed.

**Codex adversarial review (gpt-5.5, high effort) — HOLD → revised → resolved:** #1/#7 table wired via a
column-def `renderCell` registry (not a bespoke leading cell). #2 the `RecordIdentityModel` was deleted —
`RecordPreview` is the sole canonical model; only a stateless `recordIdentityView` adapter remains
(no independent selection rules → no drift). #3 the raw-`id` claim re-scoped to visual-hierarchy. #4 T9
corrected to the affordances that actually exist on `36d51f49` (global `order`, column picker — NOT
per-field sortable headers). #5 T1 made executable (per-kind fixtures + DOM `data-rr-x` assertions +
host-render integration). #6 detail required to consume the shared cell, not optionally. The feasibility
claim (table already fetches `streamMetadata` → no new fetch) was independently confirmed true by Codex.

**Residual weakest point (for re-review):** the column-def `renderCell` refactor of the table is slightly
larger than a one-cell swap — but it is the prior-art-correct shape and keeps every existing column
renderer intact; T9/T10 pin that no affordance or fetch is lost.

## DEFINITION OF DONE — pixel gate (mandatory, not the merge)
DONE only when the shared RecordIdentity cell, rendered across feed/table/card/detail, is captured live
and stacks up SIDE-BY-SIDE against:
- `../../slvp-benchmark-2026-06-23/shots/vercel-changelog-deployments-list-desktop.png` — the target row
  anatomy: human title leads, status as a colored token, machine values (branch/commit) in mono, dense
  but scannable, no field wall.
- `../../slvp-benchmark-2026-06-23/shots/primer-typography-desktop.png` /
  `vercel-geist-typography-desktop.png` — the exact type scale the identity cell must hit.
And the same record must look IDENTICAL across all four surfaces (capture all four, diff). The owner confirms;
DOM parity assertions are necessary but NOT sufficient (THE-LENS Part 0).
