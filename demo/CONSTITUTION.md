# PDPP Reference Implementation — Design Constitution

## What this is

A working implementation of the PDPP protocol that someone can inspect, test against, and build from. Not a demo. Not a walkthrough. A system you can point at and say: "this is what PDPP looks like when it's running."

## Audience

Developers evaluating the protocol for adoption. Product people deciding whether PDPP solves their problem. Engineers building their own PDPP server or client. People who will read the code, hit the API, and compare what they see to the spec.

They don't need to be guided through a story. They need to arrive at any surface — a consent card, a grant inspector, a query response — and understand what it is, what spec section governs it, and how it works.

## Tone

**Linear/Plaid/Stripe meets OAuth.**

Technically precise. Visually restrained. Zero decoration that isn't doing work. Dense information presented with perfect spacing. Monospace where it counts. Every detail signals craft.

Not academic. Not startup-flashy. Not consumer-warm. The closest analogy is Plaid's consent screen or Stripe's dashboard: serious tools built by people who care about both correctness and beauty.

---

## The Five Principles

### 1. The UI is evidence
Every pixel is an argument that the people behind PDPP are world-class. If something looks like a prototype, it undermines the protocol. There is no "we'll polish it later."

### 2. One thing at a time, fully
Pick a surface, make it right, move on. Don't touch five things at 80%. A perfect consent card is worth more than five improved-but-not-right panels.

### 3. Earn decoration
No visual treatment gets added until the structure and semantics underneath it are correct. Color, spacing, and motion are rewards for clean foundations — not patches over unclear thinking.

### 4. Name what things are, not what they look like
Every token, attribute, and class name must answer "what is this?" not "what does it look like?" If you can't answer that question, the thing isn't ready to style.

### 5. Comprehension over narrative
Optimize for someone arriving at any surface and understanding it immediately. Every component should be self-explanatory without context from previous steps. The reference is not a guided tour — it's a building you can enter from any door.

---

## Architecture: three layers

The reference implementation has three distinct layers. Changes to one layer should not require changes to the others.

### Brand layer (shared across all PDPP apps)
- Design tokens: `src/app/globals.css`
- Surface semantics: `data-surface="human"`, `data-surface="protocol"`, `data-surface="stage"`
- Typography: Geist (interface), JetBrains Mono (protocol data)
- Motion: duration/easing tokens, `prefers-reduced-motion` reset

### Component layer (reusable PDPP protocol components)
- `ConsentCard` — the consent decision surface
- `GrantInspector` — the grant receipt and lifecycle view
- `StreamInventory` — what data a server holds
- `ConnectorCard` — a connector's manifest identity
- `SpecCitation` — protocol section references

Each component has typed props with documented provenance (what comes from the client, what from the manifest, what from the server). Each is exercised by specimen switchers covering every spec-valid configuration.

### App layer (this reference implementation)
- Layout, routing, state management, API integration
- Demo flow orchestration (if retained)
- Panel composition
- Log/terminal display

---

## Design Token Decisions

All decisions are reflected in `src/app/globals.css` and visible at `/design`.

### Color
- **Foundation**: shadcn semantic defaults (neutral base)
- **Signature**: `#187adc` → `oklch(0.580 0.172 253.7)` mapped to `--primary`
- **Status tokens** (only custom additions):
  - `--success`: oklch(0.52 0.15 150) — confirmed, active, complete
  - `--warning`: oklch(0.62 0.15 70) — caution, pending
  - `--edu-fg`: oklch(0.55 0.08 270) — spec annotation layer (§ citations)
- **Rule**: Never use raw Tailwind palette colors (e.g. `bg-green-500`). Always use semantic tokens.

### Motion
- **Philosophy**: Productive by default. Expressive is earned. Every animation must answer "does this help the user understand what just happened?"
- **Duration tiers**: `--duration-fast: 100ms` · `--duration-base: 200ms` · `--duration-moderate: 300ms` · `--duration-slow: 500ms`
- **Easing**: `--ease-enter` (decelerate, arrivals) · `--ease-exit` (accelerate, departures) · `--ease-standard` (full arc, state changes) · `--ease-spring` (overshoot, feedback)
- **Semantic aliases**: `--motion-enter` · `--motion-exit` · `--motion-state` · `--motion-feedback`
- **Rule**: Only animate `transform` and `opacity`. Never layout properties. One `prefers-reduced-motion` reset at `:root` covers the entire system.

### Typography
- **Sans**: Geist — interface text, labels, body
- **Mono**: JetBrains Mono — code, IDs, protocol values, timestamps, anything machine-generated
- **Scale**: standard Tailwind (`text-xs`, `text-sm`, `text-base`) — no arbitrary sizes
- **Rule**: Monospace signals "this is data from the protocol, not UI copy."

### Spacing
- Standard Tailwind scale. No arbitrary values.

### Elevation
- Level 0 (flat): page surface, rows, default panels — no shadow
- Level 1 (raised): cards, `data-surface` containers — subtle shadow
- Level 2 (float): dropdowns, command palette
- Level 3 (modal): modals, overlays
- **Rule**: Most UI is flat (level 0). `data-surface` containers get level 1 automatically via CSS.

### Surface Temperature

Every surface in PDPP is either **human** or **protocol**.

- **Human surfaces** belong to the person — their identity, their decision, their consent. They use the warm copper tone (`--human`: `oklch(0.52 0.09 45)`), usually as a 2px left border and/or a `--human-wash` background gradient. Typography is sans-dominant.
- **Protocol surfaces** belong to the system — tokens, spec references, grants, stream names, machine-generated values. They use the protocol blue (`--primary`: `oklch(0.580 0.172 253.7)`). Typography is mono-dominant.

The consent card is the highest-stakes moment of duality: the person (warm) is being asked by the protocol (cool) for permission. Both signals must be present and legible at the same time.

**Rule**: Before styling any surface, answer "whose is this?" If the answer is a person, reach for `--human`. If the answer is the system, reach for `--primary`. If neither applies, it is neutral — no temperature signal at all.

### Surfaces
- `data-surface="stage"` — a neutral surround that frames an independent thing being presented (a browser viewport, a device, anything that operates outside the app's own UI)
- `data-surface="human"` — identity, ownership, consent; warm copper left border + gradient wash + level 1 shadow
- `data-surface="protocol"` — machine-generated values, grants, stream names; cool blue + level 1 shadow

### Protocol rows within human surfaces
Protocol data (stream names, field chips, view badges, access_mode values) often appears inside a human surface. Do not nest `data-surface="protocol"` inside `data-surface="human"` — competing temperature signals fight each other. Instead, apply the protocol-row pattern directly via Tailwind utilities: `border-l-2 pl-3 font-mono`. This gives protocol data a distinct but subordinate identity without overriding the parent human context.

### Copy register
**Human surfaces are written from the person's perspective.**

- Use second person: "You're sharing", "You can revoke", "Active until you revoke it"
- Protocol terms are labels on data, never grammatical subjects: "Active until you revoke it" not "Continuous access is granted"
- Affirmative actions name what the person is doing: "Allow access", "Revoke", not "Submit", "Confirm", "OK"
- Benefit framing over capability framing, but honest: if the user is donating data, say so — "Contribute your data to X" — rather than dressing it as a user gain
- The Allow button uses `--primary` (blue). The decision is human; the execution is a system action. Blue is the established affordance for primary affirmative CTAs. The copper left border already carries the human signal on the card.

### Trust model in the UI

Three layers of content with distinct visual treatment (see spec §5):

1. **Protocol facts** (server renders from grant fields): access mode, retention, expiry, stream selections. Rendered as authoritative text, no attribution needed.
2. **Server-trusted descriptions** (manifest `display.label` and `display.detail`): stream labels, detail descriptions. Rendered as authoritative, no attribution.
3. **Client-authored claims** (`client_display`, `client_claims.commitments`): requester name, purpose description, free-text commitments. Rendered with "[name] says:" attribution and italic disclaimer.

### Semantic attributes
Follow the shadcn pattern: `data-[attribute=value]` on elements, CSS derives visual from semantic state.

---

## What we are not doing

- No emojis
- No arbitrary font sizes (`text-[13px]`)
- No inline hex colors or hardcoded palette values
- No decoration for its own sake (gradients, shadows, animations without purpose)
- No component that looks finished but has unclear semantics underneath
- No em dashes in user-facing copy

---

## Living artifacts

| Artifact | Location | Purpose |
|----------|----------|---------|
| Design tokens | `src/app/globals.css` | Single source of truth for all visual values |
| Design system page | `/design` route | Visual index of all tokens, type, components, semantics |
| Reusable components | `/design` route, Components section | Five protocol components with specimen switchers |
| This document | `demo/CONSTITUTION.md` | Principles and decisions — update as we make choices |
| Honest reference | `demo/HONEST_REFERENCE.md` | Spec gaps in the current implementation |
