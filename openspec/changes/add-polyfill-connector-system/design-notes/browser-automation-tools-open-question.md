# Browser Automation And Agent Tooling Landscape

Status: researching
Owner: owner/runtime
Created: 2026-04-19
Updated: 2026-04-25
Related: add-polyfill-connector-system; add-reference-runtime-spec; credential-bootstrap-automation-open-question.md; raw-provenance-capture-open-question.md; external-tool-dependencies-open-question.md; connector-configuration-open-question.md

## Question

Can PDPP use, wrap, fork, or learn from emerging browser-agent and API-discovery tools to make connectors faster to build, easier to repair, safer to operate, and more fixture-friendly without weakening determinism, provenance, privacy, or grant safety?

## Context

PDPP browser connectors currently combine deterministic Playwright/patchright code, per-connector session repair, fixture capture, schema validation, and manual operator interactions. This is the right floor for auditability, but it is expensive to scale: every new platform needs live DOM/API reconnaissance, login handling, selector hardening, fixture capture, and future repair.

The tool landscape is moving quickly. Several adjacent systems attack pieces of the problem:

- Agentic browser control: let an LLM drive pages directly.
- AI-assisted Playwright: keep scripts, but use AI for selector resolution, login, or extraction steps.
- Cloud browser infrastructure: solve session hosting, live view, recordings, proxies, CAPTCHA/anti-bot add-ons, and concurrent sessions.
- Skill or adapter registries: turn hard-earned platform knowledge into reusable site-specific capabilities.
- Shadow/internal API discovery: use the website's own first-party endpoints instead of clicking through rendered UI.
- In-page / host-browser agents: use the user's real browser session or injected page agent rather than a synthetic headless browser.

Kahtaf's Stagehand spike is relevant prior art: Browserbase infrastructure worked well enough for Google login, Instagram hit CAPTCHA/proxy constraints, Stagehand was useful for agent-driven login while extraction stayed deterministic, Gemini Flash-class inference cost looked negligible for the tested login runs, and the most interesting open question was whether learned flow knowledge should become a reusable global skill/route repository rather than one-off agent memory.

## Stakes

- Connector throughput: reduce the time to bring up and repair connectors.
- User safety: browser agents can click, type, submit, and leak credentials if not sandboxed.
- Privacy: hosted browser infra and shared route registries can reveal navigation patterns, auth state, or user data.
- Auditability: PDPP needs reproducible evidence that records came from authorized source data, not a black-box agent's interpretation.
- Fixture quality: new tooling should improve real-shape fixture capture and replay, not make it less deterministic.
- Docker/operator UX: browser connectors need a clear human-in-the-loop surface when headless or cloud execution cannot complete login/OTP/CAPTCHA.

## Survey Snapshot

This is a directional snapshot from official docs/sites and repo READMEs, not a final vendor evaluation.

| Tool / family | What it appears to be | Why PDPP should care | Main concerns |
| --- | --- | --- | --- |
| OpenSteer | AI-browser automation framework aimed at agents that inspect browsers and generate/update scrapers in a codebase; advertises sessions, replay, selector cache, snapshots, anti-bot, cloud/private options. Source: https://opensteer.com/ | Closest to "agent helps create and maintain connector code" rather than "agent is the connector." Its selector cache/replay framing maps well to fixture and repair workflows. | Needs licensing/runtime/API review; avoid outsourcing connector truth to opaque self-healing unless outputs become deterministic code/tests. |
| Browserbase | Cloud browser infrastructure with live view, recordings, session inspector, network/console/CDP logs, proxies, stealth/CAPTCHA features depending on plan. Sources: https://docs.browserbase.com/platform/browser/observability/session-live-view and https://docs.browserbase.com/platform/browser/observability/observability | Solves the Docker/headless human-in-the-loop problem cleanly: live view can let an operator watch or take control. Also gives recordings/logs for connector debugging. | Hosted browser means external data processor and operational dependency. Need privacy model, cost model, region, retention, and whether self-host/local alternative is required. |
| Stagehand | Open-source AI browser automation SDK with `act`, `extract`, `observe`, and `agent`; runs locally or on Browserbase; positions itself between hardcoded selectors and black-box agents. Sources: https://www.browserbase.com/stagehand and https://docs.stagehand.dev/v3/configuration/browser | Good candidate for login/session-repair helpers where deterministic selectors are brittle but extraction remains deterministic. Kahtaf's spike supports this shape. | Need deterministic replay/evals. Must prevent "agent extraction" from becoming source-of-record without schema/provenance checks. |
| Browser Use Cloud | Managed browser automation with AI agents, direct browser/CDP control, skills, profiles, proxies, recordings, CAPTCHA solving. Source: https://docs.browser-use.com/cloud/quickstart | Potential benchmark for cloud sessions and reusable skills. Useful for comparing managed-agent vs raw browser control. | Hosted dependency; skill semantics and data handling need review. |
| browser-use/browser-harness | MIT CDP harness where agents can operate Chrome and even edit helpers mid-task; includes domain-skills and interaction-skills. Source: https://github.com/browser-use/browser-harness | Useful mental model for agent-authored repairs and domain skills. The "agent writes what's missing" loop resembles a connector-maintenance copilot. | Too unconstrained for production connector runs as-is. Mid-task code mutation is powerful but must be sandboxed and converted into reviewed patches/tests. |
| OpenCLI | Universal CLI/adapters project that can expose websites/tools as commands, includes a Browser Bridge extension/local daemon, built-in adapters, skill-based adapter authoring and autofix, DOM snapshots, network interception. Source: https://github.com/jackwener/opencli | Strong precedent for "site knowledge becomes a reusable adapter/command," and for using an owner's logged-in browser to discover internal APIs. Could inform PDPP connector authoring workflow or fixture capture. | Adapter registry governance, output schemas, auth boundaries, and whether adapters can meet PDPP manifest/schema/grant expectations. |
| Unbrowse | Open-source CLI / shared route graph for reverse-engineering shadow APIs and executing direct first-party API calls instead of browser actions. Sources: https://www.unbrowse.ai/ and https://arxiv.org/abs/2604.00694 | Directly matches PDPP's preferred end-state for many platforms: use stable internal APIs, not flaky visual automation. Shared route graph could reduce rediscovery work. | Route sharing can leak platform/user behavior; legality/ToS/ethics and auth handling need careful review. Public registry trust model is unresolved. |
| Page Agent | MIT in-page JavaScript GUI agent; natural-language control through injected JS, optional extension and MCP server. Source: https://github.com/alibaba/page-agent | Useful for surfaces we control or can instrument, and for sandbox/demo/admin workflows. Less obvious for third-party connectors where we cannot inject persistent code. | Not a general solution for third-party scraping. In-page injection changes threat model and may not bypass anti-bot/session issues. |
| Browser-use / Stagehand / OpenSteer skill registries | Reusable domain skills, self-healing selectors, cached observations, learned action maps. | This is the most important cross-cutting idea: encode "what we learned about this platform" somewhere reusable and reviewable. | Need versioning, ownership, fallback strategy, test fixtures, and a way to distinguish exploratory agent memory from approved connector behavior. |

Other tools worth later scanning: Steel, Anchor Browser, Browserless, Kernel, Skyvern, Notte, AutoBrowser, Playwright MCP, browser extension / MCP bridges that operate an already logged-in host browser, and OS-level CUA agents. The evaluation should be category-driven rather than vendor-driven.

## Emerging Taxonomy For PDPP

### 1. Deterministic connector code remains the production default

PDPP should continue to prefer explicit connector code that emits schema-validated records, has fixture coverage, and can be reviewed. Browser-agent tooling should help create, repair, or bootstrap that code; it should not silently replace the connector contract.

### 2. Agent login is different from agent extraction

Agent-driven login/session repair is a plausible near-term win. The agent can click through variable login flows, OTP prompts, CAPTCHA handoff, Cloudflare surprises, and region-specific redirects, then hand back a live authenticated session to deterministic extraction code.

Agent-driven extraction is higher risk. It should only be allowed in experiments where extracted records are validated against schemas, backed by captured raw provenance, and compared against deterministic replay.

### 3. Internal API discovery is the best long-term shape when available

For platforms like ChatGPT, Reddit, GitHub, Slack, and many modern SPAs, the most robust connector often uses the app's first-party internal endpoints from an authenticated browser context. Tools like OpenCLI and Unbrowse point toward a workflow where browser sessions discover routes and tokens, then connector code calls APIs directly.

The hard part is governance: which discovered routes are safe to share, how auth is represented, how route versions are tested, and whether public route registries are acceptable for personal-data connectors.

### 4. Human-in-the-loop browser surfaces are an operational requirement

Docker/browser connector support will remain brittle until the reference provides one of:

- a local visible browser path,
- a noVNC/Xvfb browser sidecar,
- a cloud browser live-view integration,
- a host-browser bridge,
- or clear per-connector "manual action required outside Docker" failures.

Browserbase Live View is the clearest external precedent for watch/control/embedding. PDPP does not have to use Browserbase, but the product requirement exists.

### 5. Skills/adapters need versioned, testable artifacts

the owner's "global repository of learned flow knowledge" should not be an unstructured prompt dump. The disciplined version is closer to:

- platform skill or adapter version,
- supported auth states and variants,
- deterministic fallback graph,
- required secrets/profile state,
- fixture set proving each branch,
- schema output contract,
- repair history,
- risk rating,
- owner/reviewer approval.

This could live as connector-local skill files, OpenCLI-style adapters, OpenSteer selector caches, or a PDPP-specific registry. The common requirement is reviewability.

## Evaluation Criteria

Every candidate tool should be evaluated against the same grid:

1. **Role fit:** runtime connector, login helper, discovery copilot, fixture capture, repair copilot, hosted browser, or local host-browser bridge.
2. **Determinism:** can the same input/session replay produce the same records?
3. **Evidence:** can we capture raw provenance, network logs, DOM snapshots, screenshots/recordings, and decision logs?
4. **Security:** where do credentials, cookies, prompts, screenshots, and page content go?
5. **Grant safety:** can the tool be structurally constrained before data extraction, or only filtered afterward?
6. **Schema discipline:** does output pass connector `validateRecord()` and preserve stable primary keys/cursors?
7. **Human takeover:** can an owner watch/control a stuck session, provide OTP, solve challenge, or cancel?
8. **Operational fit:** works locally, in Docker, in CI, with persistent profiles, and without hidden services?
9. **Repair loop:** can failures produce patches/tests instead of ephemeral agent memory?
10. **Legal/licensing:** license, hosted terms, ToS posture, public route registry implications.
11. **Cost/latency:** model cost, browser session cost, proxy cost, and wall-clock time for common login/extraction flows.
12. **Internationalization:** can the flow handle locale/region variants and non-English UI text?

## Candidate Pilot Tracks

### Pilot A: Agent-assisted login, deterministic extraction

Use Stagehand or OpenSteer for login/session repair on one connector that currently needs human/browser work, while keeping extraction code deterministic.

Good candidates:

- ChatGPT: session expiry / Cloudflare / unexpected login UI.
- Chase or USAA: OTP and anti-bot handoff, but only with strong stop conditions to avoid account-risk loops.
- Instagram or Google-style OAuth in a non-PDPP sandbox: low data risk, high login variability.

Success criteria:

- login completion rate improves,
- deterministic extraction code unchanged,
- no record data is sent to a hosted LLM unless explicitly approved,
- run timeline records enough diagnostics,
- fixture/replay captures the post-login extraction path.

### Pilot B: Internal API discovery and adapter authoring

Use OpenCLI-style adapter authoring, Unbrowse, or OpenSteer to discover internal routes for one platform, then convert the result into normal PDPP connector code.

Good candidates:

- Reddit real-shape pilot,
- ChatGPT route repair,
- GitHub or Slack only if it improves over official/API-token paths.

Success criteria:

- discovered route is documented,
- auth strategy is explicit,
- output maps to manifest streams,
- integration test replays scrubbed fixture rows through `validateRecord()`,
- no public registry publish without owner approval.

### Pilot C: Docker/browser interaction surface

Evaluate Browserbase Live View vs local noVNC/Xvfb vs host-browser bridge for Docker runs that require manual login/OTP.

Success criteria:

- dashboard run page can link/embed a live browser session or provide exact external action,
- secrets are not persisted into timeline,
- session recording/log retention is documented,
- works for at least one connector that currently fails in Docker due to lack of visible browser.

### Pilot D: Skill/adapter repository shape

Design a PDPP "connector skill" or "adapter" artifact that captures learned platform knowledge without making it normative runtime behavior.

Success criteria:

- versioned artifact format,
- explicit owner/reviewer,
- fixture/eval references,
- fallback branches for known flow variants,
- promotion path from exploratory note to connector code.

## Current Leaning

Do not adopt a browser-agent framework as the connector runtime.

Do use browser-agent tooling aggressively as a development and repair accelerator, especially for login/session repair and API-route discovery. The production artifact should remain deterministic connector code plus tests, unless a future OpenSpec change explicitly defines a constrained agent-backed connector mode.

Near-term ranking:

1. **Stagehand/OpenSteer for agent-assisted login repair** because it preserves deterministic extraction and directly addresses ChatGPT/Chase/USAA pain.
2. **OpenCLI/Unbrowse-style internal API discovery** because API-backed connectors are faster, cheaper, and easier to validate than visual automation.
3. **Browserbase/noVNC/host-browser live view** because Docker browser connectors need an operator surface.
4. **browser-harness/Page Agent as research inputs** rather than direct runtime dependencies.

## Promotion Trigger

Promote this note into one or more OpenSpec changes when we choose any concrete pilot that changes runtime behavior, Docker/browser topology, connector authoring workflow, fixture policy, security posture, or public capability advertisement.

Likely future changes:

- `evaluate-agent-assisted-login-for-connectors`
- `define-browser-connector-interaction-surface`
- `define-connector-skill-registry`
- `pilot-internal-api-discovery-workflow`

## Decision Log

- 2026-04-19: Initial note captured browser-use/browser-harness, Unbrowse, and Page Agent as open questions.
- 2026-04-25: Expanded into a broader landscape and evaluation frame after the owner requested OpenSpec capture for OpenSteer, Browserbase, Stagehand, Browser Use, OpenCLI/adapters, browser-harness, Unbrowse, Page Agent, and Kahtaf's agent-login findings.
