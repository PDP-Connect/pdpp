# PDPP brand styles

Import `@pdpp/brand/styles.css` once at the application root. It composes the
framework styles, PDPP tokens, global defaults, components, typography and
shared utilities.

## Ownership

| File | Owns |
| --- | --- |
| `tokens/primitive.css` | Runtime theme values shared by plain CSS, shadcn-compatible consumers and Tailwind. Light values live in `:root`; `[data-theme="dark"]` overrides the same variables. Theme branching belongs here only. |
| `tokens/semantic.css` | PDPP's Tailwind-facing API. Semantic tokens use plain `@theme` so generated utilities retain the semantic variable and scoped overrides. |
| `tw-merge.ts` | Brand-aware `cn` / `withPdppBrand` for tailwind-merge. Theme keys must match custom scales in `semantic.css`. Apps keep a local `cn` path (shadcn); console/operator-ui wrap brand `cn`; site composes editorial keys on top. |
| `tokens/motion.css` | Runtime durations, easing and reduced-motion token policy. |
| `tokens/tailwind-aliases.css` | Tailwind default scale names and static radius utilities remapped onto PDPP's semantic scale. It does not own PDPP colour, type or spacing vocabulary. |
| `base.css` | `@layer base` — document defaults, element resets, scrollbar, density preference vars, hard reduced-motion stop. Keyframes stay unlayered. |
| `components.css` | `@layer components` — data-surface patterns that utilities may still override. |
| `typography.css` | `@layer components` — shared typography classes. |
| `utilities.css` | `@utility` only — single-purpose helpers (density row, chrome, safe-area). StatusBadge presentation lives with the component in `@pdpp/operator-ui`. |

`tokens/index.css` imports the token files in ownership order. `index.css` is the
package stylesheet and owns the shared `dark:` variant selector.

## Cascade layers

Tailwind injects `theme → base → components → utilities`. Unlayered CSS beats
every layer, so brand sheets that are not `@theme` / `@utility` / `@keyframes`
must declare an explicit `@layer`. Leaf CSS consumes theme tokens; it does not
re-select `[data-theme]`.

## Runtime themes and Tailwind

Runtime variables are the single source for light and dark values:

```css
:root {
  --background: /* light value */;
}

[data-theme="dark"] {
  --background: /* dark value */;
}
```

`semantic.css` registers the runtime value in Tailwind's colour namespace:

```css
@theme {
  --color-background: var(--background);
}
```

This creates utilities such as `bg-background`. Because the utility reads
`--background`, Tailwind utilities, plain CSS and shadcn-compatible code all
follow the same active theme value. Do not duplicate dark values under
`--color-*`.

The same pattern applies to any theme-switched runtime value, including shadows:

```css
@theme {
  --shadow-overlay: var(--overlay-shadow);
}
```

`primitive.css` owns both light and dark `--overlay-shadow` values. The semantic
registration owns the Tailwind namespace and generates `shadow-overlay`.

Reserve `@theme inline` for `tailwind-aliases.css`, where a Tailwind default name
is deliberately remapped onto the PDPP semantic scale.

The bridge currently remaps Tailwind's default text-size utilities, including
their line-height, letter-spacing and font-weight, plus its radius utilities.
For example, `text-2xl` resolves through `--text-heading`, `rounded-lg`
resolves through PDPP's shared radius scale, and the static `rounded-full`
utility resolves through `--radius-pill`.

First-party Tailwind references:

- [Theme variable namespaces](https://tailwindcss.com/docs/theme#theme-variable-namespaces)
- [Referencing other variables](https://tailwindcss.com/docs/theme#referencing-other-variables)
- [Default theme variable reference](https://tailwindcss.com/docs/theme#default-theme-variable-reference)
- [Adding custom styles](https://tailwindcss.com/docs/adding-custom-styles)

## Adding a token

1. If plain CSS, shadcn-compatible code and Tailwind must share a theme-switched
   value, define the runtime value and dark override in `primitive.css`, then
   register it under the correct namespace in `semantic.css`.
2. If only the Tailwind-facing API needs the value, define it directly under the
   correct namespace in `semantic.css`.
3. If the change redirects a Tailwind default name such as `text-base` or
   `rounded-lg` to an existing PDPP semantic rung, put only that remap in
   `tailwind-aliases.css`.
4. If the value should not generate a Tailwind utility, keep it outside `@theme`.

Use a runtime source variable when the value changes by theme or is shared with
plain CSS. Otherwise define the token directly in Tailwind's namespace. Check
Tailwind's namespace table first.

## Verification

```sh
node --test --import tsx \
  apps/site/src/components/theme/theme-runtime.test.ts \
  apps/console/src/components/theme/theme-runtime.test.ts \
  apps/console/src/components/density/density-runtime.test.ts
```

## Follow-ups

Package-local design debt lives here — not in CSS comments (Biome and the
Tailwind language service parse backticks, paths, and parentheses inside
comments as CSS and cascade false errors across the file).

### Call-site / compatibility debt

- [ ] **Numeric treatment** — `--numeric` is applied in console via `.pdpp-num` /
  `[data-numeric]` / `table` (`apps/console/src/app/globals.css`). Many call
  sites also add the Tailwind `tabular-nums` util. Audit and drop redundant
  classes once markers cover those nodes, or drop the token if the util alone
  is enough.
- [ ] **Typography compatibility classes** — `typography.css` `.pdpp-*` wrappers
  still dominate call sites; migrate to semantic `text-*` utilities, then delete.
- [ ] **Hosted-ui surfaces** — reference `hosted-ui.ts` still has its own
  human/protocol stripe recipe; align to brand flat tint when touching that
  layer.

### Token / theme bridge gaps

- [ ] **Motion not bridged** — `--duration-*` / `--ease-*` live only as runtime
  vars in `tokens/motion.css`. No `@theme` registration, so no
  `duration-fast` / `ease-enter` utilities; consumers hand-write `var(...)`.
  Bridge if TW motion utilities are wanted.
- [ ] **Keyframes not theme animations** — `spin` / `fade-in` / `slide-up` in
  `base.css` work as named `@keyframes` (brand-react uses them) but are not
  registered as `--animate-*`, so there is no `animate-fade-in` util.
- [ ] **Status progress ring missing** — success / warning / danger / neutral
  have `--status-*-ring`; progress has bg/fg only. Add a ring or document why
  progress never rings.
- [ ] **Ink Carbon token coverage** — console's `ink-carbon.css` does not
  override newer brand tokens (scrollbar, stage-dot, data-list-divider,
  raised-shadow, focus-shadow, border-shadow-*). Dark console inherits brand
  charcoal values; easy to drift when Ink Carbon retunes neutrals.
- [ ] **`--surface-tint`** — defined in primitive, never bridged to `@theme`,
  barely consumed. Bridge or delete.

### Utilities inventory

These `@utility` helpers in `utilities.css` are kept for later use; they have
~zero product call sites today. Do not delete on sight — confirm before
culling.

- [ ] **`border-shadow` / `border-shadow-brand` / `border-shadow-raised` /
  `border-shadow-overlay`** — themed chrome shadows; unused.
- [ ] **`safe-area-*`** — stream.css still inlines `env(safe-area-inset-*)`
  instead of these utils; adopt when next touched.
- [ ] **`hide-scrollbar`** — overlaps shadcn `no-scrollbar`; pick one when first
  used.
- [ ] **`hr-vertical` / `h-viewport`** — unused; `h-viewport` overlaps
  `min-h-dvh`.
- [ ] **`container`** — intentional override of Tailwind's built-in breakpoint
  container (fixed `--container-content` measure + inset + `mx-auto`). Keep;
  document at call sites when adopted so nobody expects TW's stepped recipe.

### App globals accretion (`apps/site` / `apps/console`)

Brand owns shared tokens + layers. App `globals.css` should stay thin:
imports, `@source`, and app-only token overrides. Feature chrome that
keeps landing in globals recreates the debt this package just cleaned.

Done:

- [x] **Site stream/neko dump removed** — dead fork of console stream CSS
  (no site TSX consumers). Dropped `@demodesk/neko` from `apps/site`.
- [x] **Console stream + neko extracted** —
  `apps/console/.../stream/stream.css`, imported from `stream-viewer.tsx`.
  Includes neko vendor CSS + scroll-lock / dialog / controls / neko overrides.
- [x] **Site `.docs-prose` extracted** — `apps/site/src/styles/docs-prose.css`
  (imported from site globals). Dead duplicate purged from console globals.
- [x] **Stream control transition** uses `--duration-fast` / `--ease-standard`.

Still open:

- [ ] **Stream glass recipe** — button / label / toast still repeat the same
  `color-mix` + blur chrome; optional local `--pdpp-stream-glass-*` vars in
  `stream.css` when next touched.
- [ ] **Stop inventing local CSS vars in app globals** — stream feature-local
  tokens now live in `stream.css`; keep new feature chrome out of globals.
- [ ] **Console numeric base rules** — `.pdpp-num` / `[data-numeric]` /
  `table` remain in console globals (see Numeric treatment above); leave
  until that audit.

Editorial (`--pdpp-concept-*`) and docs Fumadocs overrides stay in
`styles/editorial.css` / `styles/docs.css` — that remains the model.

### Site dual cascade (`apps/site`)

`apps/site` runs **two design systems in one CSS graph** (documented at the
top of `apps/site/src/app/globals.css`):

- brand → sandbox / operator-ui / ThemeProvider
- editorial → marketing (`.pdpp-concept`; page chrome is `container max-w-page` on `PdppConceptPage`)
- docs.css → bridge tax (fumadocs chrome remapped to concept under
  `[data-pdpp-doc-theme]`)

- [ ] **Endgame undecided** — (1) split marketing vs sandbox layout imports,
  (2) pick one palette and map tokens, or (3) keep dual and treat override
  volume as known cost. Today is (3).
- [ ] **Editorial `@theme` bridge** — dormant at
  `apps/site/src/styles/editorial-tokens/` (`primitive.css` duplicates
  `--pdpp-concept-*` runtime values; `semantic.css` bridges TW utilities).
  Import when marketing JSX starts using `bg-paper` / `text-ink` / `p-pad`.
  Do not merge into `@pdpp/brand`. Do not delete the token block from
  `editorial.css` until this package is wired and verified.

### Done in this pass (do not re-open)

- Human/protocol `data-surface` look unified to flat tint in brand
  `components.css`; brand-react attr override removed.
- Global `:focus-visible` box-shadow dropped; `--focus-shadow` /
  `shadow-focus` kept for opt-in.
- Canvas color (`bg-background` / `text-foreground`) set on `html` only.
