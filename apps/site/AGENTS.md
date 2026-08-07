<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

### UI / styling (site)

Full guide: [docs/design-system/styling-in-apps.md](../../docs/design-system/styling-in-apps.md).

- **Owner map:** root layout = HTML/metadata/fonts/providers + `styles/site.css`; concept route-group layout = concept shell,
  masthead, and footer; specification layout = Fumadocs shell/surface; root `not-found` = explicit concept-shell composition.
- **Concept vs brand:** concept routes (`[data-surface="concept"]`) use shadcn semantic utils (`text-foreground`, `bg-background`, `text-primary`, …) with palette values rebound from `--pdpp-concept-*` in `tokens/primitive.css` → `tokens/semantic.css` `[data-surface="concept"]`. Layout (`max-w-page`, …) and fonts (`--font-serif/sans/mono`) use **brand `@theme`** — no `--pdpp-concept-*` copies. Legacy `text-ink` / `bg-paper` aliases remain in `tokens/compat-palette.css` until migrated. Sandbox / product UI uses `@pdpp/brand` as-is. Do not merge concept tokens into brand.
- **CSS ownership:** `styles/site.css` composes site styles;
  `styles/surfaces/concept/{index.css,components.css,tokens/**}` owns the concept surface;
  `styles/surfaces/specification.css` owns specification overrides; `components/docs/prose-page.css` is imported only by
  `ProsePage`.
- **Concept type stack:** brand `@theme` → `@pdpp/brand-react` `text-variants.ts` (shadcn color utils) →
  `[data-surface="concept"]` rebinds `--foreground`/`--primary`/… → concept facade pins defaults + concept-only
  colors + sectionIndex. **token owns metrics · CVA owns voice · packaging does not re-emit the rung.** Size ⊥
  color. Never put a palette word (`ink`, `teal`, `paper`) in the shared table. Full rules + anti-patterns:
  [styling-in-apps.md § Text ownership](../../docs/design-system/styling-in-apps.md#text-ownership-read-this-before-editing-variants).
  Ladder enforcement test lives in `@pdpp/brand-react` only — do not duplicate in `pdpp-concept/text.test.ts`:
  [§ Enforcement (tests)](../../docs/design-system/styling-in-apps.md#enforcement-tests).
- **Type rungs are declared once, in brand:** `eyebrow` · `small` · `body` · `lede` · `heading` · `title` ·
  `display` · `hero` (`packages/pdpp-brand/styles/tokens/semantic.css`, which also documents the five ladder
  invariants). Concept rebinds those variables under `[data-surface="concept"]` — the same mechanism as the
  colors. Do **not** add a `@theme` type block to a surface: this surface is a separate Tailwind entrypoint but
  shares `:root` with the brand stylesheet, so duplicate rung names collide and resolve by import order. A
  size that only re-weights or re-colours a rung is treatment (`deck` = `title` at 400; `stamp` → `eyebrow`) —
  reuse the rung. `concept/index.css` uses `@reference "@pdpp/brand/styles.css"` so `@apply` resolves brand's
  theme without re-emitting it.
- **No comments inside token blocks (`@theme`, `:root`, `[data-surface="concept"]`, `[data-theme="dark"]` in `styles/surfaces/concept/tokens/**`):** Tailwind IntelliSense false `{ expected` cascade ([#1565](https://github.com/tailwindlabs/tailwindcss-intellisense/issues/1565)). CSS is valid; LS is wrong. Notes in file headers only. **`primitive.css`:** runtime palette only (+ dark); formatter disabled. **`semantic.css`:** layout `@theme` (values inline, not `--pdpp-concept-*`) + palette/type rebind. Brand `packages/pdpp-brand/styles/tokens/primitive.css` is different context (`@import`/`@reference`).
- **`cn` only:** `import { cn } from "@/lib/utils.ts"`. No hand-rolled `join(" ")` / local clsx. CVA rules: [styling-in-apps.md](../../docs/design-system/styling-in-apps.md#cva-class-variance-authority).
- **CTAs / specificity:** keep `pdpp-cta*` classes — `.pdpp-concept a` beats weak TW. Copy rhythm: parent `flex flex-col gap-*` on `Text` stacks (default); per-`Text` `mb-*!` when you need to break the rule — [styling-in-apps.md](../../docs/design-system/styling-in-apps.md#migrating-editorial-type-bem--text).
- **Format:** Biome on save (workspace `.vscode/settings.json`). `lineWidth` is **120** here (Ultracite default 80). Do not hand-wrap JSX; run `pnpm exec biome check --write` on touched files.
