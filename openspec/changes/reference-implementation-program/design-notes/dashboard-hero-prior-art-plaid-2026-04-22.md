# Dashboard hero prior art — Plaid

**Status:** research finding
**Date:** 2026-04-22
**Context:** `/dashboard` (Overview) credibility-screen hero research for PDPP operator console.

## Caveat on methodology

Plaid's developer Dashboard (`dashboard.plaid.com`) is auth-walled — no public first-fold screenshots. Findings come from Plaid's public docs, the 2023 redesign post, Institution Status docs, and Usage Dashboard writeup.

## What Plaid's first fold actually shows

Plaid emphasizes **operational freshness over cumulative scale**. Top-level surfaces:

- **14-day Activity Log**: requests / webhooks / Link events
- **Usage page**: "item adds and removes over time" with a product-by-product usage breakdown below the main chart
- **Institution Status pane**: 2-week success-rate graph plus current-status boxes (Auth / Identity / Transactions / Investments)

**No "lifetime items connected" vanity stat.** Plaid's operator UI is intentionally understated — its first fold is a freshness/health signal, not a credibility pitch.

## Diversity of sources

Plaid leans on **product-type segmentation, not institution logo walls**, in the operator UI:

- Success rates broken out **per product** (Auth, Identity, Transactions, Investments)
- Usage charts stack by product

**Logo grids exist only in end-user Link** (Embedded Institution Search), deliberately sized by container. This is a deliberate split:
- Operator surfaces → counts/rates by product type
- Consumer surfaces → logos

## Typography and hierarchy

- Tabular-first.
- Redesign framing is "find the tools you need" — navigation reorganization, dedicated product spaces, **not hero numerics.**
- Percentages **rounded down to nearest point** and gated by "Insufficient Data" rather than shown as "0%".
- **Credibility comes from rigor of qualification, not size of digits.**

## Empty-state behavior

New accounts hit **completion checklists, not dashboards**: Institution Profile, OAuth config, Brand Editor, Use Case selection. Some US institutions **refuse OAuth until the profile is complete**. Empty state is a gate toward production, not a marketing surface.

## Trust signals

Trust is earned through **live operational transparency**:
- 2-week uptime graphs
- Item Debugger
- Issue Center
- Per-institution success breakdowns
- OAuth migration timelines
- Webhook trails

The signal is **"you can audit us right now,"** not "look how big we are."

## Product/stream-type diversity pattern

Usage view displays **item adds/removes over time** with product-by-product breakdown beneath. Premium Link Analytics (2025) further segments by geography, institution, device, product, customization.

**Direct analog for PDPP**: one volume-over-time chart plus a stream-category stack (e.g., Activity / Identity / Content / Transactions) underneath.

## Patterns worth stealing for PDPP

1. **Freshness beats cumulative.** Lead with "last ingested X hours ago across N connectors," not lifetime row counts.
2. **Product-type stack, not logo wall** in the hero. Save connector logos for a secondary fold (ala Stripe's payment-methods row).
3. **Time-range as primary axis.** Pick one horizon, make it legible.
4. **Qualified numbers.** Round down; show "Insufficient data" rather than "0%". Rigor reads as credibility.
5. **Trust = auditability, not bragging.** A recent-activity strip (last N ingestion events, per-stream last-seen) transfers directly from Plaid's Activity Log.
6. **Empty state = setup checklist**, not a hollow hero.

## Tension with the hero brief

Like Linear, Plaid's pattern is **calmer than Stripe/Vercel**. For PDPP's stated goal (5–10s: real system, meaningful data, many sources, long period), a Plaid-style freshness strip + time-axis volume chart + product-category stack satisfies the brief **in the operational register**. Pushing further toward Stripe-scale hero only makes sense if marketing framing outweighs operator framing.

The cross-cutting decision: is `/dashboard` an *operator* first fold (Plaid / Linear register) or a *recording framing layer* first fold (Stripe / Vercel register)? the owner's brief explicitly says the latter ("framing layer for the recording") but also says "don't turn this into a KPI dashboard." This is the central synthesis tension.

## Sources

- [Plaid Docs: Account activity, logs, and status](https://plaid.com/docs/account/activity/)
- [Plaid blog: Usage dashboard improvements](https://plaid.com/blog/usage-dashboard/)
- [Plaid blog: 2023 dashboard redesign](https://plaid.com/blog/dashboard-redesign-2023/)
- [Plaid blog: Transparency for institution/Item/system status](https://blog.plaid.com/institution-item-system-status/)
- [Plaid Docs: Link analytics and tracking](https://plaid.com/docs/link/measuring-conversion/)
- [Plaid Docs: Embedded Link](https://plaid.com/docs/link/embedded-institution-search/)
- [Plaid Core Exchange Dashboard overview](https://plaid.com/core-exchange/docs/dashboard-overview/)
- Related local context: `project_consent_card_research.md` (Plaid Link consumer-side prior research); `project_reference_design_research.md` (Martini Glass / C4 mixed-audience patterns)
