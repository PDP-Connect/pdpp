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

#### 1. Only the granted fields come back
**Concept**: Field projection proves the system works
**Component**: FieldProjectionVisualization (before/after: full pay statement vs. grant-filtered response)
**Narrative**: "Longview queries the server. The server returns the four granted comparison fields and leaves the identity-heavy payroll fields behind."
**Depth**: Effective filter composition, top-level fields only, request-time filters vs scope, filter on unauthorized field rejection

#### 2. A client app requests access
**Concept**: A client application sends a selection request
**Component**: New -- SelectionRequestVisualization (shows the RFC 9396 request with client_display and client_claims)
**Narrative**: "Longview, a compensation-planning app, wants your pay statements and equity grants for a career-move review. It tells your server what it wants, who it is, and what it promises."
**Depth**: RFC 9396 envelope, client_display, client_claims, purpose codes

#### 3. Consent fixes the boundary
**Concept**: The consent surface presents the request for the user's decision
**Component**: ConsentCard (Research baseline specimen, interactive)
**Narrative**: "The server shows exactly what Longview is asking for, what it claims, and what the server will enforce before approval."
**Depth**: Attribution split, trust layers, optional streams, AI training consent, display metadata authorship

#### 4. The grant makes it durable
**Concept**: An immutable grant object captures exactly what was authorized
**Component**: GrantInspector (Active continuous specimen)
**Narrative**: "Approval becomes a durable grant with exact streams, fields, access mode, and time window."
**Depth**: Grant immutability, three time concepts, manifest version pinning, view resolution

#### 5. Only what changed
**Concept**: Incremental sync -- continuous access without re-downloading everything
**Component**: New -- IncrementalSyncVisualization (first query vs. delta query, showing changes_since)
**Narrative**: "Next payroll cycle, one new pay statement lands. Longview syncs again and gets only the new record -- not the full compensation history. This is what makes continuous access practical."
**Depth**: changes_since mechanism, projection-aware deltas (concept 46!), cursor vs changes_since tokens, tombstones, cursor expiry

#### 6. You can take it back
**Concept**: Revocation stops future access immediately
**Component**: GrantInspector (switching from Active to Revoked via interaction)
**Narrative**: "You change your mind. One click. The grant is revoked. The next query returns 403. Your server enforces this within 60 seconds."
**Depth**: Revocation propagation window, records from revoked grants, no grant narrowing (revoke-and-reissue)

#### 7. Your data is yours to export
**Concept**: Self-export via owner token, without any grant
**Component**: New -- SelfExportVisualization (owner token query showing full access)
**Narrative**: "Owner access retrieves full records with no third-party grant at all. Every field, every stream."
**Depth**: Owner vs client tokens, token kind from introspection, subject scoping

#### 8. Records make access exact
**Concept**: Streams give the server something precise to grant and project
**Component**: StreamInventory (compensation specimen, populated)
**Narrative**: "Pay statements, equity grants, and benefits enrollments become records the server can match, project, and revoke."
**Depth**: Stream semantics (append_only vs mutable_state), connector manifest, record model

#### 9. Native where possible, connector-backed where needed
**Concept**: Collection path varies, consent and enforcement do not
**Component**: ConnectorCard (compensation profile specimen)
**Narrative**: "Platforms can implement PDPP directly. Native endpoints, browser automation, and imports can all feed the same compensation records into one grant and enforcement model."
**Depth**: Connector runtime, START/DONE messages, binding matching (native endpoints, browser automation, or imports as polyfills for platform non-cooperation; consent/enforcement agnostic to collection method), INTERACTION flow

#### 10. One protocol across platforms
**Concept**: PDPP generalizes across data sources and reference worlds
**Component**: ConnectorCard switcher (Instagram, Spotify, Oura, Gmail)
**Narrative**: "Compensation planning is one reference world. Subscription review, travel reimbursement, and benefits disputes can use the same grant-and-enforcement model across different sources."
**Depth**: Multi-connector architecture, DTI complementary, connector ecosystem

#### 11. Built on an open specification
**Concept**: Everything you just saw maps to the spec
**Component**: SpecCitationGroup (showing all referenced sections)
**Narrative**: "Every component on this page implements a section of the PDPP specification. The spec is published, open, and versioned."
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

**Section 1: Field Projection.** A before/after showing a record with 8 fields entering the RS and only 4 coming out the other side, with the grant's field allowlist visible as the filter. This is the visual that makes a CEO go "oh, I get it." It shows consent → enforcement in a single frame.

### The "10 second version"

Someone opens the URL. Before scrolling, they see the hero proof: Longview asks for named compensation records, the grant allows four pay-statement fields, and the response returns only four fields. They understand the protocol's core promise in 10 seconds.

### Navigation

- **No sidebar nav** -- the scroll IS the navigation. This is a designed experience, not a reference manual.
- **Minimal sticky header**: PDPP logo, current section indicator (subtle), and docs link
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

### Design review feedback (2026-04-08)

**Accepted changes:**

1. **Lead with proof, not topology.** The current page works better when it starts with enforcement rather than with deployment or collection machinery.

2. **Labeled navigation, not dots.** Section dots lack information scent. Implement a sticky stepper/subway map with actual labels: Ingest, Inventory, Request, Consent, Grant, Enforce, Sync, Revoke, Export. One-click jump for CEO meetings. Reinforces the protocol lifecycle mental model.

3. **Scroll-triggered micro-animations for protocol visualizations.** Static before/after diffs require the user to find the difference. Animation does the work for them. Field projection: payload approaches a "grant filter" wall, unauthorized fields bounce off, authorized fields pass through. Incremental sync: timeline with new data points, only the delta travels. These become the GIFs/screenshots the CEO puts in slides.

4. **Strict Level 1 / Level 2 separation.** Level 1 (always visible) must read like an Apple privacy page: zero protocol jargon. Level 2 (expandable) must be unapologetically hardcore: JSON payloads, HTTP headers, spec citations. Never water down Level 2. Never overcomplicate Level 1.

5. **Move realization-path detail later.** The deployment and collection story matters, but the reader should want the model before being asked to understand the topology.

**Considered and partially accepted:**

6. **Global state across the proof chain.** The grant specimen data must flow from consent through grant, enforcement, sync, and revocation. That is what makes the page feel like the protocol is actually running.

7. **Security/trust section.** Review suggested adding one between Grant and Enforce. Partially accepted: the trust model is woven throughout (three content layers in section 4, grant immutability in section 5, token introspection in section 6 detail panel) rather than a standalone section. A standalone "how is this secure" section would break the narrative flow. But the detail panels in sections 4-6 should explicitly address the trust question.

**Rejected:**

8. **"Context switch" concern.** Review raised that switching between User/Server/Network perspectives causes cognitive whiplash. I disagree: the temperature system (human=copper, protocol=blue) IS the visual framing that communicates whose perspective you're seeing. The switch is intentional and visible. Every section where you're the user has warm copper; every section where you're seeing the server has cool blue. This is the design system doing its job.

### Revised section order

1. Only the granted fields come back (Field projection)
2. A client app requests access (Selection request visualization)
3. Consent fixes the boundary (ConsentCard)
4. The grant makes it durable (GrantInspector)
5. Only what changed (Incremental sync animation)
6. You can take it back (GrantInspector revocation)
7. Your data is yours to export (Self-export visualization)
8. Records make access exact (StreamInventory)
9. Native where possible, connector-backed where needed (ConnectorCard)
--- visual separator ---
10. One protocol across platforms (ConnectorCard switcher)
11. Built on an open specification (SpecCitation links)

### Global state architecture

Sections 1-7 share state:
- Section 2 (Request) names the client and streams
- Section 3 (Consent) produces the grant configuration
- Section 4 (Grant) displays that configuration as an immutable artifact
- Section 1 (Enforce) and Section 5 (Sync) consume the granted fields and current grant status
- Section 6 (Revoke) revokes the same grant, and if you scroll back to Section 1, enforcement shows 403

This means the page has a `useProtocolState()` hook threading the proof chain. Sections 8-11 are explanatory and comparative rather than stateful.

### Implementation priority (revised)

**Phase A: Page shell and navigation**
1. 11-section scroll structure with headlines and narratives
2. Sticky stepper navigation with labels
3. Keyboard arrow navigation for presentation mode
4. Section transition animations (scroll-triggered)

**Phase B: Existing component integration (sections using built components)**
5. Section 8: StreamInventory (populated compensation specimen)
6. Section 3: ConsentCard (interactive, drives global state)
7. Section 4: GrantInspector (reads from global state)
8. Section 9, 10: ConnectorCard

**Phase C: Global state**
9. `useProtocolState()` hook threading sections 1-7
10. Section 6: Revocation (connected to section 4 grant)

**Phase D: Protocol visualizations (new, animated)**
11. Section 1: Field projection animation (the hero moment)
12. Section 5: Incremental sync animation
13. Section 2: Selection request visualization
14. Section 7: Self-export visualization

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
