# Reference Design Sprint — Working Index

## Status: IN PROGRESS

## Goal
Design and build the PDPP reference implementation experience — one URL that serves as both an interactive protocol reference and a CEO-level presentation artifact.

## Working Files

| File | Purpose | Status |
|------|---------|--------|
| `REFERENCE_DESIGN_SPRINT.md` | This index — tracks the sprint | Active |
| `docs/reference-design-research.md` | Prior art research (Martini Glass, C4, etc.) | Complete |
| `docs/concept-inventory.md` | All 85 PDPP concepts enumerated | Complete |
| `docs/experience-architecture.md` | The experience design — paradigm, IA, moments | Complete — needs review |
| `docs/visual-language.md` | Visual system for non-UI protocol concepts | TODO |
| `REFERENCE_STRATEGY.md` | Implementation plan (replaces REDESIGN_PLAN.md) | Needs rewrite after design |
| `CONSTITUTION.md` | Design principles — updated this session | Complete |
| `HONEST_REFERENCE.md` | Spec gaps to address | Reference |

## Existing Assets
- 5 reusable PDPP components with specimen switchers (ConsentCard, GrantInspector, StreamInventory, ConnectorCard, SpecCitation)
- Design system: tokens, surfaces, elevation, typography, motion
- `/design` page — live component reference
- 85 concepts enumerated (in agent context, needs documentation)
- 12 protocol flows identified and ranked

## Key Decisions Made
- Martini Glass is the candidate paradigm (stem = guided narrative, bowl = free exploration)
- Human/protocol color temperature system established
- 2-level progressive disclosure max per NN/g research
- Trust model: 3 content layers (protocol facts, server descriptions, client claims)

## Key Decisions Made (this sprint)
- [x] Paradigm: "Illustrated Protocol" — long-scroll, page structure mirrors protocol flow
- [x] 11 sections, each with headline + live component + narrative + expandable depth + spec citation
- [x] Sections 4-8 share global state via useProtocolState() — the Plaid insight
- [x] Labeled stepper navigation, not dots — one-click jump for CEO meetings
- [x] Scroll-triggered micro-animations for protocol visualizations (field projection, sync)
- [x] Strict Level 1 / Level 2 separation — Apple privacy page vs hardcore JSON
- [x] Temperature system handles perspective shifts (human=copper, protocol=blue)

## Key Decisions Needed
- [ ] Visual language spec for protocol animations (field projection, incremental sync)
- [ ] Exact copy for Level 1 headlines and narratives
- [ ] Global state shape (what useProtocolState returns)
- [ ] Transition animations between sections

## Sprint Phases
1. **Experience architecture** — decide the paradigm, IA, and moments
2. **Visual language** — design how non-UI concepts are represented
3. **Prototype the stem** — build the guided narrative
4. **Build the bowl** — connect to explorable depth
5. **Integrate existing components** — wire up ConsentCard, GrantInspector, etc.
6. **Polish and test** — all audiences, all entry points
