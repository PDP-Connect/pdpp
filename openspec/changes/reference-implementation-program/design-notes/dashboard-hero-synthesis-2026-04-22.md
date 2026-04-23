# Dashboard hero — SLVP synthesis

**Status:** research synthesis (proposal staging)
**Date:** 2026-04-22
**Context:** the owner asked for the first fold of `/dashboard` to act as a credibility screen for the PDPP reference — "in the first 5–10 seconds, communicate that this is a real local personal data substrate with meaningful scale, not a toy control plane." SLVP bar; Rich Hickey "simple, not easy" lens.

## Companion notes

- `dashboard-hero-prior-art-stripe-2026-04-22.md`
- `dashboard-hero-prior-art-vercel-2026-04-22.md`
- `dashboard-hero-prior-art-linear-2026-04-22.md`
- `dashboard-hero-prior-art-plaid-2026-04-22.md`
- `dashboard-hero-code-audit-2026-04-22.md`

## Central tension across SLVP

The four references split cleanly:

| Reference | Register | Hero pattern |
|---|---|---|
| Stripe Dashboard Home | business-facing | Grid of stat cards with sparklines + delta-with-period |
| Stripe Workbench | developer-facing | **No hero stats**; liveness + actionability |
| Vercel Project | developer | **No stats hero**; production screenshot + deployment state |
| Vercel Observability | developer | **One dominant number** + contextual time range + enumerated-category grid + anatomy callout |
| Linear | productivity | **No hero at all**; populated sidebar + dense list rhythm |
| Plaid | operator | **Operational freshness** (14-day activity + product-type stack) over cumulative scale |

The tension: Stripe/Vercel Observability push toward **one-hero-number + enumerated taxonomy**. Linear/Plaid/Workbench pull toward **no hero at all — credibility through populated chrome and freshness**.

## Resolution: hybrid that honors both registers

the owner's brief explicitly says "framing layer for the recording" (push toward Stripe/Vercel) *and* "do not redesign the control plane or turn this into a KPI dashboard" (pull toward Workbench/Linear/Plaid). The only honest synthesis:

1. Keep the existing operator first fold intact (ActionBanner + Failures panels) — that's the Workbench register.
2. Add a compact **credibility strip above it** — that's the Vercel-Observability register.
3. Never let the credibility strip become a full KPI dashboard or push the operator content below the fold.

This preserves the shipped control-plane identity (inspection-first, failures-first) while making the first-5-seconds read what the owner wants it to read.

## Proposed hero shape (v1)

A single band at the top of `/dashboard`, above `ActionBanner`, composed as follows (SLVP-tuned):

### Layout

Three zones in a restrained horizontal rhythm:

**[A] Single composed headline (Vercel Observability lesson: one hero number, one precise time range)**

One plain-language sentence in display face, large, operator-grade tone:

> **12,847 records across 9 connectors · since 2022-07-03**

The sentence composes three concrete PDPP truths (retained records, connector breadth, real timespan) into one line. Number is dominant; the rest is chrome.

**[B] Category strip (Vercel enumerated-taxonomy + Plaid product-type stack)**

A horizontal row of small category tiles — one per stream-category — with per-category record counts:

```
health · 4,231    commerce · 3,190    communication · 2,840    content · 1,986    location · 600
```

No logos in v1 (Stripe's payment-method-row is compelling but needs connector logos we don't have standardized). Logos can land in v1.5.

**[C] Anatomy callout (Vercel lesson: advertise depth by showing structure)**

One muted line in smaller type, ambient:

> Each connector run writes records across streams; every record is inspectable as raw JSON through `/v1/streams`.

This is the highest-signal move per character for the "real system, real enforcement" audience. It rewards the skeptical reader in 3 seconds.

### Typography (Linear lesson: hierarchy via weight + color, not size ladder)

- Headline number 32–40px Geist (or display face), semibold
- Composing text (records / connectors / timespan) in same face, smaller, muted
- Category strip in monospace-ish, small, muted with accent dots for category identity (Linear color-dot pattern)
- Anatomy callout 13px, muted, no decoration

### Empty-state behavior (Stripe + Vercel lesson)

Grid scaffolding stays intact. If no records yet:

> **No records yet · 0 connectors connected**
>
> Start a grant to begin ingesting. Every record lands inspectable.

The shape doesn't collapse; numbers degrade honestly.

### What's explicitly NOT in the hero

- No sparklines (Stripe temptation, Linear/Plaid-wise restraint)
- No % deltas (Vercel Observability explicit lesson: precise time range > delta)
- No "total data size in bytes" unless we add a real `/_ref/storage/summary` helper (see open question below)
- No decorative chart / no KPI grid / no "at-a-glance business" framing

## Open questions before implementing

1. **Size claim — worth the helper?** Should we add a read-only `GET /_ref/storage/summary` helper so the headline can honestly say "X GB across 12,847 records"? Adds audit value (Linux Foundation reviewer cares about this; CEO-to-investors cares about this). Cost: one small reference-designated read surface + tests. **Recommendation: yes**, if we're serious about this being a credibility screen — a bytes claim is substantially heavier than a record count.
2. **Category diversity — manifest field or defer?** Add `streams[].category` to the connector manifest (options: `health | commerce | communication | content | location | financial | identity | activity` — drawn from real manifest content) or fall back to "N streams across M connectors" for v1? **Recommendation: add the field.** Without it, the enumerated-category strip is inference-based and loses honesty. With it, category becomes manifest-authored (matches the trust model already established: `display.detail` is manifest-authored, never client-authored).
3. **Placement vs. existing Overview?** The synthesis here keeps ActionBanner + Failures intact below the hero. Alternative: hero replaces the subtitle line only. **Recommendation: place above**, keep existing content visible, tune vertical rhythm so hero + ActionBanner + Failures all sit within the first fold on typical laptop heights.
4. **Anatomy callout wording.** The proposed sentence is generic. Could be stronger: "Your 2,847 Amazon orders were written through 1 grant, 1 run, and 3 streams — all inspectable as raw JSON." Per-instance versions rotate based on the largest recent run. **Recommendation: defer personalization to v1.5**, start generic.
5. **Live vs. snapshot**, confirmed by the owner: **live.** Sub-second aggregate computation over ≤31 manifests + parallel stream reads is achievable; cache the aggregate with a short TTL (or stream-level staleness) if needed.

## Alignment with steering constraints

| Constraint | How hero honors it |
|---|---|
| "Stop calling it a demo, start calling it a reference" | Hero never uses the word "demo"; emphasizes inspectability + real records |
| SLVP quality bar (consent card rigor) | 4 independent prior-art passes captured + synthesized; typography/layout decisions grounded in cited sources |
| Manifest-authored trust model | Category field proposal is **manifest-authored**, never client-authored — extends the established principle |
| Multi-audience (CEO/engineer/Linux Foundation/GTM) | Headline reads for CEO+GTM; anatomy callout + JSON affordance reads for engineer+LF; category strip reads for product/migration-path audience |
| Honest about protocol (85 concepts / 12 flows) | Hero exposes: retained records (storage), connectors (identity), streams (schema), timespan (persistence), categories (taxonomy), anatomy (grant→run→stream→record flow). 6 concepts surfaced honestly where today's Overview surfaces zero aggregate concepts. |

## Next step

Produce 1–2 concrete composition proposals (text + annotated layout) and get the owner's pick before implementing. The open questions above should be answered in the proposal document, not left for implementation time.
