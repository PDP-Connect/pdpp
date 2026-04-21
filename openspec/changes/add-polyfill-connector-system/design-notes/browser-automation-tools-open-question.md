# Open question: leveraging browser-automation domain registries / harnesses

**Status:** open — research + decision deferred
**Raised:** 2026-04-19
**Trigger:** the owner's note: "https://github.com/browser-use/browser-harness https://www.unbrowse.ai domain knowledge/registries may be useful, and we would be wise to explore how we might use one of those, or use https://github.com/alibaba/page-agent, to make better connectors more easily in some cases."

## What this is about

PDPP's browser-scraper connectors today each carry bespoke Playwright selectors, ensure-session logic, and per-page click/scroll patterns. Adding a new one (Anthropic, Shopify, HEB, etc.) requires 30–60 minutes of live DOM walk per platform, and selectors rot.

Third-party projects have emerged that either capture or package browser domain knowledge:

- **[browser-use/browser-harness](https://github.com/browser-use/browser-harness)** — an LLM-agent harness over Playwright. Promises "just describe what you want and it clicks its way through."
- **[unbrowse.ai](https://www.unbrowse.ai)** — commercial domain-knowledge registry for web automation (what it is exactly and its licensing would need research).
- **[alibaba/page-agent](https://github.com/alibaba/page-agent)** — LLM + Playwright agent, Alibaba's internal tool, open-source.

The shape of these tools: **reduce per-connector manual selector work in exchange for LLM-driven or registry-driven navigation primitives.**

## Why it matters for PDPP

Today's browser-scraper connectors are a bottleneck. Each one:
- Needs ~30–60 min of live selector-walking to wire
- Has bespoke ensure-session logic
- Rots as sites update

If a harness like browser-use or a registry like unbrowse.ai could carry that knowledge, we'd reduce time-per-connector and make it plausible to scale from 9 scaffolded browser connectors to 30+.

## Tensions

### Architectural
- **Dependency weight.** Browser-use/page-agent pull in LLM inference + a bigger Playwright stack. Every connector using them inherits the footprint. PDPP connectors today are <500-line single-file scripts.
- **Non-determinism.** LLM-agent navigation is probabilistic. For scraping user data, re-running a connector should produce stable records. Agent navigation adds variance that's hard to test or verify.
- **External service reliance.** unbrowse.ai is a hosted service; PDPP connectors running against it leak the operator's scraping patterns to a third party. Even if data stays local, the *navigation* becomes third-party-mediated.

### Spec-surface
- **Provenance capture** (see `raw-provenance-capture-open-question.md`) gets harder when navigation is agent-driven. "What was on the page when you extracted this?" becomes "the agent decided to click here but the page has since changed."
- **Reproducibility** — an LF-reviewer asking "given these inputs, can you show this output was derived from them?" gets murkier with non-deterministic agents.

### Operational
- **License compatibility.** Unbrowse.ai appears to be commercial/closed. Integrating it means per-connector licensing concerns (similar to slackdump's AGPL question). Browser-use and page-agent are open source but have their own constraints.
- **Where the knowledge lives.** A registry-backed approach means a shared ontology of "here's how amazon.com works." That's valuable across PDPP implementations, but it needs stewardship.

## Candidate directions

### A. Adopt one in-connector as an experiment
Pick one currently-scaffolded browser connector (e.g. Anthropic, since it's mostly self-contained and we can validate against). Try browser-use or page-agent as the navigation layer. Measure: time-to-working-connector, record-stability across re-runs, code size.

### B. Add a spec convention for "driver" abstraction
Manifests declare how they navigate: `driver: "playwright_native" | "browser-use" | "page-agent" | ...`. Consumer knows what to expect in terms of determinism/footprint.

### C. Contribute upstream to one
Rather than consume, invest PDPP's accumulated browser-scraping knowledge into an open registry. Makes PDPP an ecosystem steward.

### D. Wait and watch
These tools are young. Defer adoption until one stabilizes. Keep today's hand-written connectors.

## Cross-cutting

- `credential-bootstrap-automation-open-question.md` — token-creation bootstraps already use Playwright; a harness could subsume them
- `external-tool-dependencies-open-question.md` — every harness is an external tool dep to declare
- `raw-provenance-capture-open-question.md` — agent-driven navigation complicates provenance
- `connector-configuration-open-question.md` — agent policies (prompt, model choice) are per-connector options

## Action items

- [ ] Survey: what's the licensing / governance story on each of the 3 named tools?
- [ ] Survey: do any of them expose a stable API for deterministic replay?
- [ ] If yes: pilot option A on one connector, compare against hand-written version
- [ ] Decide: investment vs. adoption vs. wait

## Note

This is a "whole can of worms for a live feature" — the owner's framing. Not something to decide mid-sprint. Captured here so we don't forget; revisit when we're past the current data-quality gate.
