# Dashboard hero prior art — Vercel

**Status:** research finding
**Date:** 2026-04-22
**Context:** `/dashboard` (Overview) credibility-screen hero research for PDPP operator console.

## What Vercel's first fold actually shows

Vercel's project overview does **not** lead with analytics-style KPI tiles. The 2026 redesign prioritizes **production deployment status** and **preview deployments from Git branches**. Credibility is carried by:

- A screenshot of the live production site (a visual artifact, not a number)
- Deployment state chips (queued/building/ready/error)
- Triggering commit SHA
- Environment labels

**No** deployment count, request volume, or region count at the project-overview level.

## Where Vercel *does* lead with numbers — Observability Overview

This is the pattern PDPP should steal:

- **One dominant number, one contextual time range.** Example: "634,200 visitors · Fri May 10 4pm – 5pm". The big number is paired with a precise date/time label, **not a % delta**. Specificity reads as real.
- **Card grid below**, grouped by domain: Edge Requests, Fast Data Transfer, Functions, External APIs, Middleware, AI Gateway. Each card is a starting point, one click to its detail view.
- **Time-range selector is first-class**, top-right. Every number reads as "over this window."

## Breadth-as-credibility: enumerated taxonomy (strongest pattern for PDPP)

Vercel's breadth signal is **a fixed, enumerated taxonomy of event types** shown side-by-side so the reader feels system surface area. Critically, the docs include an anatomy callout:

> "A single request can generate multiple events — 1 Edge Request, 1 Middleware, 1 Function Invocation, 2 External API calls, 1 AI Gateway = 6 events."

That sentence itself is a credibility move — advertising depth by showing anatomy.

**Direct translation for PDPP**: list connector categories / ingestion modes / stream types side-by-side with per-category counts, and include a parallel anatomy callout — e.g., "One connector run = N records across M streams, with K interactions and J checkpoints."

## Empty state

Public material doesn't document the new-project empty state in detail. Community threads show the Deployments tab degrades to literal "no deployments found" + a prompt to deploy. **No faux-filled placeholder.** Match this for PDPP: zero connectors → plain honest state + connect action, never fabricated skeleton numbers.

## Visual-hierarchy lessons for a hero

- **One hero number, not four.** Pick the single most meaningful scalar, make it large, put a precise timestamp/range next to it.
- **Labels are small, uppercase or monospace, muted.** Numbers carry weight; labels defer.
- **Breadth is a grid of enumerated surfaces**, not a sparkline wall. Every tile is a navigation affordance.
- **No decorative charts.** Every visualization must click through to a detail view.

## Patterns worth stealing for PDPP

1. **One-hero-number discipline.** Resist the urge to equalize 4 tiles. Pick the single most credible scalar (candidate: total retained records), size it dominantly, pair with explicit time-range context.
2. **Enumerated taxonomy for diversity.** A fixed row of connector-category tiles (with per-category record/stream counts) communicates breadth honestly.
3. **Anatomy callout.** One plain-language sentence that decomposes a unit of work — e.g., "Your Amazon connect issued 1 grant → 1 run → 3 streams → 2,847 records." This is the highest-signal move per character and feels *exactly* like Vercel's event-anatomy line.
4. **Precise time-range, not %.** "Since 2022" beats "+340% YoY" for credibility in this register.
5. **Every tile is clickable navigation**, not decoration. Overview is a launch pad, not a chart wall.

## Open questions

- Does PDPP have enough category diversity in practice to make the taxonomy row feel full? Depends on the active connector set — worth checking the 31 manifests before committing to N categories.
- Should the hero number be records, or records+size+timespan composed as a single line? Vercel leans pure-number; PDPP's composed-line variant may read richer.

## Sources

- [Vercel Project Dashboard docs](https://vercel.com/docs/projects/project-dashboard)
- [Vercel Projects overview](https://vercel.com/docs/projects)
- [Vercel Observability docs](https://vercel.com/docs/observability)
- [Vercel Observability product page](https://vercel.com/products/observability)
- [Overview page in Observability changelog](https://vercel.com/changelog/overview-page-in-observability)
- [Vercel dashboard redesign blog](https://vercel.com/blog/dashboard-redesign)
- [Dashboard redesign rollout changelog](https://vercel.com/changelog/dashboard-navigation-redesign-rollout)
- [Medium: Vercel's new dashboard UX analysis](https://medium.com/design-bootcamp/vercels-new-dashboard-ux-what-it-teaches-us-about-developer-centric-design-93117215fe31)
