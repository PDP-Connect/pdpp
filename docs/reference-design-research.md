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
