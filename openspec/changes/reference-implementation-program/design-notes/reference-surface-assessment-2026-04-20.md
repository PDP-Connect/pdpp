# Reference surface assessment — 2026-04-20

**Status:** observation / not-a-proposal
**Author:** Claude Code (Anthropic's coding agent, acting as reviewer)
**Caveat:** This is a coding agent's critique, not a human reviewer's. The agent read the repo at HEAD on 2026-04-20 and wrote this from observation. Treat it as one outside read, not as steering from an informed stakeholder. Anywhere this note conflicts with the owner's judgement or a human reviewer's read, the human is right.

## Purpose

Give the `reference-implementation-program` a durable snapshot of how the end-to-end reference surface — reference implementation + polyfill package + control-plane dashboard + website reference page + CLI — reads as a single system as of today, so future iteration has a clear baseline.

This note is not a change proposal. It produces no capability edits. Its only purpose is to capture an honest read at a point where the program has advanced meaningfully and the weakest link has shifted.

## Method

The agent reviewed, at HEAD:

- all active OpenSpec changes (`reference-implementation-program`, `harden-reference-boundaries`, `rename-reference-implementation`, `add-polyfill-connector-system`)
- `reference-implementation/` server, runtime, CLI, and spine
- `packages/polyfill-connectors/` manifest and connector surface (30 connectors at various states)
- `apps/web/src/app/dashboard/*` control-plane surface
- `apps/web/src/app/page.tsx` and `apps/web/src/components/ReferenceApp.tsx` reference page
- `spec-core.md` and `spec-collection-profile.md` status labels
- `notes-4-15-2026.txt` (the owner's open concerns)
- recent commit history (30 commits)

The agent did not run the dev server or the control plane. All observations are static-read.

## What advanced meaningfully since 2026-04-16

1. **A reference-implementation program artifact now exists in OpenSpec.** `reference-implementation-program` is the canonical steering document. The inbox memos have been demoted to `docs/archive/2026-04-e2e-superseded/`. The steering layer moved from ad-hoc memos into versioned OpenSpec changes. This is the biggest durability upgrade in the codebase this week.

2. **The polyfill connector fleet is real.** 30 connectors against real platforms with a real scheduler, real browser profile, real ntfy inbox, real pause/resume on INTERACTION, and ~50k records already queryable from YNAB, Gmail, ChatGPT, USAA. This moves PDPP from "one-world demo" to "running polyfill system against one person's data."

3. **The control plane v1 landed.** Operator console at `/dashboard` with Overview, Traces, Grants, Runs, Records, Search — all URL-addressable, all backed by real `_ref` readers, with a command palette and peek pattern. The `reference-implementation-program` tasks list has every Phase 0–5 checkbox marked done, with a correctness-hardening follow-up also done.

4. **Event/trace spine is in place.** `reference-implementation/lib/spine.js` is shared across server and runtime. The dashboard pivots across trace → grant → run are real, not storyboarded.

5. **Spec labeling and scope are honest.** `spec-core.md` distinguishes protocol-enforced constraints / structured policy declarations / attributed client claims. The auditability/transparency boundary is explicit. Collection Profile is labeled as a companion.

6. **Governance and authority order is spelled out.** `reference-implementation-program/design.md` § "Authority order" states: root spec → code and tests → OpenSpec. That is the right order and it's written down.

## What is unchanged from 2026-04-16

**The reference landing page (`apps/web/src/app/page.tsx` + `ReferenceApp.tsx`) has not been touched since commit bd14df5 on 2026-04-15.** Every critique in the prior assessment still literally applies:

- Stepper starts at Enforce; scroll starts at Ingest (still inconsistent).
- Hero stacks headline + lede + sub-lede + `ReferenceHeroProof` + arrow-row summary (still overloaded).
- The core claim is restated 4–5 times across hero/sub-hero/section narratives (still nervous).
- `CollectionConvergence` still opens section 1 with topology, not enforcement.
- `ReferenceApp.tsx` is still 1747 lines in one file.
- Trust-model table is still buried at L2 in the Consent detail panel.
- `Multi` still hand-waves with decorative Spotify/Oura cards while only Longview carries stateful flow.
- the owner's own notes-4-15-2026 concerns (AI-sloppy "actually", hero density, "The server enforces it" out of order, slow scroll-in animations, multi-world question) are still open.

`notes-4-15-2026.txt` is still the only place those concerns live.

## Meta-pattern: the weakest link moved

In the last assessment the reference page was the weakest surface because it was the most audience-facing artifact, even though the substrate under it was shallow. Now:

- The substrate got much deeper (polyfill fleet, control plane, CLI, event spine, OpenSpec governance).
- The page stood still.

The gap between "what PDPP can actually demonstrate" and "what the page claims PDPP is" widened. That gap is now the most expensive thing about the reference surface — not because the page got worse, but because the surface area of provable claims grew and the page did not update to show any of them.

Examples of what the page could now prove but doesn't:

- **Polyfill realization is real.** The page mentions "Native API / Browser / Import" as collection paths (CollectionConvergence) but does not show that 30 polyfill connectors exist, that YNAB+Gmail+ChatGPT+USAA are actually queryable, or that INTERACTION pause/resume works.
- **The control plane exists.** The page doesn't link to `/dashboard`. A CEO or standards reviewer visiting the site has no way to see that PDPP has an operator console showing real traces and grants.
- **The CLI exists.** `pdpp auth login`, `pdpp grant timeline`, `pdpp trace show` — a serious operator surface with no mention on the page.
- **The event spine is live.** Grant → trace → run correlations are pivotable in the dashboard. The page's narrative about "durability" and "enforcement" has nothing to point at for this.
- **Governance is in OpenSpec.** Standards reviewers specifically care about governance artifacts. The page has no "how this project is governed" surface; `openspec/` is invisible from the web.

## Quality-weighted ranking (agent's read)

From strongest to weakest right now, by how much each surface advances PDPP's credibility for its stated audiences:

1. **OpenSpec governance layer** — most under-marketed asset. Standards reviewers will value it disproportionately once they see it. Currently invisible from the web.
2. **Polyfill connector package** — proves the "browser automation as polyfill" thesis with real scale (30 connectors, ~50k records). Currently mentioned abstractly on the page but not demonstrated.
3. **Control-plane dashboard** — proves the protocol is inspectable end-to-end. Currently not linked from the reference page.
4. **Spec-core + Collection Profile** — honest scope, clear boundaries. Solid.
5. **CLI** — a real second read of the protocol. Currently has no page presence.
6. **Event/trace spine** — enables the inspection story the dashboard tells. Invisible to a reader not already looking at code.
7. **Reference page** — same weaknesses as 2026-04-16, and now systematically understates what the project can demonstrate.

## Recommended next structural move (not a proposal, an observation)

The highest-leverage reference-surface work is probably not another pass on the landing page's section order or copy. It is one of these two things, in order of impact:

1. **Make the control plane publicly reachable and linked.** Even a read-only, gated preview on Vercel (`/dashboard` already exists and is gated per commit `fa4e99c`). A single link from the landing page that says "See the reference implementation running" and goes to a live trace/grant/run console would do more for credibility than any hero copy pass. This directly answers the evaluation-lens question "how many of 85 concepts and 12 flows are demonstrated vs. mentioned" — because demonstrated concepts jump from ~5 to dozens.

2. **Surface the OpenSpec governance on the web.** Standards reviewers and enterprise readers specifically look for a governance artifact. `openspec/changes/*/proposal.md` and `openspec/specs/*/spec.md` are already authoritative, durable, and human-readable. A `/governance` page that renders them (or even links to the repo tree) converts invisible rigor into visible rigor.

Both are cheaper than redesigning the landing page, and both increase the page's honesty by expanding what the reader can click through to.

After those two, the landing-page critiques from 2026-04-16 become worth revisiting — at that point the page is shaping a reader who has much more to explore than before, so editorial discipline on the page pays compounding returns.

## What the agent is not qualified to judge

- Whether the polyfill connector schema design (flat, platform-native field names, no universal layer) is the right long-term bet or a 10k-record decision that will hurt at 10M records.
- Whether the `packages/polyfill-connectors/` boundary from `reference-implementation/` is drawn in the right place for a future fork.
- Whether the "inspection-first" control-plane contract should stay inspection-only or should open into selective mutation.
- Whether the current Longview reference world is too narrow to carry the "one protocol across platforms" claim, or whether the 30-connector polyfill fleet already answers that claim from a different angle.
- Anything about business, GTM, investor, or standards-body dynamics.

## What this note is and is not

This is an outside-read observation by a coding agent, captured where future iteration can find it. It is not a decision, a steering directive, or a change proposal. If any of it is wrong, the code and the OpenSpec specs are authoritative; this note is not.

Delete this note freely once it is no longer useful.
