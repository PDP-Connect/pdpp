<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

### UI / styling (site)

Full guide: [docs/design-system/styling-in-apps.md](../../docs/design-system/styling-in-apps.md).

- **Editorial vs brand:** marketing routes (`.pdpp-concept`) use editorial + `editorial-tokens` (`text-ink`, `bg-paper`, `max-w-measure`, …). Sandbox / product UI uses `@pdpp/brand`. Do not style concept pages with `bg-background` / `text-muted-foreground` when ink/paper exist. Do not merge editorial into brand.
- **Cascade:** `apps/site/src/app/globals.css` — brand → fumadocs → `editorial.css` → `editorial-tokens` → docs.css. Shell: `PdppConceptPage` (`container max-w-page`) / `PdppConceptDoc` (still `pdpp-doc` for type/table scoping).
- **Editorial type stack:** `editorial-tokens/primitive.css` → `semantic.css` `@theme` → `text-variants.ts` + `text.tsx`. BEM → `Text` migration: [styling-in-apps.md](../../docs/design-system/styling-in-apps.md#migrating-editorial-type-bem--text).
- **No comments inside `@theme { }`:** Tailwind IntelliSense is broken on comments inside `@theme` ([#1565](https://github.com/tailwindlabs/tailwindcss-intellisense/issues/1565)). False `{ expected` cascade / red squiggles. CSS is valid; the language server is wrong. Put notes in the file header only (`editorial-tokens/semantic.css`). Remap docs stay on `.pdpp-concept`, not mid-`@theme`.
- **`cn` only:** `import { cn } from "@/lib/utils.ts"`. No hand-rolled `join(" ")` / local clsx. CVA rules: [styling-in-apps.md](../../docs/design-system/styling-in-apps.md#cva-class-variance-authority).
- **CTAs / specificity:** keep `pdpp-cta*` classes — `.pdpp-concept a` beats weak TW. Copy rhythm: parent `flex flex-col gap-*` on `Text` stacks (default); per-`Text` `mb-*!` when you need to break the rule — [styling-in-apps.md](../../docs/design-system/styling-in-apps.md#migrating-editorial-type-bem--text).
- **Format:** Biome on save (workspace `.vscode/settings.json`). `lineWidth` is **120** here (Ultracite default 80). Do not hand-wrap JSX; run `pnpm exec biome check --write` on touched files.
