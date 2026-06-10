# UI Overhaul — Design Direction (Phase 2)

Status: decided (RI-owner session under delegated design authority, 2026-06-11)
Owner: reference implementation owner
Created: 2026-06-11
Related: docs/research/ui-overhaul-current-state-2026-06-10.md (the audit; its §4 enumerates the five decisions made here), docs/experience-architecture.md, design-notes/owner-journey-flow-design-2026-06-10.md

These five decisions gate the visual rebuild. They are made to be *durable*: each
is grounded in the protocol's own semantics or a named SLVP analogue, not taste
alone. The owner can overturn any of them; record overturns in the decision log
below rather than editing in place.

## 1. Brand temperature: FORMALIZE, and extend to the trust model

The copper-human / blue-protocol temperature coding (today inline-styled and
incomplete on the landing) becomes a first-class token tier — because it is not
decoration, it is the **trust model made visible**. The spec's semantic classes
give us exactly three authorships, and each gets a temperature:

- `--authorship-protocol-*` (cool blue) — protocol facts: enforced, verifiable
  (grants, projections, token scopes, enforcement results).
- `--authorship-manifest-*` (copper/warm) — manifest/owner-authored: the human
  consent surface (stream descriptions, display names, consent text).
- `--authorship-client-*` (neutral grey + dashed/outline affordance) —
  client-authored claims: rendered, never trusted (client_display, client_claims).

Every surface that mixes these (consent card above all) uses the tier so a
standards reviewer can *see* the authorship boundary. This is the visual
signature of the product: no competitor renders trust provenance.

## 2. Health status: ONE component, two contexts

`StatusBadge` (dot + label pill, bound to the `--status-*` tier shipped
2026-06-10) is the single canonical health rendering on every surface —
list rows, detail headers, overview cards, run rows. One addition: in dense
lists, **danger states alone** also get a left-border row tint
(`--status-danger-bg` at low alpha) for sub-second triage scanning. No third
treatment exists; the coverage/freshness second badge family migrates onto
StatusBadge tones.

## 3. Density: Stripe-dense console, editorial site

The console is an operator's diagnostic instrument — **data density is
honesty**, and this product's differentiator is exactly its honest facts
(unknown ≠ zero, real run ids, explicit failure reasons). Airy cards hide
facts. So: dense tables, 13px/secondary-12px data type, tabular-nums, strict
4px-rhythm padding (dense ≠ cramped — Stripe's discipline, not its clutter),
detail behind peeks/expansions but never deleted. The public site keeps the
editorial, airy register it already has; the contrast between the two is
intentional (Stripe.com vs Stripe Dashboard is the named precedent).

## 4. Mobile: bottom-tab triage instrument

Console mobile = a **triage device**, not a shrunk desktop. Bottom tab bar
(Linear precedent) with the four primary destinations: Sources, Runs, Grants,
Records. Mobile card anatomy, fixed: status pill top-left → name → one
load-bearing metric → one CTA; everything else behind the tap into detail.
One screen of cards must answer "is anything wrong?" — the current ~9,000px
wall is the anti-pattern. Desktop tables never reflow into mobile cards
automatically; mobile layouts are composed separately.

## 5. Type & motion: locked pairing, restrained baseline, one set-piece

Geist Variable + JetBrains Mono are LOCKED (mono for every technical
identifier: ids, URIs, env names, scopes — consistently, not sporadically).
The 9-step type scale is enforced everywhere (no ad-hoc text-* sizes in
views). Motion: Vercel-restrained baseline — 150–250ms ease-out
micro-transitions, no spring/bounce, `--motion-*` tokens only — with exactly
**one expressive set-piece**: the landing field-projection hero, where the
grant visibly filters data fields in an animated projection. One signature
moment lands harder against a restrained baseline than ambient animation
everywhere (Stripe's gradient hero is the precedent: one wow, calm elsewhere).

## Dispatch consequences

- Foundation (#1–#5, #10, #12 of the audit ranking): shipped or in-flight as
  of this writing (status tokens, Tailwind mapping, dedup lane, grant
  vocabulary, type-scale pass, prod-URL fix; Callout tones queued behind the
  dedup merge).
- The consent-card rebuild implements decision 1 (three-authorship rendering)
  and is the flagship: design it first, to the highest finish, in
  operator-ui, consumed identically by site and console.
- Sources list re-composition implements decisions 2+3; Deployment section-nav
  implements 3; mobile work implements 4 and starts only after its design
  spec (card anatomy above) — all Phase 3, per-view gated on the owning
  workstream branches landing.
- Site reference-app token rebuild + hero animation implements 5 and is
  Phase 2's centerpiece.

## Decision Log

- 2026-06-11: All five decisions made under the owner's delegated design
  authority ("Claude models are way better at UI design — the UI is way
  overdue for an overhaul"). Grounding chosen so each decision strengthens
  the protocol story rather than restyling it: authorship temperatures make
  the trust model visible; density preserves honesty; the one set-piece
  showcases projection — the protocol's most distinctive property.
