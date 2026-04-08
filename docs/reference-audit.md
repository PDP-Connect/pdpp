# Reference Page Audit

Date: 2026-04-08
Auditing `/reference` against the experience architecture and protocol honesty.

## 1. Strategy fulfillment

### What the architecture promised

From experience-architecture.md, each section should have:
1. A headline (what's happening, in one sentence)
2. A live component (interactive)
3. A narrative paragraph (why this matters)
4. A protocol detail panel (expandable: spec data, enforcement rules, edge cases)
5. A spec citation (linking to VitePress spec site)

### What we actually shipped

| # | Section | Headline | Live component | Narrative | Detail panel | Spec citation |
|---|---------|----------|---------------|-----------|-------------|--------------|
| 1 | Ingest | Yes | ConnectorCard | Yes | No | No |
| 2 | Inventory | Yes | StreamInventory | Yes | No | No |
| 3 | Request | Yes | Static card | Yes | No | No |
| 4 | Consent | Yes | ConsentCard (interactive) | Yes | No | No |
| 5 | Grant | Yes | GrantInspector (conditional) | Yes | No | No |
| 6 | Enforce | Yes | FieldProjection (animated) | Yes | No | No |
| 7 | Sync | Yes | IncrementalSync (animated) | Yes | No | No |
| 8 | Revoke | Yes | GrantInspector (conditional) | Yes | No | No |
| 9 | Export | Yes | Static card | Yes | No | No |
| 10 | Multi | Yes | ConnectorCard switcher | Yes | No | No |
| 11 | Spec | Yes | SpecCitationGroup | Yes | No | No |

**Missing across ALL sections:**
- Detail panels (Level 2) — none built
- Spec citations per section — none built
- Three-layer structure (narrative / annotated data / verification) from Illustrated TLS — we only have narrative + component

### Verdict: We shipped the skeleton, not the Illustrated Protocol.

The page structure is right (11 sections, correct order, global state works). But we're missing the depth layer that makes this a reference rather than a landing page. An engineer scrolling through sees headlines and components but has no way to go deeper on any section. The "accordion collapse lets one page serve three depth levels" from our Illustrated TLS research — we haven't built any of the accordions.

## 2. Protocol honesty

### What we show vs. what the spec actually says

| What we show | What the spec says | Honest? |
|---|---|---|
| ConsentCard with attribution split | Spec §5 client_display + client_claims | Yes, accurate |
| GrantInspector with revoke | Spec §6 grant lifecycle | Mostly — we don't show the 60s revocation window |
| Field projection (4 of 8 fields) | Spec §8 RS enforcement | Yes, but hardcoded — should derive from grant |
| Incremental sync (22 + 3 delta) | Spec §4.1 changes_since | Simplified — doesn't show projection-aware delta (concept 46) |
| "One-time access" for single_use | Spec §6.4 | We only show continuous in the flow |
| Retention "Deleted after 90 days" | Spec §6.5 retention as policy commitment | Yes, correct — we attribute it properly |
| AI training consent | Spec §5 | Shown in specimen switcher on /design, not in /reference flow |
| Connector runtime | Spec + Collection Profile | We show ConnectorCard but not START/DONE/RECORD messages |
| Self-export | Spec §8.3 owner tokens | Static mockup, not a real demonstration |

### Protocol concepts we claim to show but don't actually demonstrate:

1. **The RS actually enforcing anything.** The field projection is a visual illustration, not a real query hitting a real RS that strips fields. This is a fundamental honesty gap — the reference shows what enforcement *would look like* but doesn't prove it works.

2. **Incremental sync is projection-aware.** Concept 46 (if unauthorized field C changes, record doesn't appear in delta) is one of PDPP's most novel properties. We don't show it at all.

3. **Single-use grant consumption.** We only demonstrate continuous access. The single-use flow (consumed at first token issuance, no STATE persistence) is invisible.

4. **Token introspection.** How the RS resolves a token to a grant is invisible. Engineers evaluating the protocol need to see this.

5. **The connector runtime.** We show a ConnectorCard (the manifest) but not the actual runtime: START message, RECORD streaming, STATE persistence, DONE finalization. This is half the protocol.

### Verdict: The reference is accurate in what it shows, but incomplete. It shows the consent surface well and the enforcement surface visually, but it doesn't prove the system works. The "live" quality we identified as the shared value proposition ("this is real and running") is aspirational — the components are real UI but they're not connected to a running server.

## 3. Specific issues from user feedback

### a. StreamInventory not full width
The `maxWidth: 440px` on components is inconsistent with the `max-w-2xl` (672px) section container. Some components fill the width, others don't.

**Fix**: Components should not have internal max-width. The section layout should control width. The design page can constrain width for specimens, but the reference page should let components be responsive within their section.

### b. Empty states break "enter from any door"
Sections 5, 6, 8 show placeholder text when the grant hasn't been issued. This violates Principle 5.

**Fix**: These sections should show their component in a default/specimen state when protocol state is 'pending', not an empty message. The global state enhancement adds interactivity but the default should be meaningful on its own.

### c. No visual relationships between sections
Sections feel isolated. No visual language connects consent to the grant it produces.

**Fix**: Consider a thin connecting line or animation between sections. Or: a persistent mini-state indicator showing "Grant: active" / "Grant: none" that appears subtly as you scroll through connected sections.

### d. Spec link broken
The SpecCitationGroup in section 11 links to `/spec-core#...` (relative) but the VitePress site is at `pdpp-smoky.vercel.app`. Need to make the base URL configurable.

**Fix**: Add a SPEC_BASE_URL constant. Default to the Vercel deployment URL.

### e. Citation group confusing
The flat list of `§5 Selection Request · §6 Grant · §7 Manifest · §8 Resource Server · §A Purpose Codes` doesn't communicate what it means. No context about why these sections matter.

**Fix**: Section 11 needs a different treatment. Rather than a citation group, show a mapping: "What you saw → What the spec says" with each section of the reference linked to the spec section it implements.

## 4. Recommendations (priority order)

1. **Fix empty states** — show default specimens when protocol state is pending (highest impact, breaks Principle 5)
2. **Add detail panels (Level 2)** — expandable per-section depth with JSON, HTTP, spec citations
3. **Fix spec link URL** — make configurable
4. **Remove maxWidth from components for reference page** — let sections control width
5. **Redesign section 11** — "What you saw → What the spec says" mapping
6. **Add visual connections between sections** — state indicator or connecting lines
7. **Address protocol honesty gaps** — at minimum, acknowledge what's illustrated vs. proven
