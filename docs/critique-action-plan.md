# Critique Action Plan

Source: impeccable /critique run on 2026-04-08
Score: 28/40 (Good — functional but not exceptional)
Target: 34+ (Excellent)

## Sequencing rationale

Layout first (changes spatial container) → aesthetic intensity (fills the container) → depth polish (lives inside it) → protocol completeness (adds content) → responsive (adapts it) → metadata (orthogonal).

Each phase should be committed independently. Later phases should not require redoing earlier ones.

---

## Phase 1: Layout and visual hierarchy

**Goal:** Break the card monotony. Create peaks and valleys in the scroll. Make sections 4 and 6 feel fundamentally different from informational sections.

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 1.1 | Every section wrapped in a card | P1 | Remove card wrapper from FieldProjection and IncrementalSync — let data elements float. Remove card wrapper from Export section. Use section-level background treatment instead of card borders for emphasis. |
| 1.2 | No visual climax in scroll | P2 | Increase spacing before sections 4 and 6. Full-width background wash for consent section. Make enforce section's visualization larger and more central. |
| 1.3 | Uniform vertical rhythm | P2 | Vary section padding: tighter for informational (1, 2, 3), more generous for decisional (4), tightest for the enforce reveal (6). |
| 1.4 | Stepper nav doesn't show temperature | P3 | Color-code stepper labels: copper for human sections (Consent, Revoke, Export), blue for protocol, gray for meta. |

**Commands:** `/arrange` → `/bolder` on sections 4 and 6

## Phase 2: Aesthetic intensity on key moments

**Goal:** The consent section and field projection section should make someone stop scrolling. The hero should establish visual authority.

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 2.1 | Hero protocol flow looks generic | P2 | Rethink as vertical timeline matching the scroll structure, or remove and strengthen title treatment. |
| 2.2 | Field projection is chips, not cinema | P2 | The visualization should feel like watching data flow through a filter, not reading a before/after list. Consider animation that shows the record transforming. |
| 2.3 | Consent section doesn't feel elevated enough | P2 | The warm gradient wash is subtle. Consider extending it, making the background shift more pronounced, adding more vertical breathing room. |
| 2.4 | No moment of genuine surprise | P2 | The page needs one element that makes someone lean forward. Could be the field projection animation, could be the revocation → 403 transition, could be something visual in the hero. |

**Commands:** `/bolder` → `/overdrive` on hero and sections 4, 6

## Phase 3: Detail panel depth polish

**Goal:** Level 2 panels should be as carefully designed as the Level 1 experience. An engineer opening a detail panel should find annotated, structured protocol data — not raw dumps.

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 3.1 | JSON blocks are unformatted dumps | P2 | Add syntax highlighting (key names in one color, values in another). Add inline comments for non-obvious values. |
| 3.2 | Detail panel toggle text is generic | P3 | Make section-specific: "See the grant JSON", "See the HTTP exchange", "See the connector manifest" |
| 3.3 | No visual structure within expanded panels | P2 | Use the protocol-row pattern (border-l-2 pl-3) to create visual grouping within panels. Separate prose from code blocks with spacing. |
| 3.4 | Grant JSON is live but unannoted | P3 | Highlight which fields came from the consent decision vs. which are server-derived. |

**Commands:** `/typeset` → `/polish` on detail panels

## Phase 4: Protocol completeness

**Goal:** Demonstrate the protocol concepts that are currently invisible. Each adds content to existing sections rather than creating new ones.

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 4.1 | Single-use grants invisible | P2 | Add a toggle or variant in the consent section that shows single_use access mode. Grant inspector should reflect the difference. |
| 4.2 | Connector runtime invisible | P2 | In section 1 detail panel, show an animated or interactive START/RECORD/DONE message sequence. |
| 4.3 | Token introspection invisible | P3 | In section 6 detail panel, show the introspection request/response that the RS performs. |
| 4.4 | Tombstones not shown | P3 | In section 7 detail panel, mention tombstones and show the format. |
| 4.5 | Cursor expiry not shown | P3 | In section 7 detail panel, mention the 410 Gone response. |

**Commands:** Add content, then `/polish`

## Phase 5: Responsive and mobile

**Goal:** Every section works on 390px viewport. The experience adapts, not amputates.

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 5.1 | Hero flow diagram truncates on mobile | P2 | Stack vertically on mobile or hide below md. |
| 5.2 | Detail panel code blocks overflow on mobile | P3 | Ensure horizontal scroll works. Consider collapsing to key-value pairs on narrow viewports. |
| 5.3 | Protocol state indicator overlaps Numi bubble | P3 | Move indicator to a different position on mobile, or hide when Numi is present. |

**Commands:** `/adapt`

## Phase 6: Metadata and polish

**Goal:** The URL is shareable. Social previews work. Small details are right.

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 6.1 | No favicon | P3 | Add PDPP favicon (the blue P square). |
| 6.2 | No og:image | P3 | Generate a social preview image (could be a screenshot of the field projection moment). |
| 6.3 | No meta description | P3 | Add meta tags for social sharing. |
| 6.4 | Section-specific detail toggle text | P3 | Already noted in Phase 3. |
| 6.5 | Stepper temperature coding | P3 | Already noted in Phase 1. |

**Commands:** `/polish` → `/audit`

---

## Progress tracking

| Phase | Status | Commits |
|-------|--------|---------|
| 1. Layout and visual hierarchy | TODO | |
| 2. Aesthetic intensity | TODO | |
| 3. Detail panel polish | TODO | |
| 4. Protocol completeness | TODO | |
| 5. Responsive | TODO | |
| 6. Metadata | TODO | |

## Post-fix target

Re-run `/critique` after all phases. Target score: 34+/40.
