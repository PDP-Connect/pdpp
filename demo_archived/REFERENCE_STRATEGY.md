# Reference Implementation UI Strategy

## What changed

The old REDESIGN_PLAN was written before:
- The design system existed (tokens, surfaces, elevation, copy register)
- Five reusable PDPP components were built with full spec coverage
- The CONSTITUTION was reframed from "demo" to "reference implementation"
- The spec gained `client_display`, `client_claims`, and manifest `display` metadata
- GNAP was identified as a future foundation

This document replaces REDESIGN_PLAN.md.

---

## The core design problem

A reference implementation is not a demo. A demo tells a story. A reference implementation is a **building you can enter from any door**.

The current app is a three-column demo (Client | Server | Log) with a single linear flow: idle -> connect -> consent -> scrape -> results. This is the wrong structure for a reference because:

1. **You can't enter from any door.** The consent card only appears during one phase. The grant inspector doesn't exist. Stream inventory is a tiny status bar.
2. **Everything is coupled to the flow.** Components don't make sense without the narrative context of what phase you're in.
3. **The three-panel layout serves debugging, not comprehension.** Showing all three actors simultaneously is useful for developers stepping through the protocol, but it doesn't help someone understand what a consent card is or how grants work.

## What the reference needs to present

Working from the spec and the reusable components, here are the surfaces someone should be able to reach:

### Primary surfaces (the protocol in action)

| Surface | Component | What it shows | Who cares |
|---------|-----------|---------------|-----------|
| **Consent** | `ConsentCard` | A real selection request rendered as a consent decision | Everyone |
| **Grant management** | `GrantInspector` | Active, expired, revoked grants with revocation | Server admins, developers |
| **Data inventory** | `StreamInventory` | What streams the server holds, record counts | Server admins |
| **Connectors** | `ConnectorCard` | Available connectors and their capabilities | Developers |
| **Query results** | (new, TBD) | What the client actually receives after grant enforcement | Developers |
| **Protocol log** | (existing, reworked) | Spec citations, HTTP exchanges, protocol events | Developers |

### Supporting surfaces

| Surface | What it shows |
|---------|---------------|
| **Design system** (`/design`) | Tokens, components, specimen switchers — already built |
| **Spec citations** | `SpecCitation` links back to the VitePress spec site |

## Layout strategy

### Option A: Tabbed single-panel
Each primary surface gets its own tab/route. The user navigates between them. Like Stripe's dashboard — settings, payments, customers are all separate pages.

**Pro**: Each surface gets full width. Self-contained. Enter from any door.
**Con**: Loses the "see the whole protocol at once" value. Doesn't show how the actors interact.

### Option B: Two-panel with focus
Left panel is persistent context (server identity, connector list, active grants). Right panel is the focused surface (consent card, grant inspector, query results). Clicking items in the left panel changes the right panel.

**Pro**: Shows context without overwhelming. Each surface gets dedicated space.
**Con**: Still somewhat linear — what you see depends on what you clicked.

### Option C: Dashboard with cards
All primary surfaces rendered as cards on a single page, each at appropriate size. Consent card is prominent. Grant list below. Stream inventory sidebar. Protocol log collapsible.

**Pro**: Everything visible. Dense but scannable. Enter anywhere by scrolling.
**Con**: Requires careful information hierarchy to avoid overwhelm. The consent card needs to be prominently different from informational cards.

### Recommendation: Option B, evolved

A two-panel layout where:

- **Left panel** is the **personal server** — always present, shows server identity, connector registry (`ConnectorCard` for each), stream inventory (`StreamInventory`), and active grants list (compact `GrantInspector` summaries). This is the "what does my server look like" view.
- **Right panel** is the **interaction surface** — changes based on what's happening. During consent, it shows the `ConsentCard`. After consent, it shows the full `GrantInspector`. During query, it shows results. The protocol log is a collapsible drawer.

This maps to the actual protocol architecture: the personal server is the stable center, and client requests arrive from outside. The left panel IS the server. The right panel is what's happening to it right now.

The key difference from the current three-panel layout: the **client is not a panel**. The client's identity lives inside the consent card and grant inspector — it's part of the protocol data, not a separate actor that needs its own column. The "Audience Lens" client panel goes away. What it showed (grant request, results) moves into the interaction surface.

## Flow vs. exploration

The current linear flow (connect -> consent -> scrape -> results) doesn't disappear, but it stops being the only way to use the reference. The flow becomes one path through the building:

1. A new visitor sees the server with seeded data and no active grants
2. They can trigger a consent request (one of several preset scenarios)
3. The consent card appears in the interaction panel
4. After approval, the grant appears in the server's grant list
5. They can query and see results, revoke the grant, try a different scenario

But they can also:
- Skip the flow entirely and explore the consent card specimens on `/design`
- Inspect a pre-existing grant without going through consent
- Look at the stream inventory without any grants active
- Hit the API directly and watch the protocol log

## Work breakdown

### Phase 1: Extract reusable components to their own files
Move `ConsentCard`, `GrantInspector`, `StreamInventory`, `ConnectorCard`, `SpecCitation` out of `design/page.tsx` into `src/components/pdpp/`. The design page imports them. The reference app imports them. Same components, two consumers.

### Phase 2: Build the server panel
The new left panel: server identity + connector cards + stream inventory + grant list. Uses the reusable components directly. Replace the current `ServerPanel.tsx` (452 lines of inline-styled, flow-coupled code) with a clean composition.

### Phase 3: Build the interaction panel
The right panel: a surface that renders the appropriate component based on what's happening (consent request pending, grant issued, query results, idle). This is the state machine, but it's a content switcher, not a flow controller.

### Phase 4: Extract logic into hooks
`useDemoSession()`, `useGrantFlow()`, `useBrowserScrape()` — same as the old plan, but now the hooks drive the panel composition rather than monolithic components.

### Phase 5: Protocol log as drawer
Rework `LogPanel` to be a collapsible right-edge drawer. Uses `SpecCitation` for protocol references. Subordinate to the main content.

### Phase 6: Browser canvas integration
The live Instagram scraping viewport needs to fit into the new layout. It's a `data-surface="stage"` element in the interaction panel during the scraping phase.

### Phase 7: Multi-connector
Remove Instagram primacy. The server panel shows all connectors as peers. Consent requests can come from different clients for different connectors.

### Phase 8: Accessibility + polish
Contrast, keyboard nav, aria labels, focus states. Final pass.

## What we explicitly do not do

- No new protocol features during redesign (those are in HONEST_REFERENCE.md)
- No Storybook — the `/design` page with specimen switchers serves this purpose
- No theme switcher, no dark mode (light is the right choice for a trust surface)
- No router-based tabs in v1 — the panel layout handles navigation without URL changes
