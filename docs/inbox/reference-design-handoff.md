# Reference Page Design Handoff

**Date:** 2026-04-15
**Source:** Extended design session spanning 2026-04-08 through 2026-04-15
**Purpose:** Transfer full context to a new agent for continued work on the PDPP reference/landing page

---

## 1. What exists today

### Repository structure
- Monorepo: `apps/web/` is the Next.js app (migrated from `demo/`)
- `packages/pdpp-brand/` contains shared design tokens (`base.css`), type scale, surface semantics
- `demo_archived/` has the previous implementation for reference
- Spec documents at repo root: `spec-core.md` (normative), `spec-collection-profile.md` (normative), others informational
- `/docs` route serves spec via Fumadocs
- `/design` route is the design system page
- `/` is the reference/landing page (the subject of this handoff)

### The reference page
- File: `apps/web/src/components/ReferenceApp.tsx` (~1600 lines)
- 11-section scroll following the "Illustrated Protocol" paradigm
- Sections: Ingest, Inventory, Request, Consent, Grant, Enforce, Sync, Revoke, Export, Multi, Spec
- Hero component extracted to `apps/web/src/components/Hero.tsx` with cross/bleeding layouts and warm/cool/dual gradients
- Global state via `useProtocol` hook connecting sections 4-8 (consent drives grant drives enforcement drives revocation)
- Mock PDPP server (`apps/web/src/lib/mock-server.ts`) does real field projection, incremental sync, revocation enforcement
- Five reusable PDPP components in `apps/web/src/components/pdpp/`: ConsentCard, GrantInspector, StreamInventory, ConnectorCard, SpecCitation
- Each component has exhaustive specimen coverage on `/design` with specimen switchers (27 spec axes, 22 specimens)
- Level 2 detail panels on all 9 content sections with real JSON, HTTP exchanges, and spec citations
- Scroll-triggered animations: field projection (3-phase: show/filter/result), incremental sync, section reveals
- Temperature-coded stepper navigation (copper for human sections, blue for protocol, gray for meta)
- Keyboard navigation (arrow keys for presentation mode)
- Protocol state indicator (bottom-center floating badge showing grant lifecycle)

### Brand/design system
- `packages/pdpp-brand/base.css` is the single source of truth for all tokens
- Type scale: pdpp-display-lg (60px) through pdpp-caption (12px), plus pdpp-eyebrow (mono uppercase)
- Color: OKLCH throughout. `--primary` (blue), `--human` (copper), `--success`/`--warning`/`--destructive` for status
- Surface temperature duality: `data-surface="human"` (copper border + warm wash) vs `data-surface="protocol"` (blue border + cool wash)
- Sidebar width: `--pdpp-sidebar-width` stepped at 1440px (240→280), unified across /design and /docs
- Content width: `--content-width: 760px`, `--content-wide-width: 1200px`
- Motion: duration tiers + easing tokens + semantic aliases, `prefers-reduced-motion` reset at :root
- Body has a subtle radial copper gradient at top-left
- Hero component supports cross layout (sidebar-aligned) and dual gradient (copper meets blue)

### Spec state
- `spec-core.md`: normative. Includes client_display (§5.1), client_claims (§5.2), semantic classes section, stream display metadata (§7)
- `spec-collection-profile.md`: normative. Includes "Collection method abstraction" subsection establishing the polyfill framing
- All other spec-*.md files labeled as informational (non-normative)
- `spec-data-query-api.md` superseded by Core §8

### Key spec concepts for the reference page
- Three semantic classes: protocol-enforced constraints, structured policy declarations, attributed client claims
- client_display is entity-scoped (top-level), client_claims is request-scoped (inside authorization_details) — ChatGPT's correction in a three-model review was decisive
- Stream display.detail is manifest-authored, never client-authored — authorship principle protects trust
- Collection method abstraction: consent/enforcement layers are agnostic to how data was collected
- Polyfill positioning: browser automation when platforms don't cooperate, native APIs when they do, import as fallback. All produce the same RECORD format.

---

## 2. What we were working on when this session ended

### The immediate task
Redesigning the opening section(s) of the reference page to better communicate the collection story (API / browser automation / import) and PDPP's value proposition without over-indexing on personal servers.

### Where we got stuck
We identified that the current opening (Ingest section: "Your data arrives automatically" with a ConnectorCard) pins the narrative to the personal server deployment model. PDPP also works when platforms implement it directly (like OAuth). The page should center the consent-to-enforcement arc, not the infrastructure.

We went through several cycles of research and iteration:

1. **First attempt**: Tighten the Ingest narrative copy to mention all three collection methods. Rejected — felt like copy optimization, not design.

2. **Second attempt**: Add a convergence visual (Platform API / Browser / Import → Your Server). Built and committed (`CollectionConvergence` component in ReferenceApp.tsx). Partially successful — the visual works mechanically but still centers the personal server.

3. **Third attempt**: Research consumer product pages for inspiration (Apple Privacy, 1Password, Notion, Plaid). Finding: the best pages name the *relationship*, not the mechanism. Apple says "Privacy. That's Apple." — not "on-device processing with differential privacy."

4. **Fourth attempt**: Research "scattered to structured" transformation patterns (Monarch Money, 1Password vault, Apple Health, Segment). Finding: Monarch's pattern of normalizing heterogeneous account types into uniform cards is the closest analog. But Monarch is a full dashboard; we need this in a single scroll section.

5. **Where we stopped**: We were trying to define what the opening beat should actually convey. The design brief (`tmp/reference-design-brief.md`) identifies five load-bearing concepts. We debated whether "personal data has structure" is the right opening, concluded it was really setup for the consent card, then questioned whether the consent card should even be the peak. The last exchange was me asking "What should we open with?" and the answer remaining open.

### The unresolved design question
**What is the first beat of the PDPP story, and what should the reader see?**

The constraints:
- Can't center the personal server (it's one deployment model, not the only one)
- Can't center connectors/collection (that's infrastructure)
- Can't open with the consent card directly (needs context)
- Must feel authoritative and inevitable, not selling
- Must work for CEO, engineer, product, and standards audiences simultaneously
- Should make the reader think "I want that" before explaining how it works

The Solid Project is the cautionary tale: they open with "Your data, your choice" and it stays abstract forever. PDPP must show the concrete moment.

---

## 3. Research and strategy documents

### Documents the next agent should read (in priority order)

1. **`tmp/reference-design-brief.md`** — Design brief with audience, content, form, feeling, and anti-goals. The most current synthesis.

2. **`docs/experience-architecture.md`** — The original experience architecture. Describes the "Illustrated Protocol" paradigm, 11 sections, three layers per section (headline/artifact/depth), global state, Gemini review with accepted/rejected changes.

3. **`docs/reference-design-research.md`** — Prior art research on presenting complex systems to mixed audiences. Findings on Illustrated TLS 1.3, Google "How Search Works", Plaid Link architecture. Martini Glass framework. Sidebar width research (added by the owner).

4. **`.claude/working-state.md`** — Current working state with evaluation lens and steering constraints. Read this to understand the project's active constraints.

5. **`docs/full-vision.md`** — The gap between what we promised and what we shipped. Lists what's strong, what's missing, and where the design quality falls short.

6. **`docs/critique-action-plan.md`** — Sequenced improvement plan from the impeccable /critique. Phase 1 (layout) done, Phase 2 (aesthetics) partial, Phases 3-6 have remaining items.

7. **`docs/inbox/collection-method-story-memo.md`** — The settled product framing: API when available, browser automation as polyfill, import as fallback.

8. **`docs/concept-inventory.md`** — 85 PDPP concepts tagged by flow position (spine/branch) and audience (CEO/eng/prod/std).

### Documents about the collection layer (context, not design)
- `docs/research/collection-prior-art-deep-dive.md` — 12 systems analyzed
- `docs/research/collection-layer-boundary-note.md` — Boundary between spec and runtime
- `docs/inbox/boundary-experiments-summary.md` — Three experiments confirming the boundary holds
- `docs/research/collection-method-matrix.md` — Classification of 8 collection methods

### Documents about the spec/repo structure
- `docs/research/pdpp-status-map.md` — Classifies all repo artifacts into 6 buckets
- `docs/inbox/pdpp-status-map-memo.md` — Short version of the status map

---

## 4. Steering constraints (do not drift from these)

These are from key conversation turns that shaped the project direction:

1. **"Stop calling it a demo, start calling it a reference."** It's a system to inspect and build from, not a walkthrough.

2. **The consent card's SLVP quality bar** was set through multi-model review (Claude + Gemini 3.1 Pro + ChatGPT). Same rigor applies to every component.

3. **client_display is entity-scoped, client_claims is request-scoped.** ChatGPT's correction was decisive. This is in the spec.

4. **Stream display.detail is manifest-authored, never client-authored.** The authorship principle protects trust.

5. **"How would a SLVP design expert approach this?"** Don't skip the research and reasoning step.

6. **The reference needs to satisfy the owner proving to HIMSELF** that PDPP is as powerful as he thinks. The best way is to see what he can convey through it.

7. **"The most successful version of any paradigm will penetrate for all audiences in degrees."** Don't over-optimize for one audience.

8. **The polyfill framing**: browser automation is one collection method, not the whole idea. "Native when available, polyfill when necessary" — but the center of gravity is consent, grants, and enforcement, not scraping.

9. **PDPP works without a personal server.** Platforms can implement PDPP directly. The reference page should not make the personal server look mandatory.

---

## 5. Quality standards and tools

### SLVP standard
Stripe / Linear / Vercel / Plaid quality bar. Technically precise, visually restrained, zero decoration that isn't doing work. The feeling: "these people have thought of everything."

### Impeccable design skills
Installed at `.agents/skills/` (symlinked from `.claude/skills`). Key skills:
- `/frontend-design` — design principles, anti-patterns, context gathering
- `/critique` — heuristic evaluation with Nielsen scoring
- `/audit` — technical quality checks (a11y, performance, theming, responsive, anti-patterns)
- `/polish`, `/arrange`, `/typeset`, `/bolder` — targeted refinement commands

Design context is in `.impeccable.md` at project root.

### Last audit results
- Critique score: 28/40 (Good, target 34+)
- Audit score: ~15/20 after P1 fixes
- Main issues: cards as dominant pattern, no visual climax, detail panels need visual structure
- All P1 accessibility issues fixed (keyboard trap, contrast, toggle role, touch targets)

### Strategy alignment hook
`.claude/hooks/check-strategy.sh` fires every 5th turn, injecting `.claude/working-state.md` as context. Contains evaluation lens (honesty, depth, audience, leverage) and steering constraints.

---

## 6. What's been built and shipped (commit history highlights)

### Spec work
- client_display, client_claims, manifest streams[].display added to spec-core
- GNAP reference added to standards table
- "Semantic classes and consent-surface rendering" section
- Collection method abstraction in Collection Profile
- Explicit status labels on all spec-*.md files
- VitePress sidebar restructured by normative weight

### Reference page
- 11-section Illustrated Protocol layout
- Hero with cross layout and dual gradient
- Three section variants (standard, wide, featured)
- Global state connecting sections 4-8 via mock server
- In-memory PDPP server with real field projection, sync, revocation
- Scroll-triggered animations (field projection: 3-phase; incremental sync: 2-phase)
- Level 2 detail panels with real JSON/HTTP on all sections
- Temperature-coded stepper, keyboard nav, protocol state indicator
- Zero-jargon Level 1 copy, Apple-privacy-page tone
- CollectionConvergence visual (committed but may need rethinking per unresolved design question)

### Collection layer
- Three boundary experiments (webhook adapter, file import, scheduler) — all confirmed boundary holds
- Collection Profile conformance test suite: 9 pass, 0 fail, 0 skipped
- Double INTERACTION ambiguity resolved (spec rule stands, removed from test suite, non-normative note added)

### Design system
- Brand package extracted to packages/pdpp-brand/
- Full type scale, motion tokens, surface semantics, sidebar width unification
- Elevation 1 on data-surface cards
- cursor: pointer base rule
- Opacity variants for success/primary/verified/warning wash colors

---

## 7. What the next agent should do

### Immediate: resolve the opening beat
The unresolved question is what the first section should show and convey. The current Ingest section centers the personal server. The design brief says to lead with what PDPP makes possible, not the infrastructure. But we haven't landed on what that looks like.

Read `tmp/reference-design-brief.md` for the full context. The key finding from research: the best products show the "after" state and let the reader's memory of the "before" do the emotional work. For PDPP, the "after" is: your personal data is structured, visible, and controllable.

### Then: tighten the collection story
The convergence visual (`CollectionConvergence` component) makes three collection methods visible but is too infrastructure-focused. It may need to be rethought once the opening beat is resolved. The collection-method-story-memo has the settled framing.

### Then: continue the critique action plan
`docs/critique-action-plan.md` has remaining items across all phases. Phase 1 (layout) is done. Phase 2 (aesthetics) is partial. Phases 3-6 have work remaining.

### Do NOT
- Reopen protocol architecture or propose new profiles
- Draft a Push Profile
- Restructure the spec
- Change the 11-section flow without strong justification
- Skip the research and reasoning step before making design decisions

---

## 8. Files that can be cleaned up

- `tmp/reference-design-brief.md` — keep (active design artifact)
- `tmp/polyfill-positioning-plan.md` — can archive (executed)
- `tmp/polyfill-implementation-memo.md` — can archive (executed)
- `tmp/advisor-boundary-review-package.md` — can archive (reviewed)
- `tmp/double-interaction-ambiguity-memo.md` — can archive (resolved)
- `tmp/ingest-convergence-design.md` — superseded by the actual implementation, can delete
- `tmp/deployment-model-framing.md` — partially relevant to the unresolved opening beat question, keep for now
- Various `.png` screenshots in repo root — delete (artifacts from Playwright screenshots)
