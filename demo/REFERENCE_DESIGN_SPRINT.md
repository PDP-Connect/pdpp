# Reference Design Sprint — Working Index

## Status: Phase E (polish + depth)

## Goal
Design and build the PDPP reference implementation experience — one URL that serves as both an interactive protocol reference and a CEO-level presentation artifact.

## Working Files

| File | Purpose | Status |
|------|---------|--------|
| `REFERENCE_DESIGN_SPRINT.md` | This index | Active |
| `docs/experience-architecture.md` | Experience design with Gemini review | Complete |
| `docs/concept-inventory.md` | 85 PDPP concepts enumerated | Complete |
| `docs/reference-design-research.md` | Prior art research | Complete |
| `docs/reference-audit.md` | Strategy fulfillment + honesty audit | Complete |
| `.impeccable.md` | Design context for impeccable skills | Complete |
| `CONSTITUTION.md` | Design principles | Complete |
| `HONEST_REFERENCE.md` | Spec gaps in the current implementation | Reference |

## Completed Work

### Phase A: Page shell + navigation (done)
- 11-section Illustrated Protocol layout
- Labeled stepper navigation (right side lg, inline md)
- Keyboard navigation (arrows, space) for presentation mode
- IntersectionObserver active section tracking

### Phase B: Component integration (done)
- ConsentCard, GrantInspector, StreamInventory, ConnectorCard live in sections
- Components extracted to src/components/pdpp/ — shared between /design and /reference
- Static protocol visualizations for Request, Enforce, Sync, Export

### Phase C: Global state (done)
- useProtocolState connecting sections 4-8
- Consent drives Grant drives Enforce drives Revoke
- 403 grant_revoked when scrolling back to Enforce after revocation
- Reset flow from Consent and Revoke sections

### Phase D: Animations (done)
- FieldProjection: scroll-triggered, staggered field reveal with ease-out-expo
- IncrementalSync: two-phase (first query bars, then delta with green new records)
- Both use IntersectionObserver, fire once, respect GPU-composited properties only

### Phase E: Design overhaul + polish (in progress)
- Hero section added: "Personal Data Portability Protocol" with proposition
- Three section variants: Section (standard), Section (wide), FeaturedSection
- Section labels (INGEST, INVENTORY, etc.) in temperature-coded mono uppercase
- Consent and Enforce use FeaturedSection (larger type, extra padding, gradient wash)
- Wide 2-col grid for sections 1, 2, 5, 7, 8, 9 (text left, component right)
- Level 2 detail panels on all 9 content sections
- Section 11 redesigned as spec mapping table
- SPEC_BASE_URL configurable
- Animation timing refined per impeccable reference guidance

## Remaining Work

### Design quality
- [ ] Mobile responsive pass (stepper hidden, but sections need mobile treatment)
- [ ] Copy polish: Level 1 (zero-jargon audit of all headlines and narratives)
- [ ] Visual connections between sections (state indicator showing grant status)
- [ ] Scroll-triggered entrance animations for section headings
- [ ] Section 3 (Request) could benefit from animation treatment

### Protocol honesty
- [ ] Mock/live toggle architecture (show that enforcement is real, not just illustration)
- [ ] Projection-aware delta (concept 46) — PDPP's most novel property, not shown
- [ ] Single-use grant variant somewhere in the flow
- [ ] Connector runtime (START/RECORD/DONE) visualization

### Infrastructure
- [ ] Update the root `/` route to point to /reference (currently still shows old demo)
- [ ] VitePress deployment verification after spec changes
- [ ] Commit the docs/ files that are gitignored or untracked
