# Styling in apps (Tailwind, shadcn, brand, editorial)

How UI is built in this repo. Read this before inventing helpers or picking a palette.

## Direction: off `pdpp-*` BEM → Tailwind + JSX composition

We are **migrating** marketing/concept UI off hand-rolled `.pdpp-*` BEM in `editorial.css` toward:

1. **Token utilities** — brand (`bg-background`, …) or editorial-tokens (`text-ink`, `max-w-page`, `container` + remap, …)
2. **Composition** — small JSX comps that own layout (`PdppConceptPage`, `PdppFrontDoor`, …), not new BEM blocks in CSS

**Do (site concept work):**

- Put chrome in a component (`PdppConceptPage` = `container max-w-page` + grid/rail/`home`). Callers compose; they do not sprinkle `pdpp-page` / `pdpp-frontdoor__*`.
- Prefer TW + editorial-tokens. Extend `apps/site/src/styles/editorial-tokens/` when a token is missing — do not invent parallel BEM.
- Delete the matching `.pdpp-*` rule from `editorial.css` when the call site no longer needs it (same PR if the class is dead).

**Do not:**

- Add new `.pdpp-frontdoor__*` / layout BEM for work that can be a util or a local comp.
- “Fix” layout by growing `editorial.css` when a JSX wrapper + `cn(...)` would do.
- Merge editorial into `@pdpp/brand` or style concept pages with brand `bg-background` / `text-muted-foreground` when `text-ink` / `bg-paper` exist.

**Still BEM for now** (specificity / cascade hooks — migrate deliberately, don’t ghost-delete):

- `.pdpp-concept` surface (type, links, paper)
- `.pdpp-doc` prose/table/cmd scoping
- `.pdpp-cta*` (beats `.pdpp-concept a`)
- footer / rail sticky chrome until those comps own it (masthead → `masthead.tsx`)

Site agent notes: [`apps/site/AGENTS.md`](../../apps/site/AGENTS.md). Cascade: [`apps/site/src/app/globals.css`](../../apps/site/src/app/globals.css). Brand package: [`packages/pdpp-brand/README.md`](../../packages/pdpp-brand/README.md). Visual language (console/operator, not concept): [ink-carbon/](./ink-carbon/).

## Surfaces → systems

| Surface | App / package | Style system |
| --- | --- | --- |
| Operator console, sandbox, shared product UI | `apps/console`, `@pdpp/operator-ui`, site `/sandbox` | **Brand** — `@pdpp/brand` + TW |
| Public marketing / concept | site `/`, `/self-host`, `/participate`, masthead/footer | **Editorial** — migrating: comps + `editorial-tokens`; leftover BEM in `editorial.css` |
| Spec docs chrome | site `/specification` | Both — fumadocs + `docs.css` under `[data-pdpp-doc-theme]` |

## Format mechanically (Biome / Ultracite)

- Formatter: **Biome** via Ultracite. Workspace [`.vscode/settings.json`](../../.vscode/settings.json): format on save + Biome for JS/TS/JSON/CSS. Do not hand-reflow JSX — the next save undoes it.
- Repo `lineWidth` is **120** (Ultracite default is 80). Soft-wrap column must match (`editor.wordWrapColumn: 120`).
- After edits: `pnpm exec biome check --write <files>` (or package `format` / lefthook). No local `joinClassNames` / Prettier.

## Class names: always `cn`

```ts
// Brand (source of truth for brand @theme scales):
// packages/pdpp-brand/tw-merge.ts → @pdpp/brand/tw-merge

// Console / operator-ui: thin wrapper around brand cn (keep @/lib/utils for shadcn).
// Site: editorial theme keys + withPdppBrand — apps/site/src/lib/utils.ts
```

shadcn → `"utils": "@/lib/utils"`. Use `cn` for conditional / merged classes. Do not hand-roll `filter(Boolean).join`.

Brand `cn` / `withPdppBrand` registers custom `--text-*` / `--spacing-*` /
`--container-*` / `--radius-*` from brand `tokens/semantic.css`. Site extends
that with editorial-tokens only (`stamp`, `pad`, `page`, …). Custom `--color-*`
names need no listing. Unlisted `text-stamp` is treated as a **colour**, so
`text-teal` deletes it. Keep the brand + site lists in step with those `@theme`
files.

```tsx
// good
className={cn("container max-w-page", home && "[&_[data-slot=pdpp-concept-doc]]:pb-5!", className)}

// bad
className={["container", "max-w-page", className].filter(Boolean).join(" ")}
```

Import from the package you are in. Do not reach across apps for `cn`.

### Group Tailwind smush for legibility

Long `cn(...)` strings are unreadable as one blob. **Split by concern**, one string (or a few related strings) per group, with a short `//` comment above each group. Canonical example: [`PdppConceptPage`](../../apps/site/src/components/pdpp-concept/concept-page.tsx).

```tsx
className={cn(
  // Page measure: brand container (pad/center) + concept max width; flex child
  "container max-w-page shrink-0 grow basis-auto",
  // Default single-column track
  "grid grid-cols-[minmax(0,1fr)] items-start",
  // Rail split / mobile collapse
  "has-[>.pdpp-rail]:grid-cols-[…]",
  "has-[>.pdpp-rail]:[&_[data-slot=pdpp-concept-doc]]:col-[3]",
  "max-[720px]:grid-cols-[minmax(0,1fr)] max-[720px]:has-[>.pdpp-rail]:grid-cols-[minmax(0,1fr)]",
  // Short pages
  home && "[&_[data-slot=pdpp-concept-doc]]:pb-5!",
  className,
)}
```

Rules of thumb:

- Group: measure/container · grid · `has-` / responsive · state (`home`, open, …) · `className` last.
- Comment says **why / what**, not a restatement of the class names.
- Do not smash unrelated utilities onto one line to “save vertical space.”
- Biome may reorder classes *within* a string; it should not flatten your groups. Keep the group breaks.

## Tailwind v4 + tokens

- Theme via CSS `@theme`, not a JS config.
- Product: `@pdpp/brand` (`tokens/primitive.css` → `semantic.css` `@theme`). Brand `@utility container` uses `--container-content` + `--spacing-inset`.
- Concept: `apps/site/src/styles/editorial-tokens/` after `editorial.css` in site globals. Short names (`text-ink`, `max-w-page`, …). Under `.pdpp-concept`, `--spacing-inset` is remapped to concept pad so `container` + `max-w-page` is the page chrome.
- Prefer token utils over arbitrary values; arbitrary OK when no token exists.
- Cross-package TW: `@source` (see site `globals.css` for `@pdpp/operator-ui`).

### Editorial type stack (concept)

One ladder. Three layers — do not invent a parallel scale or a second `@theme` type block.

```
primitive.css          →  --pdpp-concept-* runtime (ink, paper, fonts, pad, …)
       ↓
semantic.css @theme    →  TW utilities (text-ink, text-body, text-display, …)
       ↓
text-variants.ts       →  Text intents (body, lede, display, …) compose those utils
       ↓
text.tsx               →  <Text intent="lede" color="soft">
```

| Layer | Path | Owns |
| --- | --- | --- |
| **Primitives** | [`editorial-tokens/primitive.css`](../../apps/site/src/styles/editorial-tokens/primitive.css) | Raw `--pdpp-concept-*` values (+ dark). Keep in sync with the live block in [`editorial.css`](../../apps/site/src/styles/editorial.css). |
| **Semantic** | [`editorial-tokens/semantic.css`](../../apps/site/src/styles/editorial-tokens/semantic.css) | `@theme` only: colors, measure/spacing, **one** type ladder (`--text-stamp` … `--text-numeral`). Responsive rungs use `clamp` (display/title/lede/deck/numeral). One 15px size: `--text-small`. No comments inside `@theme { }` (TW IntelliSense bug). |
| **Text variants** | [`pdpp-concept/text-variants.ts`](../../apps/site/src/components/pdpp-concept/text-variants.ts) + [`text.tsx`](../../apps/site/src/components/pdpp-concept/text.tsx) | CVA intents/colors over semantic utils. Treatment (italic caption, sans eyebrow) lives here — not a new size token. |

**Rules:**

- New type size? Add the token in `semantic.css`, then the intent in `text-variants.ts`. Values come from `editorial.css` Document type (or replace that BEM in the same change).
- Do not copy a second ladder from Vana/brand. Brand’s product `--text-*` on this app is overridden by editorial `semantic.css` (loads after brand in site globals).
- Call sites: `<Text intent="…" />` or the matching `text-*` utility — not `text-[20px]` when a rung exists.
- `editorial.css` still owns leftover BEM type until call sites move; delete dead rules when unused.

### CVA (class-variance-authority)

Canonical: [`text-variants.ts`](../../apps/site/src/components/pdpp-concept/text-variants.ts). Same rules for concept buttons and any other site CVA.

- Pass the config **inline** to `cva(...)`. Extracting the whole config object widens `defaultVariants` string literals → `string` and breaks `VariantProps`.
- Shared class fragments used **2+ times** stay as consts (e.g. `labelUpper` for eyebrow+stamp). Do **not** flatten them into duplicated long strings.
- One-shot strings stay inline in the variant — do not invent a const for a single use.
- CVA accepts `ClassValue` arrays. Prefer `["a", "b", shared]` over `.join(" ")`. Joining duplicates classes, fights Biome `useSortedClasses`, and violates `cn`-only above.
- Compound variants use `className` (not `class`).
- Do not rewrite structure to chase IDE red — confirm with `pnpm exec biome check <file>` + `tsc`. Biome LSP often shows stale parse cascades while CLI is clean. Fix real `useSortedClasses` via biome `--write`, not by smushing arrays.

### Migrating editorial type (BEM → `Text`)

Canonical worked example: [`PdppFrontDoor`](../../apps/site/src/components/pdpp-concept/front-door.tsx) (replaced `.pdpp-hero*` + raw `text-[…]`).

**Method — same PR, in order:**

1. **Read the BEM block** in `editorial.css` — type only (size, lh, color, weight). Layout (grid, pad, max-width, flex) stays on the JSX wrapper.
2. **Confirm the token exists** in `semantic.css` (or add it from the BEM values; use `clamp` for old `@media` steps).
3. **Confirm the intent exists** in `text-variants.ts` (or add it — treatment like italic/mono/sans lives here, not as a second size).
4. **Swap the call site** to `<Text as="…" intent="…" color="…" />`.
5. **Delete dead BEM** from `editorial.css` when nothing references the class.

**What goes where:**

| Concern | Owner |
| --- | --- |
| Type size / lh / default color | `semantic.css` token → `text-variants` intent |
| Voice (italic caption, mono stamp, sans eyebrow) | `text-variants` intent classes |
| Color override | `<Text color="soft" />` |
| Vertical rhythm between copy blocks | **Parent** `flex flex-col gap-*` / nested stacks — not `mb-*!` on each `Text` (default) |
| Measure (`max-w-[20ch]`) | `className` on the one element that needs it |
| Grid, border, hero water, CTA row | Parent JSX — not `Text` |

**Copy rhythm (default):** put `Text` siblings in a `flex flex-col` stack and own spacing with `gap-*`. Nest sub-stacks when the design uses different steps (e.g. `gap-5` for title block, `gap-3` for a body pair, outer `gap-7` before CTAs).

`.pdpp-concept` is **surface only** (paper/ink/serif) — it does **not** set `p` margins. Legacy article rhythm is `.pdpp-doc p:not([data-slot=pdpp-concept-text])` (raw `<p>` only). `<Text>` is excluded — composed stacks own spacing with `gap-*` and do not need `mb-0!`.

```tsx
className={cn("flex flex-col gap-7 …")}
```

**Break the rule when the UI needs it** — one-off `mb-*!` / `mt-*!` on `Text`, or a sibling outside the stack, is fine. Default to parent gap.

**Front door mapping** (old hero / front-door copy roles → `Text`):

| Copy role | `Text` |
| --- | --- |
| Page title (`h1`) | `as="h1"` `intent="display"` |
| Identity line | `intent="deck"` |
| Definition | `intent="lede"` |
| Amplification | `intent="body"` `color="soft"` |
| Status stamp | `intent="stamp"` `mono` `color="soft"` (compound: mono stamp → `tracking-[0.04em]`) |

CTAs stay `pdpp-cta*` until a `ConceptCta` owns that specificity.

```tsx
<div className={cn("flex flex-col gap-7 pt-[clamp(32px,1.5rem+2.4vw,56px)]")}>
  <div className="flex flex-col gap-5">
    <Text as="h1" className="max-w-[20ch]" intent="display">…</Text>
    <Text intent="deck">…</Text>
    <Text intent="lede">…</Text>
  </div>
  <div className="flex flex-col gap-3">
    <Text color="soft" intent="body">…</Text>
    <Text color="soft" intent="body">…</Text>
  </div>
  <div className="flex flex-wrap gap-x-4 gap-y-3">…CTAs…</div>
</div>
{/* sibling — mt-* OK when outside the copy stack */}
<Text className="mt-7!" color="soft" intent="stamp" mono weight="normal">
  {SPEC_STATUS_STAMP}
</Text>
```

Do not add a new `.pdpp-hero__*` block when an intent already covers the type. Do not leave the BEM rule after the call site moves.

## shadcn

- `apps/site/components.json`, `apps/console/components.json` — `base-nova`, CSS variables, `@/components/ui` + `@/lib/utils`.
- CLI into that app’s `components/ui`. No second `cn` path. Compose brand/editorial tokens; no drive-by hex.

## Specificity while BEM remains

Unlayered `.pdpp-concept a` / `.pdpp-doc p:not([data-slot])` / leftover heading BEM often beat a single TW utility.

- CTAs: keep `pdpp-cta*` / concept `Button` until that specificity is owned in JSX.
- Migrating margins/colors: measure computed styles; use `!` when the unlayered selector wins, or finish the BEM delete in the same change.

## Checklist

1. Surface? Brand or editorial — one palette.
2. New UI? Comp + TW tokens first; not a new `.pdpp-*` block.
3. Dead BEM after a move? Delete the CSS rule.
4. Class merge? `cn` from that package’s utils.
5. New color/spacing/type size? Primitives → semantic `@theme` → (type) text-variants; no drive-by `:root` or parallel ladder.
6. Shared operator UI? `@pdpp/operator-ui` (+ `@source`), not copy-paste.
