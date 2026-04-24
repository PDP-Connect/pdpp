# Dashboard hero prior art — Stripe

**Status:** research finding
**Date:** 2026-04-22
**Context:** `/dashboard` (Overview) credibility-screen hero research for PDPP operator console.

## Why this note exists

the owner framed the first fold of `/dashboard` as a credibility screen for the PDPP reference — the job is to communicate in 5–10s that this is a real local personal-data substrate with meaningful scale (connectors, streams, retained records, timespan, ingestion diversity). SLVP (Stripe / Linear / Vercel / Plaid) is the declared design bar. This note captures the Stripe pass.

## Two Stripe surfaces to distinguish

### Stripe Dashboard Home (business-facing)
- Customizable grid of chart widgets (Gross volume, Net volume, Successful payments, New customers, Spend per customer, Failed payments).
- Each widget = **big number + sparkline + delta-with-period**. Number-to-label ratio ~2.5–3x; number 28–36px, label 12–13px muted.
- One visual per card (sparkline OR trend arrow OR mini-bar — never all three).
- Deltas sit as tiny arrow + percentage + period name, never competing with the number.
- Home = generous whitespace; operational views = tighter density.

### Stripe Workbench (developer/operator-facing) — closer analog for PDPP
- Does **not** use hero stat cards at all.
- Leads with: API success rate (small number + status), Recent errors list, API requests graph, Webhooks graph, API keys / API version widgets.
- Credibility for developers comes from **liveness + actionability**, not scale.

This split is the most important finding. PDPP's operator console is closer to Workbench than to Home. A pure KPI hero would misread the register.

## Breadth-as-credibility patterns

- **Payment methods row**: horizontal list of tiny method logos with counts. Reads as "we handle N rails" at a glance.
- **Currency breakdown widget**: small stacked bar or list showing top currencies by volume.
- **Gross vs. Net paired**: two cards side-by-side, one slightly smaller — implicit story (raw scale + what-you-keep).

## Empty-state behavior

Stripe **keeps the card grid intact** at zero state. Cards become scaffolding for next actions ("Accept your first payment", "Invite your developer"). Notifications block stays prominent even with no volume. Scaffolding itself signals "real system."

## Patterns worth stealing for PDPP

1. **Mixed register.** Combine a small grid of scale cards (Home-style) with a liveness strip (Workbench-style) — don't pick one.
2. **Connector-logo row = PDPP's "payment methods" analog.** Strongest breadth-without-decoration move.
3. **Pair scale with context.** Not "12,847 records" alone — "12,847 records · 9 sources · 4.2 years". One composed hero.
4. **Empty state keeps the grid.** Never collapse scaffolding; empty cells become connect-source CTAs.
5. **Timespan is a unique PDPP stat.** Stripe has no equivalent — lean into it.
6. **Typography**: ~28–36px number, ~12–13px muted label, ratio ~2.5–3x; single ambient visual per card.

## Open questions

- Should the "ambient visual" per PDPP card be a sparkline of record growth over time, or an even more restrained density bar? Linear/Plaid lean calmer than Stripe — defer until synthesis.
- How many cards is "small"? Stripe defaults to 6 but treats them as customizable. PDPP's 5-metric brief fits 3–5 cards comfortably.

## Sources

- [Stripe Dashboard home charts overview](https://support.stripe.com/questions/dashboard-home-charts-overview)
- [Stripe Dashboard basics](https://docs.stripe.com/dashboard/basics)
- [Stripe Workbench overview](https://docs.stripe.com/workbench/overview)
- [Stripe blog: Workbench announcement](https://stripe.com/blog/workbench-a-new-way-to-debug-monitor-and-grow-your-stripe-integration)
- [Stripe Connect dashboard](https://docs.stripe.com/connect/dashboard/understand-your-connect-business)
- [SaaSFrame — Stripe Payments Dashboard reference](https://www.saasframe.io/examples/stripe-payments-dashboard)
- [Art of Styleframe — 2026 dashboard design patterns](https://artofstyleframe.com/blog/dashboard-design-patterns-web-apps/)
