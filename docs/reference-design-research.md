# Reference Implementation Design Research

Research conducted 2026-04-08 on how world-class engineering organizations present complex technical systems to mixed audiences.

## Context

PDPP needs a reference implementation that serves as:
1. A CEO presentation artifact (meetings with investors, founders, Linux Foundation)
2. An engineering reference (developers evaluating adoption)
3. A product comprehension tool (head of product understanding the architecture)
4. A standards demonstration (Linux Foundation working group review)
5. A GTM asset (non-technical team creating content)

The core question: can one artifact serve all five, and how do the best organizations approach this?

---

## Finding 1: No one has done this successfully with one URL

No organization in the research has built one URL that serves simultaneously as an interactive reference implementation AND a CEO-level presentation artifact. The closest examples:

- **Illustrated TLS 1.3** (tls13.xargs.org) serves beginners, practitioners, and skeptics from one URL by layering conceptual explanation, raw byte data, and CLI verification. But it's purely educational — not a running system.
- **Plaid Link** uses the same directed graph data model for production, internal tooling, and visualization. But the surfaces are separate (engineering blog, dashboard, developer docs).
- **Stripe** builds from shared Markdoc content but renders separate URLs for product pages (stripe.com/payments), API reference (docs.stripe.com/api), and quickstarts.

**Implication**: If PDPP attempts this, it's genuinely novel. The risk is high but the payoff (a single credible artifact) is proportional.

## Finding 2: The Martini Glass is the strongest candidate paradigm

Segel & Heer (2010) identified three narrative structures for complex data visualization:

1. **Author-driven** (linear narrative, like a presentation)
2. **Reader-driven** (exploratory, like a dashboard)
3. **Martini Glass / Hybrid** — starts with a guided narrative, then opens into free exploration

The Martini Glass maps directly to PDPP's audience split:
- **Stem** (author-driven): A designed walkthrough, ~60-90 seconds. The CEO's presentation path. Shows the protocol's story in ~10 moments.
- **Bowl** (reader-driven): The full interactive reference. Every concept from the narrative is explorable in depth. Engineers bookmark this.

The transition from stem to bowl is the critical design moment. It must be seamless — the executive sees a story; the engineer sees an explorable system; the transition happens naturally.

Source: [Narrative Visualization: Telling Stories with Data (Segel & Heer, 2010)](http://vis.stanford.edu/files/2010-Narrative-InfoVis.pdf)

## Finding 3: How the best organizations decide what to show

### Stripe: Documentation as Product
- Treat documentation with the same rigor as the product itself
- Layered artifact strategy: product pages (buyer), API reference (implementer), quickstarts (first-time dev), guides (intermediate)
- Personalization over segmentation: inject user's real API keys into code samples
- Three-column layout (nav / explanation / live code) lets audiences self-select depth
- Cultural investment: writing classes for engineers, CEO structures emails "like research papers"

Source: [How Stripe builds interactive docs with Markdoc](https://stripe.dev/blog/markdoc)

### Cloudflare: Three-Layer Progressive Disclosure
Cloudflare builds three explicit tiers:
1. **Reference Architectures** — strategic, for CTOs/architects
2. **Design Guides** — prescriptive, for practitioners
3. **Implementation Guides** — tactical, step-by-step for engineers

Each layer has an explicit "intended audience" section. Audiences self-select based on role.

Source: [Cloudflare Reference Architectures](https://developers.cloudflare.com/reference-architecture/)

### Apple: Default Simplicity, Earned Complexity
- The default path is invisible (ATS is just on)
- Explanation unfolds only when you need exceptions
- HIG organized by progressive abstraction: Platforms > Foundations > Patterns > Components > Inputs > Technologies

### Linear: Opinionated Simplicity
- "Simple first, then powerful"
- "Don't invent terms"
- "Short specs are more likely to be read"
- "One really good way of doing things" — opinionated defaults over flexibility

Source: [Linear Method](https://linear.app/method/introduction)

## Finding 4: The 2-level progressive disclosure limit

NN/g research establishes that progressive disclosure achieves "30-50% faster initial task completion while maintaining 70-90% feature discoverability." However, **designs that go beyond 2 disclosure levels typically have low usability because users get lost moving between levels.**

If you need 3+ levels, the design should simplify or chunk advanced features into separate groups.

**Implication for PDPP**: The main reference view should have at most 2 levels of disclosure. Level 1 = protocol flow at the stream level. Level 2 = one-click enforcement/field detail. Anything deeper (cursor mechanics, tombstone format, compound key encoding) belongs in the spec site or `/design` page, not the main reference.

Source: [NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)

## Finding 5: Interactive protocol reference paradigms

Five distinct paradigms exist:

### Paradigm 1: Step-Through Simulation
Examples: OAuth 2.0 Playground, OIDC Playground, OAuth Flow Simulator

Break the protocol into discrete steps. Let users advance through each step, inspecting request/response at each boundary.

**Serves**: Implementers (technical). Does NOT serve executives.

### Paradigm 2: Byte-Level Forensic Narrative
Example: The Illustrated TLS 1.3 (tls13.xargs.org)

Reconstruct an actual protocol session. Each section combines conceptual explanation, raw data, and verification. Progressive disclosure via collapsible sections.

Triple-layer approach: intuition / observation / verification. Serves multiple competency levels simultaneously. **Closest precedent to "one URL serves multiple audiences."**

### Paradigm 3: Schema-Driven Exploration
Examples: Apollo GraphOS Explorer, Redoc, Swagger UI

The schema IS the documentation. Explorers let you click to build queries, see responses, navigate the type system.

**Requires**: A self-describing system. Does not explain architecture or trust boundaries.

### Paradigm 4: Visual System Management
Examples: Kubernetes Lens, IcePanel, Ilograph

Replace CLI with visual resource exploration. Group by logical function, not API taxonomy.

**Serves**: Operators. Not explanatory — shows what IS, not why.

### Paradigm 5: Public "How It Works" Explainer
Example: Google "How Search Works"

Interactive infographic walking general audiences through the system. Uses analogy, visual storytelling, step-by-step narrative.

**Limitation**: Simplification required for general audience means engineers get nothing actionable.

## Finding 6: Visual design systems for protocol visualization

### DFD/STRIDE Notation
The closest existing visual language for protocol visualization:
- 5 symbol types: External Entity, Process, Data Store, Data Flow, Trust Boundary
- Trust boundaries as dashed lines forming zones
- Data flows as labeled arrows
- Deliberately minimal (5 symbols) so "anyone on the team can read"

PDPP's human/protocol color temperature system maps naturally onto this:
- Human surfaces = user-controlled zones
- Protocol surfaces = system-enforced zones  
- Boundaries between them = where PDPP's novel trust guarantees live

Source: [OWASP Threat Modeling Process](https://owasp.org/www-community/Threat_Modeling_Process)

### Plaid's Directed Graph Model
The data model that runs the system IS the visualization. The protobuf-defined workflow graph powers production, the internal no-code editor, and live traffic visualization. No separate "diagram" layer.

Source: [A New Architecture for Plaid Link](https://plaid.com/blog/a-new-architecture-for-plaid-link-server-driven-ui-with-directed-graphs/)

### The Gap
No published, reusable visual design system exists specifically for protocol visualization (analogous to shadcn for UI components). PDPP's human/protocol color system + DFD trust boundary notation could be a first.

## Finding 7: The C4 Model for multi-audience architecture

Simon Brown's C4 model defines four zoom levels:
1. **System Context** — for executives and non-technical stakeholders
2. **Container** — for architects and technical leads
3. **Component** — for developers
4. **Code** — for implementers

Key principle: **never mix levels in one diagram.** Each level is a complete, self-contained view.

Maps to PDPP:
- Context = "user, client app, personal server" (CEO level)
- Container = "AS, RS, connector runtime, connector platforms" (product/architect level)
- Component = "consent card, grant, stream inventory, query API" (developer level)
- Code = "field projection logic, cursor mechanics, introspection caching" (implementer level)

Source: [C4 Model](https://c4model.com/)

## Finding 8: Tufte's Layering and Separation

Edward Tufte's principle: use visual encoding (color, weight, position) to create layers that can be read independently. His "small multiples" pattern — the same visualization repeated across categories — lets readers compare without being overwhelmed.

Applied to PDPP: the human/protocol color temperature IS a Tufte layer. The same consent flow shown as small multiples across scenarios (research, AI training, export) would demonstrate protocol flexibility without overwhelming.

Source: [Envisioning Information (Tufte)](https://www.edwardtufte.com/book/envisioning-information/)

## Finding 9: The "live" quality is the shared value

The strongest argument for one artifact: **the aliveness serves both audiences.**

An executive showing a live, interactive system to investors is more credible than slides. An engineer exploring a live reference implementation learns more than reading a spec. The shared value proposition is "this is real and running."

This is the Plaid insight: the graph that runs the system is the graph that gets visualized. If PDPP's reference implementation's actual data structures are the thing being visualized, the artifact earns credibility from both audiences simultaneously.

---

## Sources

- [Narrative Visualization: Telling Stories with Data (Segel & Heer, 2010)](http://vis.stanford.edu/files/2010-Narrative-InfoVis.pdf)
- [How Stripe builds interactive docs with Markdoc](https://stripe.dev/blog/markdoc)
- [Stripe's payments APIs: The first 10 years](https://stripe.dev/blog/payment-api-design)
- [Cloudflare Reference Architectures](https://developers.cloudflare.com/reference-architecture/)
- [C4 Model](https://c4model.com/)
- [Linear Method](https://linear.app/method/introduction)
- [The Linear Method: Opinionated Software (Figma Blog)](https://www.figma.com/blog/the-linear-method-opinionated-software/)
- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines)
- [A New Architecture for Plaid Link](https://plaid.com/blog/a-new-architecture-for-plaid-link-server-driven-ui-with-directed-graphs/)
- [The Illustrated TLS 1.3 Connection](https://tls13.xargs.org/)
- [The Illustrated TLS 1.2 Connection](https://tls12.xargs.org/)
- [OAuth 2.0 Playground](https://www.oauth.com/playground/)
- [Apollo GraphOS Studio Explorer](https://www.apollographql.com/docs/graphos/platform/explorer)
- [Google: How Search Works](https://www.google.com/intl/en_us/search/howsearchworks/)
- [NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- [OWASP Threat Modeling Process](https://owasp.org/www-community/Threat_Modeling_Process)
- [Microsoft Azure: Design Diagrams](https://learn.microsoft.com/en-us/azure/well-architected/architect-role/design-diagrams)
- [Envisioning Information (Tufte)](https://www.edwardtufte.com/book/envisioning-information/)
- [Lens Kubernetes IDE](https://k8slens.dev/)

---

## Chrome: Sidebar width conventions for design system pages (2026-04-10)

Research prompted by a concrete decision: should `/docs` (the spec reference) and `/design` (the design system page) use the same sidebar width, or should the design system sidebar be narrower because its section labels are short ("Color / Typography / Spacing / Motion")?

### Measured: 10 leading design systems at 1440×900

Outer sidebar rails clustered in a **256–300px band**, median ~288px. No researched site uses a <256px outer rail for a persistent desktop sidebar.

| Site | Outer rail | Inner column | Font | Notes |
|---|---|---|---|---|
| Adobe Spectrum | 256 | 208 | 14/400 | Narrowest inner column |
| Vercel Geist | 260 | 258 | **16**/400 | Design system page |
| Stripe Docs | 280 | — | 14/400 | Product docs (no public design system) |
| Shopify Polaris | 288 | — | **16**/450 | 24.8px line-height |
| shadcn/ui | 288 | 224 | 12.8/500 | Compact outlier |
| Radix Primitives | 290 | 266 | **16**/400 | Spacious chrome |
| GitHub Primer | 300 | 251 | 14/600 | IS the design system |
| Vercel Docs | 300 | — | 14/400 | Product docs |
| Atlassian Design | 350 | — | 14/400 | Density outlier |
| Material Design 3 | 88 (rail) | drawer | — | Non-standard nav rail + drawer |

Linear has no public design system page. Stripe's "Sail" is internal-only.

### Findings

1. **There is no convention of making design system sidebars narrower than docs sidebars.** The only clean A/B case in the research (Vercel Geist 260 vs Vercel Docs 288–300) shows the design system sidebar is only ~28–40px narrower AND switches from 14px to 16px type. Every other design system IS the docs (Primer, Polaris, Radix, shadcn, Spectrum, M3), so there's no second shell to compare.

2. **Short-label handling is done inside the rail, not by shrinking it.** Spectrum runs a 208px inner column inside a 256px outer rail; shadcn runs 224 inside 288. The rail stays mainstream; the content column breathes inward.

3. **Design system pages lean toward larger nav type, not smaller.** Geist (16), Polaris (16), Radix (16) all go 16px. Product docs tend to 14px. The larger-type cluster reads as "design-forward, content-first" — they use *more* horizontal space per item, not less, because each item is bigger and has more padding.

4. **A ~200px outer rail is genuinely off-pattern.** Nothing in the sample goes that narrow at the rail level. A 200px sidebar adjacent to a 268px docs sidebar would make users question whether they navigated to a different product.

### Implication for PDPP

Size `/design` and `/docs` the same at **268px** (Fumadocs's default, squarely inside the mainstream band). If the short section labels feel empty at 268px, follow Geist's pattern: bump nav type from ~13px to 15–16px and increase item padding/line-height, producing the "design-forward" read without breaking chrome alignment with `/docs`.

The principle: **visual continuity across the site chrome is more valuable than optimizing empty space for short labels.** The leading references handle short labels by breathing *inside* a normal-width rail.

### Primary sources

- [Vercel Geist](https://vercel.com/geist/introduction) · [Vercel Docs](https://vercel.com/docs)
- [GitHub Primer](https://primer.style/product/primitives/color/)
- [Shopify Polaris](https://polaris.shopify.com/foundations)
- [Radix Primitives](https://www.radix-ui.com/primitives/docs/overview/introduction)
- [shadcn/ui Docs](https://ui.shadcn.com/docs)
- [Adobe Spectrum](https://spectrum.adobe.com/page/color-system/)
- [Atlassian Design System](https://atlassian.design/foundations/color)
- [Stripe Docs](https://docs.stripe.com/payments/elements)
- [Material Design 3](https://m3.material.io/styles/color/system/overview)

### Responsive behavior

A follow-up question: do these sidebars use fluid widths (clamp/%), or stepped fixed widths per breakpoint? (The initial measurements were all at 1440×900.) Web research on the 2026 convention:

1. **The dominant pattern is stepped fixed widths, not fluid.** Sidebar rails are fixed-per-breakpoint. Fluidity happens in the *content column*, not the rail, because nav-item wrap behavior becomes unpredictable with a fluid width.
2. **Typical stepped recipe** (Tailwind/shadcn/Vercel-style docs):
   - `< 768px` — sidebar hidden behind a drawer/hamburger
   - `md:` (768px+) — ~224–256px fixed rail
   - `lg:` (1024px+) — ~256–288px fixed rail
   - `xl:` (1280px+) — rail stays same, TOC appears on the right
3. **The 2026 "fluid over fixed" zeitgeist refers to content width and typography, not sidebar rails.** Leading design systems still use fixed rails that step at breakpoints.
4. **Container queries are increasingly used inside the sidebar** (for component adaptation), not on the sidebar rail itself.

**Implication for PDPP:** The purest SLVP move is stepped — narrower rail at `md` (e.g. 240px), full 268px at `lg`+. A single 268px rail is acceptable if the audience views at ≥1280px, but stepping matches what Geist/shadcn actually do. Fluid `clamp()` on the rail is off-pattern and would be a distinctive choice *against* convention (not the right place to be distinctive for a docs site).

Sources:
- [Framer: Responsive breakpoints 2026 guide](https://www.framer.com/blog/responsive-breakpoints/)
- [Tailwind CSS responsive design](https://tailwindcss.com/docs/responsive-design)
- [University of Leeds Design System breakpoints](https://designsystem.leeds.ac.uk/docs/breakpoints.html)
- [shadcn/ui Tailwind overrides (Vercel Academy)](https://vercel.com/academy/shadcn-ui/overriding-styles-with-tailwind)

### Applied 2026-04-10 — PDPP sidebar chrome unification

Implemented as `docs/inbox/design-sidebar-slvp-plan.md`. Key decisions and outcomes:

- **Single token:** `--pdpp-sidebar-width` in `packages/pdpp-brand/base.css`, stepped at 1440 (240 → 280). All three `/design` chrome sites (hero blank quadrant, sticky section nav, Docs shell mockup) and the Fumadocs `/docs` layout (`--fd-sidebar-width`) read from the same token.
- **TOC threshold moved from 1280 → 1440.** Fumadocs's default reserves a 268px TOC grid column at `xl` (1280), which starves the content column on narrow desktops. Our override sets `--fd-toc-width: 0px` between 1280 and 1439 and hides the TOC aside.
- **Hero title clamp retuned:** `clamp(2.2rem, 5vw, 3.2rem)` → `clamp(2rem, 3.5vw, 3rem)`. Prevents the H1 from starving narrow columns.
- **CSS import order change:** `@pdpp/brand/docs.css` moved to load *after* `fumadocs-ui/css/preset.css` in `apps/web/src/app/globals.css` so our overrides win the cascade tie against Fumadocs's Tailwind-generated layout classes.

Verified content-column math across four desktop viewports:

| Viewport | Sidebar | TOC | Content | Title |
|---|---|---|---|---|
| 1024 | 240 | 0 | 779 | 1 line |
| 1280 | 240 | 0 | 1019 | 1 line |
| 1440 | 280 | 256 | 899 | 2 lines |
| 1536 | 280 | 256 | 995 | 2 lines |

Every row above 56% content-column ratio. Before this change, `/docs` at 1024 had a 495px content column (48%) with the H1 wrapping to 4 lines.

The Fumadocs framework is treated as a floor, not a ceiling: we override its defaults where they hurt content readability, and we pay the specificity cost of cascading after its generated CSS.

---

## Landing page: first-viewport "proof element" patterns (2026-04-10)

Research prompted by the question: what should live below the hero on `/` to prove PDPP exists and works, without falling into SaaS-template blandness? Measured 13 SLVP-tier technical product landing pages at 1440×900 via Playwright.

### Pattern distribution (n=13)

| Pattern | Count | Sites |
|---|---|---|
| Brand art / abstract visual / illustrated mascot | 6 | Vercel, Plaid, Resend, Neon, Deno, Cloudflare |
| Logo garden as primary proof | 4 | Stripe, Supabase, Clerk, PlanetScale |
| Real product screenshot | 2 | Linear, Railway |
| Code snippet in a styled editor | 1 | Val Town |
| Nothing (text-only hero) | 1 | Cloudflare Workers |
| Live precise stat in hero chrome | 3 | Stripe ("1.63282192% of global GDP"), Supabase/Neon (GitHub stars), Cloudflare ("20% of the Internet") |

### Findings

1. **Visual-first dominates code-first 12:1.** Only Val Town leads with actual code above the fold. Most sites that show code relegate it to scroll-2 or scroll-3. Above-the-fold is for *the promise*, not the *implementation*.

2. **Only 4 sites show anything measurable or live above the fold.** Stripe's GDP percentage is the strongest example — a precise number that's verifiable and updates periodically. GitHub star badges in nav chrome are the lowest-effort version of this. **Zero sites show a live API response above the fold.**

3. **Every strong site commits hard to one primary proof element.** None do the common SaaS mistake of "hero + three feature cards + logo strip + video + stats" all fighting in one viewport. Ruthless singularity of purpose distinguishes SLVP from template tier.

4. **"Developer pattern" is plural, not singular.** Linear shows its product running (evaluate by appearance), Val Town shows code (evaluate by writing), PlanetScale shows monospace prose (evaluate by reading specs), Cloudflare shows scale (evaluate by magnitude). There is no single correct answer — only a correct commitment.

### Protocol vs product

Stripe, Linear, Vercel, et al. sell **products** where a UI screenshot IS the product. PDPP is a **protocol** — there's no "dashboard" equivalent. The transferable patterns for a protocol site are:

- **Val Town's code-in-editor-chrome** — when the thing you sell is code, show the code.
- **Stripe's precise live stat** — a number whose magnitude carries the argument.
- **Linear's product screenshot** — for the one UI a protocol defines (the consent card).

Plaid/Deno/Resend mascot art does NOT transfer without pre-existing brand equity.

### Recommendation for PDPP

**Split proof element: consent card (human view) + `authorization_details` JSON (protocol view)**, layered with a single live metric line above or below the hero title (spec concept count, demonstrated flows, git sha).

This is a hybrid of Linear's product-screenshot pattern and Val Town's code-in-editor pattern — the two strongest individual patterns in the sample. **No competitor in the study does this.** It uniquely embodies PDPP's defining idea: the same event is rendered for two co-audiences (human and machine). That's a differentiator, not just a proof.

Rejected alternatives:
- **Animated flow diagram** — weakest pattern in the set, reads as marketing
- **Stat panel alone** — degrades to dashboard widget without a visual half
- **Consent card alone** — undersells the protocol as "we built an auth modal"
- **JSON alone** — strong but loses the "human + machine" narrative

### Primary sources

- [Stripe](https://stripe.com) · [Linear](https://linear.app) · [Vercel](https://vercel.com) · [Plaid](https://plaid.com) · [Supabase](https://supabase.com) · [Resend](https://resend.com) · [Clerk](https://clerk.com) · [PlanetScale](https://planetscale.com) · [Railway](https://railway.app) · [Neon](https://neon.tech) · [Cloudflare Workers](https://workers.cloudflare.com) · [Val Town](https://val.town) · [Deno](https://deno.com)

Captured screenshots in `.playwright-mcp/*-hero.png` for future reference.

---

## Hero components in SLVP design systems (2026-04-10)

Research prompted by the question: should PDPP's `<Hero>` component be documented as a first-class component on `/design`, or does SLVP practice treat heroes as page-level compositions outside the design system?

### Survey of 10 SLVP-tier design systems

| System | Dedicated Hero? | Notes |
|---|---|---|
| Vercel Geist | **No** | No Hero, no Marketing, no PageHeader. ~50 UI primitives + foundations only. |
| shadcn/ui | **No** | No Hero in components or blocks. |
| GitHub Primer | **Partial** — has `PageHeader` | "Determines top-level headings of a UI." Product chrome, not marketing splash. Also has `PageLayout` / `SplitPageLayout`. |
| Shopify Polaris | **No** | No dedicated Hero, no marketing template. |
| Adobe Spectrum | **No** — has "Feature card" for "hero-like content" | Not a hero component. |
| Atlassian Design | **No** | "Page displays a hero image banner but it's not a reusable component." |
| Ant Design | **No** | No Hero or PageHeader. |
| Material Design 3 | **Different paradigm** — `CollapsingToolbarLayout` / `LargeTopAppBar` | Hero treated as a TopAppBar variant, not a separate component. |
| Radix Primitives | **No** | Unstyled primitives only. |
| IBM Carbon | **No** (inferred) | Partial data; Carbon is product-chrome focused. |

**Zero of the surveyed SLVP systems document a dedicated Hero component.**

### Finding: primitives vs compositions

SLVP design systems document **primitives** — typography scale, color tokens, spacing, buttons, cards, layouts, grids. They do NOT document **compositions** — marketing heroes, pricing tables, splash sections, feature grids. Heroes are page-level compositions built *from* primitives, not reused-enough artifacts to justify component-level documentation.

The only hero-adjacent things SLVP systems document are **product chrome primitives** like Primer's `PageHeader` (which is a generic "top-level heading region", not a splash hero) and Material's `LargeTopAppBar` (a collapsible toolbar, not a marketing hero).

### The nuance: product systems vs block ecosystems

The survey result "zero SLVP systems document a Hero" is true but misleading. The fuller picture:

- **SLVP "product operating system" tier** (Primer, Polaris, Carbon, M3, Spectrum, Ant Design v5, Geist core, shadcn/ui core): **no Hero** — ever. Explicitly scoped to product chrome. Primer's `PageHeader` ("top-level headings of a UI") is the closest and is intentionally not a marketing splash.
- **SLVP "block ecosystem" tier** (shadcn.io blocks, shadcn-ui-blocks marketing, Launch UI, Tailark, shadcndesign): **Hero is first-class and extensively documented** — shadcn.io alone has 64 hero variations; shadcn-ui-blocks has 40 (Progress Tracker, Chat Preview, Social Proof, Gradient Mesh, etc.).
- **Ant Design history is instructive:** `PageHeader` existed in v4, was **removed in v5** and relocated to the separate `@ant-design/pro-components` library. Even product-chrome page headers were deemed out of scope for the core system.

**The community has voted with its files:** heroes belong in a block/recipe layer, not a component library. But they DO belong in a documented layer.

### Implication for PDPP

PDPP is not a pure product design system. It's a spec + reference + brand + marketing surface rolled together, with developer and CEO audiences hitting the same pages. The SLVP separation ("core = product, marketing = external") assumes audiences are separated — PDPP's aren't.

Additionally, the PDPP Hero has a **closed variant space**: 2 layouts × 3 gradients × 2 sizes = 12 configurations. That's exactly the shape of a parameterized component, not an ad-hoc composition. And the primary audience (developers evaluating adoption) has a shadcn-native mental model — blocks and sections as documented first-class entries.

**Decision: document `<Hero>` on `/design`, but in a clearly labeled "Sections" or "Marketing" group, NOT mixed into the primary components list alongside Button and Card.** Mixing it with primitives would be unprecedented at SLVP scale. Separating it into its own section matches the dominant shadcn ecosystem precedent.

Concretely:
1. **Primitives stay in Components section**: `.pdpp-display-lg`, `.pdpp-display`, `.pdpp-body-lg`, Button, Card, ConsentCard, GrantInspector, etc.
2. **Add a new "Sections" group on `/design`**: first-class documentation for `<Hero>`, with the variant matrix (cross/bleeding × warm/cool/dual × compact/splash) demonstrated live.
3. **Hero lives at `apps/web/src/components/Hero.tsx`** (where it is now) and is imported by `/design` for the live demonstrator.

This is "bucking the SLVP product-system convention deliberately" — the agent research was explicit that this is the correct move *because PDPP is not a product system*.

### Deferred — not this session

Per session steering, the highest-leverage current work is content depth (single-use, token introspection, grant field annotation, consent trust model), not design system expansion. **The "Sections" group on `/design` is deferred** but this research locks in the architectural decision when we get there.

### Primary sources

- [GitHub Primer PageHeader](https://primer.style/components/page-header) — product chrome precedent
- [Atlassian Page Header pattern](https://atlassian.design/patterns/page-header) — "patterns" section precedent
- [shadcn.io Blocks (64 hero variations)](https://www.shadcn.io/blocks) — ecosystem precedent
- [shadcn-ui-blocks Marketing Hero Sections](https://www.shadcn-ui-blocks.com/blocks/react/marketing/hero-sections/1) — variant catalog precedent
- [Launch UI Hero component](https://www.launchuicomponents.com/docs/sections/hero) — closest template to what we'd build
- [Material Design 3 Top App Bar large variant](https://m3.material.io/components/app-bars/overview) — size variant precedent
- [Ant Design v4→v5 PageHeader removal](https://5x.ant.design/docs/react/migration-v5/) — evidence that even PageHeader was deemed non-core
