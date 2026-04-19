# Landing Page Framing Precedents for PDPP

**Date:** 2026-04-15
**Purpose:** Document the specific precedent research used to decide how the PDPP landing page should balance `why should I care?` with `how does it work?`

---

## Question

How should PDPP frame the landing page so that readers quickly understand the value of the protocol, see one believable proof that it is real, and only then move into the technical flow?

This research was narrower than the earlier paradigm-selection work. It focused on:

- How leading technical companies structure above-the-fold narrative
- How infrastructure or mostly invisible systems make themselves desirable
- How the current PDPP page can be misread by skeptical readers

---

## Precedent Table

| Site | First claim | First proof object | Transition move | Transferable lesson |
|---|---|---|---|---|
| [Stripe](https://stripe.com) | Financial infrastructure that grows revenue | Precise measurable proof in hero chrome plus scale/service claims | Claim first, then breadth and category coverage | Use one precise proof early, then expand into platform breadth |
| [Linear](https://linear.app) | The product development system for teams and agents | Real product surface running | Hero immediately becomes workflow proof | Show the system itself running, not a diagram of the system |
| [Vercel](https://vercel.com) | Build and deploy on the AI Cloud | Brand abstraction plus product taxonomy | Claim to use-case rails to platform slices | Strong for authority, weaker for protocol proof without a concrete artifact |
| [Plaid](https://plaid.com) | Turn data into revolutionary financial products | Trust/control framing plus simple API/product signals | Relationship-first framing, mechanism later | Show the relationship and trust story before the plumbing |
| [Cloudflare](https://www.cloudflare.com) | Connect, protect, and build everywhere | Scale and service proof | Hero thesis to platform explanation to scale blocks | Three-verb platform thesis is strong when backed by real scale |
| [Val Town](https://www.val.town) | Instantly deploy TypeScript web apps, APIs, AI agents | Real code/editor chrome | Claim to runnable examples immediately | If the system is code-shaped, show code instead of describing it |
| [1Password](https://1password.com) | Secure access for every human and AI agent | Governance and control visuals | Claim to trust/control proof to system details | Closest analog to PDPP's trust story: governance first, mechanism second |
| [LaunchDarkly](https://launchdarkly.com/platform/feature-flags/) | Release safely with precise control | Flag/rollout control story | Control first, topology later | Sell control and safety before release architecture |

---

## Cross-Cutting Findings

### 1. The top of the page makes one claim and one proof unavoidable

The strongest sites do not try to explain the full system above the fold. They commit to:

- one sharp promise
- one concrete proof object
- one immediate transition into either breadth or mechanism

They do not front-load architecture.

### 2. Outcome comes before topology

The repeated pattern across Stripe, Linear, Plaid, LaunchDarkly, and Vercel is:

1. what this unlocks
2. why you should believe it
3. how it works

Even when the product is mostly invisible infrastructure, the opening does not begin with hosting model, pipeline topology, or internal execution model.

### 3. The most transferable proof pattern for PDPP is "real artifact, not concept art"

The best analogs for PDPP are:

- Linear: real product surface
- Val Town: real code surface
- 1Password: access-governance surface

These support a common rule: **show the system running**. For PDPP that means a real consent surface, real request/grant artifact, or real enforcement transformation, not a decorative explainer.

### 4. The "how it works" transition usually happens within one viewport

The opening is not a long marketing layer followed by a separate docs layer. Strong sites move from promise to proof to mechanism quickly.

For PDPP this supports:

- hero = value claim
- hero or first scroll = proof artifact
- next scroll = technical flow

### 5. Machinery later does not mean vagueness now

These sites do not hide the technical reality. They simply defer it until the reader already understands why it matters. This matters for PDPP because the protocol needs both marketing force and technical credibility.

---

## Invisible-System Findings

The infrastructure/product precedents converged on the same pattern:

- sell the outcome first
- make the invisible visible through one credible control surface
- defer deployment and integration details

Applied to PDPP:

- lead with `precise, revocable, server-enforced personal data access`
- show one concrete proof moment early
- treat personal server, native platform support, browser automation, and import as realization paths, not the ontology

The first emotional beat should be close to:

> This gives me real control over personal data access, and the system is concrete enough to trust before I understand every layer.

---

## Red-Team Findings Against the Current Page

The current landing page still has three framing risks:

### 1. It teaches `PDPP = personal server` too early

The hero flow signature and the first two sections frame the page around `your server` before they frame the protocol around consent, grants, and enforcement.

### 2. It can read as `connectors/scraping` before it reads as `value/protocol`

The current Ingest section makes collection/runtime detail legible, but does so too early. That shifts attention to connector mechanics rather than to why the model matters.

### 3. It duplicates the collection-method story

The collection-method framing appears in Ingest and then again in Multi, which makes transport feel more central than the actual protocol arc.

---

## Implications for PDPP

### What the landing page should do

- Lead with the value of the protocol, not the deployment topology
- Show one proof object immediately
- Keep the technical flow central and readable
- Introduce the personal server as one concrete realization path
- Introduce native platform support, browser automation, and import after the value is established

### What the landing page should not do

- Start by implying that PDPP is fundamentally a personal-server product
- Start by implying that PDPP is fundamentally a connector/scraping system
- Ask the reader to infer the value from the spec alone
- Spread the opening argument across multiple weak artifacts instead of one strong proof object

---

## Recommendation

For hero plus first scroll:

1. Make one value claim:
   `personal data access should be precise, revocable, and enforced`
2. Pair it with one proof object:
   a consent surface plus corresponding request/grant artifact, or an equivalent dual-readability proof
3. Move into enforcement quickly:
   the reader should see the server actually strip unauthorized fields before spending much time on collection/runtime detail
4. Reposition personal server:
   one realization path that makes the model available today, not the ontology of PDPP
5. Push collection methods later:
   native API, browser automation, and import belong in the adoption-path layer, not the headline

The guiding rule is:

> Outcome first, believable artifact second, machinery third.

