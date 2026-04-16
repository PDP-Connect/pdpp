# PDPP Reference Experience Architecture

## The synthesis

Three prior art studies, 85 concept inventory, 12 protocol flows, 5 audience descriptions, and research on SLVP design processes converge on a specific answer.

### What works (from prior art)

**Illustrated TLS 1.3** succeeds because:
- Page structure mirrors protocol structure (reading = understanding sequencing)
- Three layers at every concept: narrative / annotated data / verification
- Accordion collapse lets one page serve three depth levels
- Exhaustive completeness builds "nothing hidden" trust
- Consistent section template creates predictable rhythm

**Google "How Search Works"** teaches us:
- Values-first descent (why before how) builds trust with executives
- But: hub-and-spoke fragmentation loses engineers. In-place progressive disclosure is better.
- But: metaphor over mechanism fails for protocol audiences

**Plaid Link** teaches us:
- The data model that runs the system IS the visualization
- When the production artifact and the description of it are the same object, credibility is structural
- PDPP has this property: the grant IS the consent artifact, the manifest IS the consent surface

### The paradigm: Illustrated Protocol

Not a Martini Glass. Not a dashboard. Not a marketing page.

**An Illustrated Protocol** -- like Illustrated TLS, but for PDPP. A single long-scroll page where the page structure mirrors the protocol flow, every concept gets narrative + live artifact + spec citation, and progressive disclosure lets different audiences read at different depths.

Why this beats the Martini Glass:
- The Martini Glass has a transition problem (when does "stem" end and "bowl" begin?). The Illustrated Protocol is one continuous surface.
- The Martini Glass implies two modes. The Illustrated Protocol has one mode with graduated depth.
- The CEO scrolls and sees the story. The engineer stops and expands sections. The standards reviewer follows the spec citations. Same page, same content, three readings.

Why this beats the current three-panel layout:
- The three-panel layout shows everything simultaneously, which overwhelms. The scroll reveals one concept at a time.
- Panels are spatial (where am I?). Scroll is temporal (what comes next?). The protocol is temporal.
- The scroll can be narrated in a video. Panels cannot.

### The structure

The page follows the PDPP protocol flow. Each "moment" shows one concept with:

1. **A headline** (what's happening, in one sentence)
2. **A live component** (the actual reusable PDPP component, interactive)
3. **A narrative paragraph** (why this matters, in plain English)
4. **A protocol detail panel** (expandable: the spec data, the enforcement rules, the edge cases)
5. **A spec citation** (SpecCitation component linking back to the VitePress spec site)

The live components are NOT mockups or diagrams. They are the real ConsentCard, GrantInspector, StreamInventory, ConnectorCard -- the same components from `/design`, driven by the same specimen data, fully interactive. This is the Plaid insight: the production artifact IS the visualization.

For concepts that don't have a user-facing component (field projection, incremental sync, connector runtime), we need a new visual treatment: **protocol visualizations**. These show data transformations -- before/after comparisons of what the client requested vs. what the RS returned, or a sequence of protocol messages. These use the protocol surface visual language (blue, mono-dominant, `data-surface="protocol"`) and are designed for this page, not reused elsewhere.

### The moments (11 sections)

Each section occupies roughly one viewport height at rest, expanding when the user engages.

#### 1. Your data, your server
**Concept**: Personal data lives on a personal server, organized in streams
**Component**: StreamInventory (compensation specimen, populated)
**Narrative**: "You have a personal data server. It holds your compensation records -- pay statements, equity grants, and benefits enrollments -- organized in streams. This is yours."
**Depth**: Stream semantics (append_only vs mutable_state), connector manifest, record model

#### 2. A connector brings your data in
**Concept**: Connectors collect data from platforms into the server
**Component**: ConnectorCard (compensation profile specimen)
**Narrative**: "A connector is a program that knows how to talk to a payroll portal, equity administrator, or benefits system. It collects your data and stores it in your server's streams."
**Depth**: Connector runtime, START/DONE messages, binding matching (native endpoints, browser automation, or imports as polyfills for platform non-cooperation; consent/enforcement agnostic to collection method), INTERACTION flow

#### 3. An app wants access
**Concept**: A client application sends a selection request
**Component**: New -- SelectionRequestVisualization (shows the RFC 9396 request with client_display and client_claims)
**Narrative**: "Longview, a compensation-planning app, wants your pay statements and equity grants for a career-move review. It tells your server what it wants, who it is, and what it promises."
**Depth**: RFC 9396 envelope, client_display, client_claims, purpose codes

#### 4. You decide
**Concept**: The consent surface presents the request for the user's decision
**Component**: ConsentCard (Research baseline specimen, interactive)
**Narrative**: "Your server shows you exactly what's being requested. Who's asking. What data. What they promise. What your server enforces. You decide."
**Depth**: Attribution split, trust layers, optional streams, AI training consent, display metadata authorship

#### 5. The grant freezes your consent
**Concept**: An immutable grant object captures exactly what was authorized
**Component**: GrantInspector (Active continuous specimen)
**Narrative**: "You said yes. Your server issued a grant -- an immutable record of exactly what you authorized. Fields, streams, time range, access mode, retention terms. Frozen."
**Depth**: Grant immutability, three time concepts, manifest version pinning, view resolution

#### 6. The server enforces your decision
**Concept**: Field projection -- the RS strips unauthorized fields from every response
**Component**: New -- FieldProjectionVisualization (before/after: full record vs. grant-filtered record)
**Narrative**: "Longview queries your server. Your server checks the grant and returns only what you authorized. A pay statement has 8 fields. The grant authorized 4. The response has 4."
**Depth**: Effective filter composition, top-level fields only, request-time filters vs scope, filter on unauthorized field rejection

#### 7. Only what changed
**Concept**: Incremental sync -- continuous access without re-downloading everything
**Component**: New -- IncrementalSyncVisualization (first query vs. delta query, showing changes_since)
**Narrative**: "Next payroll cycle, one new pay statement lands. Longview syncs again and gets only the new record -- not the full compensation history. This is what makes continuous access practical."
**Depth**: changes_since mechanism, projection-aware deltas (concept 46!), cursor vs changes_since tokens, tombstones, cursor expiry

#### 8. You can take it back
**Concept**: Revocation stops future access immediately
**Component**: GrantInspector (switching from Active to Revoked via interaction)
**Narrative**: "You change your mind. One click. The grant is revoked. The next query returns 403. Your server enforces this within 60 seconds."
**Depth**: Revocation propagation window, records from revoked grants, no grant narrowing (revoke-and-reissue)

#### 9. Your data is yours to export
**Concept**: Self-export via owner token, without any grant
**Component**: New -- SelfExportVisualization (owner token query showing full access)
**Narrative**: "You can query your own server with full access. No grant needed. Every field, every stream. This is your data export."
**Depth**: Owner vs client tokens, token kind from introspection, subject scoping

#### 10. Every connector, one protocol
**Concept**: PDPP generalizes across data sources
**Component**: ConnectorCard switcher (Instagram, Spotify, Oura, Gmail)
**Narrative**: "Instagram, Spotify, health data, email -- different sources, same protocol. The consent flow, the grant enforcement, the incremental sync -- all identical regardless of where the data comes from."
**Depth**: Multi-connector architecture, DTI complementary, connector ecosystem

#### 11. The spec is the source of truth
**Concept**: Everything you just saw maps to the spec
**Component**: SpecCitationGroup (showing all referenced sections)
**Narrative**: "Every component on this page implements a section of the PDPP specification. The spec is published, open, and versioned. Read it, build on it, improve it."
**Depth**: Link to VitePress spec site, version axes, conformance requirements

### Visual language for protocol visualizations

Sections 3, 6, 7, and 9 need new visualizations that don't correspond to existing UI components. Design principles for these:

- Use `data-surface="protocol"` (blue border, cool wash)
- Show data transformations as **before → after** side-by-side or stacked comparisons
- Use the mono type treatment for all protocol data
- Annotate the transformation: what was stripped, what was added, why
- Keep to 2 levels of disclosure max (overview visible, detail expandable)
- These are NOT reusable components -- they are illustrations specific to this page
- They should feel like they belong to the same design system (same tokens, same elevation, same spacing)

### The "one screenshot" question

If you could only show one image of PDPP, what would it be?

**Section 6: Field Projection.** A before/after showing a record with 8 fields entering the RS and only 4 coming out the other side, with the grant's field allowlist visible as the filter. This is the visual that makes a CEO go "oh, I get it." It shows consent → enforcement in a single frame.

### The "10 second version"

Someone opens the URL. Before scrolling, they see Section 1: the StreamInventory component showing their personal server with real data (106 following, 22 posts, 47 ad interests). The headline says "Your data, your server." They understand the premise in 10 seconds.

### Navigation

- **No sidebar nav** -- the scroll IS the navigation. This is a designed experience, not a reference manual.
- **Minimal sticky header**: PDPP logo, current section indicator (subtle), link to spec site, link to `/design`
- **Section dots** (like a presentation): vertical dots on the right edge showing position in the 11 sections, clickable to jump
- **Keyboard**: arrow keys or space advance between sections (for video narration)

### Relationship to `/design`

The reference page (`/`) is the presentation artifact. The design page (`/design`) is the engineering workbench. They share the same components but serve different purposes:

| | Reference (`/`) | Design (`/design`) |
|---|---|---|
| **Purpose** | Understand PDPP | Build with PDPP |
| **Audience** | CEO, product, standards, engineers | Engineers |
| **Mode** | Guided scroll with optional depth | Free exploration |
| **Components** | Live, in narrative context | With specimen switchers covering all spec axes |
| **New this page** | Protocol visualizations | -- |
| **Navigation** | Scroll + section dots | Sidebar nav |

### Design review: Gemini 3.1 Pro feedback (2026-04-08)

**Accepted changes:**

1. **Swap sections 1 and 2.** Data flows in before it is inventoried. Start with the connector (how data gets here), then show the inventory (what's here). This is chronologically correct.

2. **Labeled navigation, not dots.** Section dots lack information scent. Implement a sticky stepper/subway map with actual labels: Ingest, Inventory, Request, Consent, Grant, Enforce, Sync, Revoke, Export. One-click jump for CEO meetings. Reinforces the protocol lifecycle mental model.

3. **Scroll-triggered micro-animations for protocol visualizations.** Static before/after diffs require the user to find the difference. Animation does the work for them. Field projection: payload approaches a "grant filter" wall, unauthorized fields bounce off, authorized fields pass through. Incremental sync: timeline with new data points, only the delta travels. These become the GIFs/screenshots the CEO puts in slides.

4. **Strict Level 1 / Level 2 separation.** Level 1 (always visible) must read like an Apple privacy page: zero protocol jargon. Level 2 (expandable) must be unapologetically hardcore: JSON payloads, HTTP headers, spec citations. Never water down Level 2. Never overcomplicate Level 1.

5. **Separate sections 10-11 from the main flow.** They're meta-commentary, not protocol lifecycle. Visual separator or distinct section treatment.

**Considered and partially accepted:**

6. **Global state across sections.** Gemini identified the "uncanny valley" problem: if the user changes the consent card in section 4, does section 6 update? Full global state is engineering-heavy but would be extraordinary. Decision: **yes, do it.** The grant specimen data flows from section 4's consent decision through to section 6's enforcement and section 8's revocation. This is the Plaid insight in action: the artifact IS the system. If the user denies a field in consent, enforcement shows it stripped. This is hard to build but it's the thing that makes this genuinely novel.

7. **Security/trust section.** Gemini says add one between Grant and Enforce. Partially accepted: the trust model is woven throughout (three content layers in section 4, grant immutability in section 5, token introspection in section 6 detail panel) rather than a standalone section. A standalone "how is this secure" section would break the narrative flow. But the detail panels in sections 4-6 should explicitly address the trust question.

**Rejected:**

8. **"Context switch" concern.** Gemini says switching between User/Server/Network perspectives causes cognitive whiplash. I disagree: the temperature system (human=copper, protocol=blue) IS the visual framing that communicates whose perspective you're seeing. The switch is intentional and visible. Every section where you're the user has warm copper; every section where you're seeing the server has cool blue. This is the design system doing its job.

### Revised section order

1. A connector brings your data in (ConnectorCard)
2. Your data, your server (StreamInventory)
3. An app wants access (Selection request visualization)
4. You decide (ConsentCard)
5. The grant freezes your consent (GrantInspector)
6. The server enforces your decision (Field projection animation)
7. Only what changed (Incremental sync animation)
8. You can take it back (GrantInspector revocation, connected to section 5 state)
9. Your data is yours to export (Self-export visualization)
--- visual separator ---
10. Every connector, one protocol (ConnectorCard switcher)
11. The spec is the source of truth (SpecCitation links)

### Global state architecture

Sections 4-8 share state:
- Section 4 (Consent) produces a grant configuration (which streams, which fields, access mode)
- Section 5 (Grant) displays that configuration as an immutable artifact
- Section 6 (Enforce) uses the granted fields to animate the projection
- Section 8 (Revoke) revokes the grant from section 5, and if you scroll back to section 6, enforcement shows 403

This means the page has a `useProtocolState()` hook that threads through sections 4-8. Sections 1-3 and 9-11 are independent.

### Implementation priority (revised)

**Phase A: Page shell and navigation**
1. 11-section scroll structure with headlines and narratives
2. Sticky stepper navigation with labels
3. Keyboard arrow navigation for presentation mode
4. Section transition animations (scroll-triggered)

**Phase B: Existing component integration (sections using built components)**
5. Section 2: StreamInventory (populated Instagram specimen)
6. Section 4: ConsentCard (interactive, drives global state)
7. Section 5: GrantInspector (reads from global state)
8. Section 1, 10: ConnectorCard

**Phase C: Global state**
9. `useProtocolState()` hook threading sections 4-8
10. Section 8: Revocation (connected to section 5 grant)

**Phase D: Protocol visualizations (new, animated)**
11. Section 6: Field projection animation (the hero moment)
12. Section 7: Incremental sync animation
13. Section 3: Selection request visualization
14. Section 9: Self-export visualization

**Phase E: Polish**
15. Level 1 copy pass (zero jargon, Apple-privacy-page tone)
16. Level 2 detail panels (JSON payloads, HTTP headers, spec citations)
17. Section 11: Spec citation links
18. Accessibility audit
19. Video narration mode (keyboard, timing)

### What this is NOT

- Not a three-panel dashboard
- Not a panning canvas
- Not a marketing page with stock photos
- Not a step-through simulator with "next" buttons
- Not an API playground

It is: a designed, scrollable protocol illustration where every section shows the real system running, at whatever depth you choose to engage with.
