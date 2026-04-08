# UI Overhaul Plan — PDPP Reference Implementation

## Current state (observed)

- Dark navy, electric indigo accent, Inter font — generic dark dev-tool aesthetic
- ~3,000 lines across 8 components, all styling inline `style={{}}` objects
- No Tailwind, no shadcn, no component primitives
- Logic and JSX fused in 840-line ClientPanel, 760-line ServerPanel, 721-line DemoPage
- Three-column layout: Client | Server | Log
- Instagram hardcoded as primary connector
- Education layer (⬡ annotations) visually competes with the actual UI

---

## Phase 1 — Aesthetic direction

**Load `/frontend-design` first. Do not write any code until this skill has been applied.**

The skill asks: what problem does this interface solve, who uses it, what's the tone,
what makes it unforgettable? Answer those questions and commit to a specific direction
before touching a single file. The output of this phase is a written aesthetic brief
(a few paragraphs), not code.

This phase gates everything that follows. A wrong aesthetic direction, caught here,
costs nothing. Caught in phase 4, it costs a rewrite.

---

## Phase 2 — Foundation: Tailwind + shadcn + tokens

**Load `/shadcn` when running the install CLI commands.**

1. Install Tailwind CSS v4 into `demo/app`
2. Run `npx shadcn@latest init` — the skill governs component registry, config, and
   which primitives to pull in immediately (Button, Card, Badge, Separator, Tooltip)
3. Migrate `globals.css` custom tokens to shadcn's CSS variable naming convention
   (`--background`, `--foreground`, `--border`, `--muted`, `--accent`) while keeping
   our extension tokens (`--edu-*`, semantic colors)

**Load `/shadcn-primitives-wrappers` before step 3.**

This skill defines the two-layer model: normalized primitives in `components/ui/`,
product wrappers in `components/`). Apply it before writing any wrappers so the
boundary is right from the start.

No visible UI change expected at the end of this phase.

---

## Phase 3 — Text component + typography

**Load `/ui-text` before writing anything in this phase.**

1. Create a `Text` component with semantic intents: `label`, `body`, `caption`,
   `mono`, `eyebrow`
2. Apply it to one component first (LogPanel — smallest, lowest risk) to validate
   the intent set before rolling it out broadly
3. Swap Inter → Geist (already in Next.js 15, zero bundle cost)
4. JetBrains Mono (already installed) stays for technical strings:
   grant IDs, tokens, spec citations, stream names

No layout or color changes yet — typography only.

---

## Phase 4 — Logic extraction

**Load `/vercel-react-best-practices` and `/cognitive-load` together before this phase.**

These two skills together define what goes in a hook vs. a component, how to
limit working memory load, and when extraction is warranted vs. premature.

Extract from DemoPage.tsx:
- `useDemoSession()` — state, phase transitions, WS connection, reset
- `useBrowserScrape()` — scrape trigger, progress, sync state, cursor
- `useGrantFlow()` — grant request, approval, revocation

DemoPage.tsx becomes a ~100-line composition root.

**Load `/vercel-composition-patterns` before decomposing the panels.**

Then break the panels:
- ClientPanel → `ConnectorCard`, `GrantRequest`, `ResultsView`, `SpecFeatureChecklist`
- ServerPanel → `PersonalServerHeader`, `ConsentCard`, `StreamInventory`, `CredentialForm`

---

## Phase 5 — Consent card redesign

**No new skill loads — `/frontend-design` (phase 1) and `/shadcn` (phase 2) cover this.**

The consent card is the most important UX in the spec. It gets its own phase because
it deserves full attention, not a pass during a layout sweep.

Using shadcn `Card` + `Badge` + `Separator`, redesign it to surface:
- Purpose code + human description
- Access mode (`single_use` / `continuous`) in plain language
- `expires_at` — when this authorization ends
- `retention` — how long the client keeps data, what happens on expiry
- Per-stream field enumeration: what's granted *and* what's withheld
- Borrow scope-grouping pattern from `~/code/data-connect/src/pages/grant/components/consent/`

---

## Phase 6 — Layout + visual overhaul

**Load `/web-design-guidelines` at the start of this phase as a review lens.**
Read it, then use it as a checklist while making layout decisions.

1. Apply the aesthetic direction from phase 1 across the full layout
2. Rework the three-column grid — consider LogPanel as a collapsible drawer
3. Education layer (⬡ annotations): visually subordinate, revealed on hover
4. Replace all remaining inline `style={{}}` with Tailwind classes
   — **load `/tailwind-sort`** when class lists get long (8+ classes)
5. Apply badge chip patterns from `~/code/context-gateway/src/components/demo/`
   for data visualization (following accounts, ad topics)

---

## Phase 7 — Multi-connector architecture

**No new skill loads — `/vercel-composition-patterns` (phase 4) covers this.**

1. Remove Instagram primacy — personal server shows a connector registry
2. `ConnectorCard` is generic: any connector renders here
3. Client grant flow decoupled from specific connector
4. Gmail is a peer, not an afterthought

---

## Phase 8 — Final review

**Load `/web-design-guidelines` for a full audit pass.**

Check: contrast, accessibility, keyboard navigation on the consent flow,
aria labels on interactive elements, focus states.

Then do a final `/vercel-react-best-practices` pass for performance:
memoization, bundle size, unnecessary re-renders.

---

## What we explicitly do not do

- No redesign of API routes
- No new protocol features during redesign (those are in HONEST_REFERENCE.md)
- No Storybook, no design token export, no theme switcher
- No over-abstraction: `ConnectorCard` for 2 connectors is fine
