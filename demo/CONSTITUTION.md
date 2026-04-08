# PDPP Demo — Design Constitution

## Audience

Executives, developers, and product people evaluating the PDPP protocol. People who can tell good craft from bad, and who will judge the protocol partly by the quality of the demo.

## The one thing this demo must do

Make someone who has never heard of PDPP walk through the full flow — consent → collection → enforcement → result — and come out thinking: "I understand what this is, and the people behind it know what they're doing."

No single moment is the hook. The cumulative experience is the argument.

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

### 5. The flow is the demo
Optimize for the cumulative experience of someone moving through it once. Isolated component beauty is secondary to the flow feeling inevitable and trustworthy.

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

### Surface Temperature

Every surface in PDPP is either **human** or **protocol**.

- **Human surfaces** belong to the person — their identity, their decision, their consent. They use the warm copper tone (`--human`: `oklch(0.52 0.09 45)`), usually as a 2px left border and/or a `--human-wash` background gradient. Typography is sans-dominant.
- **Protocol surfaces** belong to the system — tokens, spec references, grants, stream names, machine-generated values. They use the protocol blue (`--primary`: `oklch(0.580 0.172 253.7)`). Typography is mono-dominant.

The consent card is the highest-stakes moment of duality: the person (warm) is being asked by the protocol (cool) for permission. Both signals must be present and legible at the same time.

**Rule**: Before styling any surface, answer "whose is this?" If the answer is a person, reach for `--human`. If the answer is the system, reach for `--primary`. If neither applies, it is neutral — no temperature signal at all.

### Surfaces
- `data-surface="stage"` — a neutral surround that frames an independent thing being presented (a browser viewport, a device, anything that operates outside the app's own UI)
- `data-surface="human"` — identity, ownership, consent; warm copper left border + gradient wash
- `data-surface="protocol"` — machine-generated values, grants, stream names; cool blue, mono-dominant

### Protocol rows within human surfaces
Protocol data (stream names, field chips, view badges, access_mode values) often appears inside a human surface. Do not nest `data-surface="protocol"` inside `data-surface="human"` — competing temperature signals fight each other. Instead, apply the protocol-row pattern directly via Tailwind utilities: `border-l-2 border-primary/20 pl-3 font-mono`. This gives protocol data a distinct but subordinate identity without overriding the parent human context.

### Copy register
**Human surfaces are written from the person's perspective.**

- Use second person: "You're sharing", "You can revoke", "Active until you revoke it"
- Protocol terms are labels on data, never grammatical subjects: ✓ "Active until you revoke it" · ✗ "Continuous access is granted"
- Affirmative actions name what the person is doing: "Allow access", "Revoke", not "Submit", "Confirm", "OK"
- Benefit framing over capability framing: "So your account can be included in research" only works if there's a genuine user benefit; if the user is donating data, say so honestly — "Contribute your data to X" — rather than dressing it as a user gain
- The Allow button uses `--primary` (blue). The decision is human; the execution is a system action. Blue is the established affordance for primary affirmative CTAs. The copper left border already carries the human signal on the card.

### Semantic attributes
Follow the shadcn pattern: `data-[attribute=value]` on elements, CSS derives visual from semantic state.

---

## What we are not doing

- No emojis
- No arbitrary font sizes (`text-[13px]`)
- No inline hex colors or hardcoded palette values
- No decoration for its own sake (gradients, shadows, animations without purpose)
- No component that looks finished but has unclear semantics underneath

---

## Living artifacts

| Artifact | Location | Purpose |
|----------|----------|---------|
| Design tokens | `src/app/globals.css` | Single source of truth for all visual values |
| Design system page | `/design` route | Visual index of all tokens, type, components, semantics |
| This document | `demo/CONSTITUTION.md` | Principles and decisions — update as we make choices |
