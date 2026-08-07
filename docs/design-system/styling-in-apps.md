# Styling in apps (Tailwind, shadcn, brand, concept)

How UI is built in this repo. Read this before inventing helpers or picking a palette.

## Site ownership

The site has three presentation boundaries:

1. `apps/site/src/app/layout.tsx` owns the HTML document, metadata, shared fonts, providers, and the
   `styles/site.css` entrypoint. It does not own route chrome.
2. The concept route-group layout owns the concept shell, masthead, and footer for `/`, `/self-host`, and `/participate`.
   The root `not-found` route is explicit and composes the same shell.
3. The `/specification` layout owns the Fumadocs shell and specification surface while reusing the shared site chrome.

Styles follow those boundaries:

- `styles/site.css` composes site-wide package and surface styles.
- `styles/surfaces/concept/index.css` composes the concept surface.
- `styles/surfaces/concept/components.css` owns remaining concept selectors.
- `styles/surfaces/concept/tokens/**` owns concept runtime values, Tailwind theme mappings, and utilities.
- `styles/surfaces/specification.css` owns Fumadocs/specification overrides.
- `components/docs/prose-page.css` is imported by `ProsePage` and owns only its rendered Markdown rules.

The ownership split preserves current visual behavior. Shared footer and chrome should be structurally consistent across
concept routes, specification, and the root 404.

## Direction: off `pdpp-*` BEM → Tailwind + JSX composition

We are **migrating** marketing/concept UI off hand-rolled `.pdpp-*` BEM in
`styles/surfaces/concept/components.css` toward:

1. **Token utilities** — brand (`bg-background`, …) or concept tokens (`text-ink`, `max-w-page`, `container` + remap, …)
2. **Composition** — small JSX comps that own layout (`PdppConceptPage`, `PdppFrontDoor`, …), not new BEM blocks in CSS

**Do (site concept work):**

- Put page structure in a component (`PdppConceptPage` = `container max-w-page` + grid/rail/`home`). The route-group
  shell owns shared chrome; route callers do not sprinkle `pdpp-page` / `pdpp-frontdoor__*`.
- Prefer TW + concept tokens. Extend `apps/site/src/styles/surfaces/concept/tokens/` when a token is missing — do not
  invent parallel BEM.
- Delete the matching `.pdpp-*` rule from `styles/surfaces/concept/components.css` when the call site no longer needs it
  (same PR if the class is dead).

**Do not:**

- Add new `.pdpp-frontdoor__*` / layout BEM for work that can be a util or a local comp.
- “Fix” layout by growing `components.css` when a JSX wrapper + `cn(...)` would do.
- Merge editorial into `@pdpp/brand`. Concept chrome keeps `text-ink` / `bg-paper`; shared `Text` colors use brand names that the surface remaps.

**Still BEM for now** (specificity / cascade hooks — migrate deliberately, don’t ghost-delete):

- `.pdpp-concept` surface (type, links, paper)
- `.pdpp-doc` prose/table/cmd scoping
- `.pdpp-cta*` (beats `.pdpp-concept a`)
- rail sticky behavior until its component owns it

Site agent notes: [`apps/site/AGENTS.md`](../../apps/site/AGENTS.md). Site composition:
[`apps/site/src/styles/site.css`](../../apps/site/src/styles/site.css). Brand package:
[`packages/pdpp-brand/README.md`](../../packages/pdpp-brand/README.md). Visual language (console/operator, not concept):
[ink-carbon/](./ink-carbon/).

## Surfaces → systems

| Surface | App / package | Style system |
| --- | --- | --- |
| Operator console, sandbox, shared product UI | `apps/console`, `@pdpp/operator-ui`, site `/sandbox` | **Brand** — `@pdpp/brand` + TW |
| Public marketing / concept | site `/`, `/self-host`, `/participate`, root 404 | **Concept** — route shell + components + concept tokens |
| Spec docs chrome | site `/specification` | Both — Fumadocs + `styles/surfaces/specification.css` under `[data-pdpp-doc-theme]` |

## Format mechanically (Biome / Ultracite)

- Formatter: **Biome** via Ultracite. Workspace [`.vscode/settings.json`](../../.vscode/settings.json): format on save + Biome for JS/TS/JSON/CSS. Do not hand-reflow JSX — the next save undoes it.
- Repo `lineWidth` is **120** (Ultracite default is 80). Soft-wrap column must match (`editor.wordWrapColumn: 120`).
- After edits: `pnpm exec biome check --write <files>` (or package `format` / lefthook). No local `joinClassNames` / Prettier.

## Class names: always `cn`

```ts
// Brand (source of truth for brand @theme scales):
// packages/pdpp-brand/lib/tw-merge.ts → @pdpp/brand/tw-merge

// Console / operator-ui: thin wrapper around brand cn (keep @/lib/utils for shadcn).
// Site: concept theme keys + withPdppBrand — apps/site/src/lib/utils.ts
```

shadcn → `"utils": "@/lib/utils"`. Use `cn` for conditional / merged classes. Do not hand-roll `filter(Boolean).join`.

Brand `cn` / `withPdppBrand` registers custom `--text-*` / `--spacing-*` /
`--container-*` / `--radius-*` from brand `styles/tokens/semantic.css` — including the
whole eight-rung type ladder (`eyebrow` … `hero`) now that `@pdpp/brand-react`'s `Text`
owns it. Site extends that with layout keys only (`pad`, `page`, …). Custom
`--color-*` names need no listing. An unlisted `text-eyebrow` is treated as a
**colour**, so a later `text-ink` would delete it. Keep the brand + site lists
in step with those `@theme` files.

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
- Concept: `apps/site/src/styles/surfaces/concept/tokens/` is composed by the concept surface. It provides short names
  (`text-ink`, `max-w-page`, …). Under `[data-surface="concept"]`, `--spacing-inset` is remapped to concept pad so `container` +
  `max-w-page` is the page chrome.
- Prefer token utils over arbitrary values; arbitrary OK when no token exists.
- Cross-package TW: `@source` is declared by `styles/site.css` for `@pdpp/operator-ui` and `@pdpp/brand-react`.

### Editorial type stack (concept)

One ladder. Shared `Text` speaks **brand/shadcn** utils; the concept surface rebinds the values.

```
brand styles/tokens/semantic.css  →  declares rungs + --color-foreground / muted / primary / …
       ↓
brand-react/text-variants.ts  →  size= / color= → those TW utils (voice only on size)
       ↓
[data-surface="concept"]      →  --foreground ← ink, --primary ← teal, … (tokens/semantic.css)
       ↓                          + type VALUES rebound (concept tokens/semantic.css)
       ↓
pdpp-concept/text.tsx         →  facade: defaults, concept-only colors/sizes, sectionIndex
```

Never put a palette name (`ink`, `teal`, `paper`) in the shared table. Ink is a concept *value*, not the shared *name*.

| Layer | Path | Owns |
| --- | --- | --- |
| **Brand semantic** | [`pdpp-brand/styles/tokens/semantic.css`](../../packages/pdpp-brand/styles/tokens/semantic.css) | shadcn/brand `@theme` (`--color-foreground`, …). Shared `Text` contract. **Sole declaration site for the eight type rungs** (`eyebrow` · `small` · `body` · `lede` · `heading` · `title` · `display` · `hero`), each setting the full quadruple. |
| **Concept primitives** | [`tokens/primitive.css`](../../apps/site/src/styles/surfaces/concept/tokens/primitive.css) | Runtime palette `--pdpp-concept-*` (+ dark) and BEM rule borders only. Not layout or fonts. No comments inside `:root`/`[data-theme]`; formatter disabled. |
| **Concept semantic** | [`tokens/semantic.css`](../../apps/site/src/styles/surfaces/concept/tokens/semantic.css) | Layout `@theme` + `[data-surface="concept"]` palette/type rebind. Fonts: brand `--font-*` via `site.css` — BEM uses `var(--font-serif)` etc., not concept primitives. |
| **Text variants** | [`brand-react/text-variants.ts`](../../packages/pdpp-brand-react/src/text-variants.ts) + [`text.tsx`](../../packages/pdpp-brand-react/src/text.tsx) | CVA over brand utils. No sectionIndex, no concept-only colors. |
| **Concept facade** | [`pdpp-concept/text.tsx`](../../apps/site/src/components/pdpp-concept/text.tsx) + [`text-variants.ts`](../../apps/site/src/components/pdpp-concept/text-variants.ts) | Defaults, concept-only colors/sizes (CVA), section-index chrome. |

#### Text ownership (read this before editing variants)

**token owns metrics · CVA owns voice · packaging does not re-emit the rung.**

| Concern | Owner | Do |
| --- | --- | --- |
| Size / lh / tracking / weight | `--text-{rung}` (+ `--text-{rung}--*`) | Rebind under the surface selector. Never hardcode `tracking-[…]` / `text-[11px]` on a size that has a rung. |
| Voice (uppercase, nowrap, default family) | brand-react `size` | e.g. `eyebrow` = `text-eyebrow uppercase …` — no metrics. |
| Color | `color=` axis only | Size ⊥ color. No compounds that remap `foreground` → muted for “label” sizes. Soft labels say `color="muted"`. |
| Wrap policy | `wrap=` + size compounds gated on `wrap="normal"` | One axis — no boolean `balance` dupe. |
| Surface packaging | concept facade | `stamp` / `callout` / `deck`, concept colors, `sectionIndex`. Stamp **maps** to brand `size="eyebrow"` and only adds chip extras (`tabular-nums`, default primary). |
| Contextual token tweak | surface CVA or CSS | e.g. concept `text-variants` stamp compound variant `[--text-eyebrow--letter-spacing:0.04em]` — rebind the var on the host, don’t fight utilities. |

**Anti-patterns (clankers hit these):**

- Duplicating `text-eyebrow` + uppercase + tracking in concept because `stamp` “needs” them — map stamp → eyebrow instead.
- Empty CVA variant stubs just so a compound can match — prefer a CSS var rebind or a facade `className` ternary.
- `tracking-[0.08em]` (or any metric) in CVA when `--text-eyebrow--letter-spacing` already exists.
- Size→color soft-defaults (`eyebrow`+`foreground` ⇒ muted). That lies about `color="foreground"`.
- A second `@theme` type ladder on a surface (collides at `:root` with brand).
- Palette words (`ink`, `teal`) in brand-react `text-variants.ts`.
- Parallel props that emit the same class (`link` / `underline`) — keep **`link`** → `link-prose` in [`packages/pdpp-brand/styles/utilities.css`](../../packages/pdpp-brand/styles/utilities.css); there is no `underline` prop. Do not redeclare `link-prose` on a surface.

**Shared colors** (prop → brand util → concept value via remap):

| `color=` | Utility | Concept binds |
| --- | --- | --- |
| `foreground` (default) | `text-foreground` | `--pdpp-concept-ink` |
| `muted` | `text-muted-foreground` | `--pdpp-concept-ink-soft` |
| `primary` | `text-primary` | `--pdpp-concept-teal` |
| `background` | `text-background` | `--pdpp-concept-paper` |

**Concept-only colors** (facade → semantic util): `subtle` → `text-foreground-faint`; `accentStrong` → `text-primary-emphasis`; `onWash` → `text-primary-on-wash`; `onAccent*` → `text-on-primary-emphasis*`.

**Color vocabulary:** primitives stay `--pdpp-concept-*` in `primitive.css`. `[data-surface="concept"]` in `tokens/semantic.css` rebinds them to shadcn runtime vars (`--foreground`, `--primary`, …). JSX and CVA use shadcn utilities only (`text-foreground`, `bg-primary-emphasis`, …). Legacy `text-ink` / `bg-paper` / `text-teal` utilities live in `compat-palette.css` as aliases → semantic slots (not → primitives); delete each alias when grep is clean.

**Shared sizes** = ladder 1:1 (`eyebrow` … `hero`). **Concept-only sizes** (facade): `stamp` → brand `eyebrow` + chip extras; `callout`; `deck` (title + normal weight).

**Rules:**

- New type size? Add the rung to **brand** `styles/tokens/semantic.css` (the only declaration site — a second `@theme` with the same rung name collides at `:root` and resolves by import order), set the full quadruple on it, add the name to `pdpp-brand/lib/tw-merge.ts`, then add the size in `brand-react/text-variants.ts`. A surface supplies its own value by rebinding the variable under its selector. If the new size only re-weights or re-colours an existing rung, it is treatment — reuse that rung and add no token.
- Tailwind must scan the package: `styles/site.css` declares `@source` for `@pdpp/brand-react`.
- Concept chrome may still use `text-ink` / `bg-paper` / `text-teal`. Shared `Text` colors use brand names.
- Call sites: `<Text size="…" />` or the matching `text-*` utility — not `text-[20px]` when a rung exists.
- `styles/surfaces/concept/components.css` owns leftover BEM type until call sites move; delete dead rules when unused.

#### Enforcement (tests)

The eight-rung ladder is a **brand contract**. Enforce it once; do not copy the same assertion into concept tests.

| Test file | Owns | Does not own |
| --- | --- | --- |
| [`packages/pdpp-brand-react/src/text.test.ts`](../../packages/pdpp-brand-react/src/text.test.ts) | `textVariants.size` ↔ `--text-{rung}:` in [`pdpp-brand/styles/tokens/semantic.css`](../../packages/pdpp-brand/styles/tokens/semantic.css) (1:1, each size emits `text-{rung}`) | Concept packaging, concept color utils, surface value rebinding |
| [`apps/site/src/components/pdpp-concept/text.test.ts`](../../apps/site/src/components/pdpp-concept/text.test.ts) | Facade behavior — smart quotes default, `sectionIndex` chrome, structural hosts (`li`/`pre`), icon truncation | The ladder list (concept has no `body`/`heading`/… in its CVA table) |
| [`apps/site/scripts/site-surface-ownership.test.ts`](../../apps/site/scripts/site-surface-ownership.test.ts) | Route/surface CSS entrypoint ownership | Type rung names (future site CSS test could live here if needed) |

**Why concept `text.test.ts` is not a duplicate:** `pdpp-concept/text-variants.ts` only declares packaging (`stamp` → brand `eyebrow`; `callout`/`deck` compose existing `text-body`/`text-title`). Editorial rung **values** are rebound in [`concept/tokens/semantic.css`](../../apps/site/src/styles/surfaces/concept/tokens/semantic.css) under `[data-surface="concept"]` — same mechanism as color remapping, not a second `size` axis.

**When you add a rung:** update brand `semantic.css` + `tw-merge.ts` + `brand-react/text-variants.ts`. The brand test fails if any step is missed. Surfaces only rebind `--text-{rung}*` under their selector.

### CVA (class-variance-authority)

Canonical: [`text-variants.ts`](../../packages/pdpp-brand-react/src/text-variants.ts). Same rules for concept buttons and any other site CVA.

- Pass the config **inline** to `cva(...)`. Extracting the whole config object widens `defaultVariants` string literals → `string` and breaks `VariantProps`.
- Shared class fragments used **2+ times** stay as consts. Do **not** flatten them into duplicated long strings. Do not invent a const for a one-shot string.
- CVA accepts `ClassValue` arrays. Prefer `["a", "b", shared]` over `.join(" ")`. Joining duplicates classes, fights Biome `useSortedClasses`, and violates `cn`-only above.
- Compound variants use `className` (not `class`). Prefer compounds for orthogonal interactions (wrap×size, icon×size) — not for smuggling metrics that belong on tokens.
- Do not rewrite structure to chase IDE red — confirm with `pnpm exec biome check <file>` + `tsc`. Biome LSP often shows stale parse cascades while CLI is clean. Fix real `useSortedClasses` via biome `--write`, not by smushing arrays.
- **Biome `noUnresolvedImports` + CVA:** Biome false-positives on packages that ship an `exports` map (`class-variance-authority`, `clsx`, `tailwind-merge`) even when tsc / pnpm / Next resolve them. Do **not** sprinkle `biome-ignore` on imports. Waive at the package `biome.jsonc` (`src/**` override) — same pattern as `apps/site` / `apps/console`; see [`packages/pdpp-brand-react/biome.jsonc`](../../packages/pdpp-brand-react/biome.jsonc). Upstream: [biome#9143](https://github.com/biomejs/biome/issues/9143), [biome#6464](https://github.com/biomejs/biome/issues/6464). Drop the override when Biome’s resolver stops lying.

### Migrating editorial type (BEM → `Text`)

Canonical worked example: [`PdppFrontDoor`](../../apps/site/src/components/pdpp-concept/front-door.tsx) (replaced `.pdpp-hero*` + raw `text-[…]`).

**Method — same PR, in order:**

1. **Read the BEM block** in `styles/surfaces/concept/components.css` — type only (size, lh, color, weight). Layout (grid, pad, max-width, flex) stays on the JSX wrapper.
2. **Confirm the token exists** in `tokens/semantic.css` (or add it from the BEM values; use `clamp` for old `@media`
   steps).
3. **Confirm the size exists** in `brand-react/text-variants.ts` (or add it — treatment like italic/mono/sans lives on other axes, not as a second size).
4. **Swap the call site** to `<Text as="…" size="…" color="…" />`.
5. **Delete dead BEM** from `styles/surfaces/concept/components.css` when nothing references the class.

**What goes where:**

| Concern | Owner |
| --- | --- |
| Type size / lh / tracking / weight | `semantic.css` token (`text-*` util) |
| Voice (eyebrow uppercase/sans) | shared `text-variants` size |
| Color | `<Text color="muted" />` (axis only — size does not imply color) |
| Concept packaging (stamp/callout/deck) | concept facade |
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
| Page title (`h1`) | `as="h1"` `size="display"` |
| Identity line | `size="deck"` |
| Definition | `size="lede"` |
| Amplification | `size="body"` `color="muted"` |
| Status stamp | concept `size="stamp"` `family="mono"` (→ brand eyebrow + primary default; mono tightens tracking via CSS var) |

CTAs stay `pdpp-cta*` until a `ConceptCta` owns that specificity.

```tsx
<div className={cn("flex flex-col gap-7 pt-[clamp(32px,1.5rem+2.4vw,56px)]")}>
  <div className="flex flex-col gap-5">
    <Text as="h1" className="max-w-[20ch]" size="display">…</Text>
    <Text size="deck">…</Text>
    <Text size="lede">…</Text>
  </div>
  <div className="flex flex-col gap-3">
    <Text color="muted" size="body">…</Text>
    <Text color="muted" size="body">…</Text>
  </div>
  <div className="flex flex-wrap gap-x-4 gap-y-3">…CTAs…</div>
</div>
{/* sibling — mt-* OK when outside the copy stack */}
<Text className="mt-7!" color="muted" family="mono" size="stamp" weight="normal">
  {SPEC_STATUS_STAMP}
</Text>
```

Do not add a new `.pdpp-hero__*` block when a size already covers the type. Do not leave the BEM rule after the call site moves.

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
