# Headless component engine for Ink Carbon — SLVP-ideal choice (2026)

> Foundation decision for `@pdpp/brand-react`. Every behaviorally-complex, a11y-bearing
> component (Dialog, Popover, Menu, Tooltip, Tabs, Combobox, Select-as-listbox, the Field
> a11y wiring) is built as an **Ink Carbon token skin** over the engine chosen here.
> Research date: 2026-06-13. Stack: Next.js 16, React 19, Tailwind v4, token-driven CSS.

## 1. Verdict

**Use Base UI (`@base-ui/react`). Keep the current IcDialog on it; build the rest on it.**

Base UI is the SLVP-ideal 2026 choice for a token-driven, headless-only design system on
React 19 / Next 16. It is genuinely unstyled (it ships **zero** CSS — you only get DOM,
behavior, ARIA, and `data-*` state attributes), it is stable (v1.0.0 shipped Dec 11 2025,
now v1.5.0 in May 2026 with active perf-focused releases), it is built by **the original
Radix team together with MUI and Floating UI** — i.e. the people who invented this category
— and its composition model (`className`/`render`-prop/`data-*` state) is purpose-built for
exactly the "apply my own token classes, override nothing" pattern Ink Carbon needs. It is
tree-shakable from a single package, has first-class React 19 / RSC support, and `shadcn`
adopted it as one of its two blessed engines, which de-risks longevity. The two credible
alternatives — Radix and React Aria — are excellent but each loses to Base UI on a specific
axis that matters to us (Radix: feature-frozen incumbent now under WorkOS, Base UI is where
its authors put new work; React Aria: heavier, more opinionated composition, i18n weight we
don't need for an English-first operator console + content site). Picking Base UI also means
**zero migration** — the concurrent IcDialog work is already correct.

Confidence: **high (≈88%)**. The one residual risk is Base UI's youth (12 months at 1.x vs
Radix's multi-year track record); see §6.

## 2. The succession storyline (the crux)

The naive 2024-era narrative — "Radix is dying, everyone moved to Base UI" — is **wrong** in
2026. The real picture is a clean bifurcation into two healthy options with `shadcn` as the
neutral abstraction on top:

- **Base UI is the original Radix team's new effort, now shipped and stable.** The about page
  states plainly it is "From the creators of Radix, Material UI, and Floating UI" — the Radix
  founders + MUI's component team + Floating UI's positioning engine, consolidated into one
  unstyled library. v1.0.0 landed **Dec 11 2025** (the release that renamed the package from
  `@base-ui-components/react` to `@base-ui/react`), and it is at **v1.5.0 (May 19 2026)** with
  releases focused on performance (e.g. "up to 50% faster closed-popup mount, 85% faster
  unmount") and breadth (Combobox, NumberField i18n). This is where the category's inventors
  are putting their forward energy.
  Sources: https://base-ui.com/react/overview/about ·
  https://base-ui.com/react/overview/releases ·
  https://base-ui.com/react/overview/releases/v1-0-0

- **Radix did NOT die — it was transferred to WorkOS and is maintained, but it is the
  incumbent in maintenance mode.** The GitHub repo header now reads "Maintained by @workos",
  it has ~19k stars, `@radix-ui/react-dialog` is at **1.1.16 published ~8 days ago**, and the
  releases page documents **full React 19 + full RSC compatibility** (PRs #2952 and #2923)
  plus a unified tree-shakable `radix-ui` package. So Radix is a safe, still-patched choice —
  but the *new component work and API evolution is happening in Base UI*, not Radix.
  Sources: https://github.com/radix-ui/primitives ·
  https://www.npmjs.com/package/@radix-ui/react-dialog ·
  https://www.radix-ui.com/primitives/docs/overview/releases

- **`shadcn` — the ecosystem bellwether — now supports BOTH, with an identical component
  API.** `npx shadcn create` lets you pick Radix *or* Base UI; the docs ship a full
  `/docs/components/radix/*` and `/docs/components/base/*` tree; the Jan 2026 "Base UI
  Documentation" post frames it as "Same Abstraction, Different Primitives" — the wrapper
  (`import { Dialog } from "@/components/ui/dialog"`) is identical regardless of engine, "only
  the underlying implementation changes." This is the decisive signal: the ecosystem did not
  consolidate onto one engine; it standardized on **Base UI and Radix as co-equal first-class
  choices** and pushed differentiation up into the skin layer — which is exactly our
  architecture (Ink Carbon skin over a swappable engine).
  Sources: https://ui.shadcn.com/docs/changelog/2026-01-base-ui ·
  https://ui.shadcn.com/docs/changelog (Feb 2026 "Blocks for Radix and Base UI") ·
  https://ui.shadcn.com/docs/components/base/dialog

**What this means for us:** Base UI vs Radix is a real, live choice in 2026 — not a "pick the
survivor." We pick Base UI because (a) it is where the same authors put new work, so it has
the longest forward runway; (b) it is the *more* purely headless of the two (Radix's API is
mature but its data-attribute surface is older); and (c) our code is already on it.

## 3. Scorecard

Weights reflect what a Stripe/Linear/Vercel-caliber team optimizes for a shared,
content-site-and-app headless layer. Score 1-5 (5 best). Sources per cell inline.

| Dimension (weight) | **Base UI** | **Radix UI** | **React Aria (RAC)** | **Ark UI (Zag)** |
|---|---|---|---|---|
| **a11y correctness** (×3) | **5** — WAI-ARIA APG patterns, tested across screen readers/devices; built by Radix's original a11y authors. [about] | **5** — long-proven a11y record, the reference standard for years. [radix] | **5** — Adobe's a11y team; the most exhaustively-tested engine; 30+ locales, 13 calendars, RTL. [react-aria/why] | **4** — Zag.js state machines are well-tested but smaller battle-history. [ark npm] |
| **Headless purity** (×3) | **5** — ships *no* CSS at all; pure DOM + `data-*` state + `className`/`render`. [quick-start] | **5** — unstyled primitives, same model, mature. [radix] | **4** — unstyled but ships default `react-aria-*` class names + render-props/slots; slightly more framework-y. [react-aria/components] | **4** — unstyled, but adapter wraps a JS state-machine core (more runtime). [ark] |
| **React 19 + Next 16 RSC/SSR** (×3) | **5** — built in the React-19 era; `"use client"` parts, SSR-safe, single tree-shakable pkg. [quick-start] | **5** — full React 19 + full RSC compat shipped (PR #2952, #2923). [radix releases] | **4** — RSC-compatible (client parts) but provider/i18n context adds client surface. [react-aria] | **4** — works under React 19; heavier client core. [ark] |
| **Bundle cost** (×2, matters for pdpp.dev) | **5** — single tree-shakable pkg, only used components ship; perf releases actively shrinking runtime. [releases v1.5] | **4** — tree-shakable `radix-ui` pkg; mature but per-primitive deps (`react-remove-scroll`, `aria-hidden`). [radix Jan-2025] | **3** — heaviest; i18n message bundles, number/date/calendar machinery pull weight even when unused. [react-aria/why] | **3** — Zag state-machine core + framework adapter per component. [ark] |
| **Maintenance health / longevity** (×3) | **5** — original Radix + MUI + Floating UI teams; v1.x since Dec 2025, monthly releases; shadcn-blessed. [about, releases] | **4** — alive under WorkOS, patched (1.1.16, 8d ago), but incumbent/maintenance posture; authors moved to Base UI. [github, npm] | **5** — Adobe-backed, funded, decade-long runway, frequent releases. [react-aria releases] | **4** — Chakra team, active (5.37.2, 6d ago), smaller org/funding. [ark npm] |
| **API ergonomics for skinning** (×3) | **5** — every part takes `className` (string *or* state-fn), `render` for tag/compose, and exposes `data-open/closed/...` states — ideal for `.pdpp-*` token classes. [dialog API] | **4** — `className` + `data-state="open"` + `asChild`; proven but older attr surface. [radix] | **3** — render-props/slots are powerful but more ceremony; default class names to override. [react-aria/getting-started] | **4** — `asChild`-style + data-attrs, clean but extra primitives per pattern. [ark] |
| **Component coverage** (×2) | **5** — Dialog, Popover, Menu, Tooltip, Tabs, Combobox, Select, **Field** (+OTP, NumberField, ScrollArea). [field, combobox] | **5** — full set incl. Form/Field, Select, Combobox(via shadcn), Tooltip, Menubar, NavMenu. [radix releases] | **5** — exhaustive incl. DatePicker/Calendar, ComboBox, Select, Form. [react-aria/components] | **5** — broad incl. Combobox, DatePicker, ColorPicker, Field. [ark npm] |

**Weighted totals (max 95):** Base UI **93** · Radix **84** · React Aria **80** · Ark UI **77**.

Base UI and Radix are close because they are siblings; Base UI wins on the forward-looking
axes (maintenance trajectory, headless purity, skinning ergonomics, bundle/perf trend).
React Aria is the a11y maximalist but its weight and i18n surface are overkill for an
English-first operator console + marketing/docs site, and its composition model is more
ceremony to skin. Ark UI is a fine framework-agnostic option but offers no advantage over
Base UI for a React-only shop and carries a state-machine runtime.

## 4. Migration implication for us

**Verdict is Base UI → there is NO migration.** The concurrent agent's `IcDialog`
(`packages/pdpp-brand-react/src/dialog.tsx`) is already built on `@base-ui/react/dialog` and
already uses the correct skinning pattern. Confirm and keep going.

**The standard to lock in for every future primitive** (Popover, Menu, Tooltip, Tabs,
Combobox, Select-as-listbox, Field):

- **Engine package:** `@base-ui/react` (single dep, tree-shaken per-component import like
  `@base-ui/react/popover`). Already in `packages/pdpp-brand-react/package.json` at `^1.3.0`
  — bump the floor to a recent 1.5.x when convenient; the 1.x line is stable.
- **Skinning pattern (already in IcDialog, make it the house style):**
  - Pass-through Root/Trigger/Portal/Close with no styling.
  - On each visible part, forward `className` joined with the Ink Carbon token class
    (`pdpp-dialog`, `pdpp-dialog-backdrop`, etc.) and add a `data-slot="..."` hook.
  - Style **off Base UI's `data-*` state attributes** (`data-open`, `data-closed`,
    `data-nested`, `data-starting-style`) in `components.css` — never via JS-toggled classes.
    This keeps the skin declarative and SSR-stable.
  - Where a part needs a different DOM tag or to compose with a native element, use Base UI's
    `render` prop (Base UI's successor to Radix's `asChild`).
- **Console import-swap path:** operator-ui currently imports `@base-ui/react` parts directly
  inside `apps/console/.../components/ui/*` and `@pdpp/operator-ui/ui/*`. Because Ink Carbon
  skins mirror those part surfaces one-to-one (Root/Trigger/Portal/Backdrop/Popup/Title/...),
  swapping a console import to `@pdpp/brand-react` is mechanical — only the styling changes,
  the engine underneath is identical. No behavior risk.

(If the verdict had been Radix or React Aria, migration would still be small — a thin skin is
~30-90 lines per primitive — but it isn't needed. We avoid even that churn.)

## 5. What stays hand-rolled regardless of engine

The zero-interaction visual atoms do **not** touch any headless engine — wiring them to one
would add a client runtime and `"use client"` boundary for no a11y benefit. Confirmed line:

- **Hand-rolled (pure token markup, can be RSC/server components):** Sheet, Table, Tag,
  Endorse, KV, Type, Surface, and the native `<button>`-based **Button** (already in
  `button.tsx`), plus Timestamp. These are static DOM + `.pdpp-*` classes; their a11y is just
  correct semantic HTML.
- **Engine-backed (Base UI skins, `"use client"`):** anything with focus management, ARIA
  state, keyboard interaction, portalling, or dismissal — Dialog, Popover, Menu, Tooltip,
  Tabs, Combobox, Select-as-listbox, and the Field a11y wiring (label/description/error
  association + validation announcements, which Base UI's `Field` provides natively).

The dividing test: **"does it have interactive state a screen reader must be told about, or
focus/keyboard behavior?"** Yes → Base UI skin. No → hand-rolled atom.

## 6. Confidence and open questions

**Confidence: high (≈88%).** The evidence is current (all sources May-Jun 2026), the
ecosystem signal is unambiguous (shadcn treats Base UI as co-equal to Radix), the skinning
ergonomics are a direct fit, and we incur zero migration.

Open questions / residual risk:
1. **Base UI maturity runway.** It is ~12 months at 1.x vs Radix's multi-year history. Risk
   is low (same authors, monthly cadence, shadcn dependency creates ecosystem pressure to
   keep it healthy), and the escape hatch is cheap: because our components are thin skins over
   a part-based API that Radix mirrors, a future fall-back to `@radix-ui/*` is a contained,
   per-primitive rewrite — not a design-system rewrite. This is itself an argument *for* the
   thin-skin architecture.
2. **Exact per-primitive bundle bytes** could not be pinned (bundlephobia is SPA-rendered and
   returned no numbers; npmtrends likewise). The qualitative ranking (single tree-shakable
   pkg, active perf-shrinking releases) is well-evidenced; if a hard kB budget for pdpp.dev
   becomes load-bearing, measure the actual built output of the specific primitives we ship.
3. **Field validation UX** — Base UI's `Field`/`Fieldset` give label/description/error
   association and validity wiring; confirm its native validation messaging matches our form
   patterns when we build the Field skin (low risk; it follows the same `data-*` model).
