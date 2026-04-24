# Dashboard typography lint — enforcement spec

**Status:** pending-enforcement design note
**Date:** 2026-04-23

## Purpose

During the control-plane symbiosis tranche (2026-04-23) the `apps/web` dashboard was migrated off four anti-patterns:

- arbitrary Tailwind text sizes (`text-[Npx]`) that bypass the `pdpp-*` type scale
- Tailwind default size utilities (`text-sm`, `text-xs`) in dashboard surfaces
- shared class-string constants (`BUTTON_CLASS`, `INPUT_CLASS`, `BUTTON_PRIMARY_CLASS`, `BUTTON_DANGER_CLASS`) that substituted for shadcn primitives
- raw HTML form elements (`<input>`, `<select>`, `<textarea>`, styled `<button>`) where shadcn primitives exist

At time of writing, the dashboard has zero of each (verified by grep). This state is durable only as long as future contributors know the convention. Biome is the repo's lint tool (`ultracite`), but as of 2026-04-23 the `apps/web` workspace is not yet on Biome — a separate "extend Biome up to the web app" tranche is planned.

This note pre-writes the rules so they can be enabled in lockstep with that migration without re-deriving the intent.

## Enforcement rules (to add when `apps/web` joins Biome)

Scope: `apps/web/src/app/dashboard/**/*.{ts,tsx}` only. The rest of `apps/web` (docs pages, `/design` itself, marketing surfaces) is intentionally free to use Tailwind defaults.

Biome's `lint/nursery/noRestrictedSyntax` with JSX/text matchers is the right mechanism. Use regex-based patterns on string literals inside `className=` attributes.

### Rule 1 — No arbitrary text sizes in dashboard

**Pattern (forbidden):**

```
text-\[([0-9]+(?:\.[0-9]+)?)px\]
```

**Message:** "Use a `pdpp-*` class (e.g. `pdpp-caption`, `pdpp-body`) or a `text-pdpp-*` Tailwind utility. See `/design#typography` for the scale."

**Rationale:** `base.css:198` explicitly forbids inline `fontSize` on text anywhere in the app. The `@theme` block in `globals.css` exposes `--text-pdpp-*` tokens; the class system in `packages/pdpp-brand/base.css` exposes `.pdpp-*` classes. There is no size a dashboard surface needs that isn't already in the scale.

### Rule 2 — No Tailwind default size utilities in dashboard

**Pattern (forbidden):** `\btext-sm\b|\btext-xs\b` in `className=` literals under `apps/web/src/app/dashboard/**`.

**Message:** "Prefer `pdpp-body` (14px, matches `text-sm` size) or `pdpp-caption` (12px, matches `text-xs` size). `text-sm`/`text-xs` are allowed in shadcn primitives and shared components but not in dashboard surfaces."

**Rationale:** The shadcn primitives (`Button`, `Badge`) internally use `text-xs`/`text-sm` for variant sizing — that is correct at the primitive layer. Dashboard surfaces compose these primitives and their own layout; allowing `text-sm`/`text-xs` there re-introduces the "which scale am I on?" problem that the `pdpp-*` migration solved.

### Rule 3 — No legacy class-string constants

**Pattern (forbidden):** Imports of any of `BUTTON_CLASS`, `BUTTON_PRIMARY_CLASS`, `BUTTON_DANGER_CLASS`, `INPUT_CLASS` from anywhere.

**Message:** "Use the shadcn primitive: `<Button>`, `<Input>`, or `buttonVariants({ variant, size })` for styling a `<Link>`."

**Rationale:** These constants were deleted in the symbiosis tranche. If the names reappear someone has reintroduced the pattern.

### Rule 4 — Prefer shadcn primitives over raw form elements in dashboard

**Pattern (forbidden in dashboard surfaces):** `<input\b` (except `type="hidden"`), `<select\b`, `<textarea\b`.

**Message:** "Use `<Input>`, `<Select>`, or `<Textarea>` from `@/components/ui/*`. Hidden inputs (`<input type=\"hidden\">`) are allowed for form state."

**Rationale:** The primitives provide focus ring, border, and type rhythm consistency. Hidden form inputs carry no visual treatment and are correctly exempt.

## Exemptions (by design)

- `apps/web/src/components/ui/**` — shadcn primitives themselves. Raw elements and Tailwind defaults are correct here.
- `apps/web/src/app/design/**` — the design-system reference page. It must be free to *demonstrate* all Tailwind utilities, including defaults, to explain what the dashboard opts out of.
- Hidden form inputs (`<input type="hidden">`) — carry no visual treatment.
- The two text-link-style buttons inside `columns-menu.tsx` ("Default" / "Show all") — deliberately unstyled subordinate actions. If the rule flags them the correct response is a per-line ignore comment with the rationale, not a rule weakening.

## Verification before enabling

When adding these rules, run in dry-run first (Biome: `--reporter summary --diagnostic-level info`) and confirm **zero new violations** outside the documented exemptions. The 2026-04-23 state is the baseline — anything the rules flag is a regression that slipped in between this note's date and rule activation.

If regressions exist, fix them before enabling the rules. The rules should never be enabled with an existing ignore list pointing at dashboard code.

## Cross-references

- `/design#typography` — dual-access specimen showing `.pdpp-*` class ↔ `text-pdpp-*` utility parity
- `/design#dashboard` — primitive specimens (PageHeader, Section, DataList, Toolbar, SplitLayout, form elements, etc.)
- `packages/pdpp-brand/base.css:195–278` — the `.pdpp-*` class definitions (source of truth for the scale)
- `apps/web/src/app/globals.css` `@theme` block — the `--text-pdpp-*` Tailwind tokens
- `apps/web/src/components/ui/{button,input,select,textarea,dialog,popover}.tsx` — the primitives the dashboard must consume
- `packages/polyfill-connectors/biome.jsonc` — the existing Biome config pattern to mirror when `apps/web` joins
