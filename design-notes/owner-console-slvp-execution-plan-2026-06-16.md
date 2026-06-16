# Owner Console SLVP Execution Plan

Status: sprint-needed
Owner: RI owner
Created: 2026-06-16
Updated: 2026-06-16
Related: design-notes/full-context-refresh.md, tmp/workstreams/ui-journey-owner-ledger-2026-06-16.md, docs/research/shippability-audit-2026-06-16.md, docs/research/sources-slvp-redesign-and-data-health-2026-06-11.md, docs/research/slvp-connector-health-FINAL-design-2026-06-15.md, docs/research/control-plane-prior-art.md

## Question

How should the RI owner get the PDPP console to the SLVP ideal quickly and confidently, without repeating the last week of UI churn?

## Context

The console is a reference-implementation owner cockpit for real personal data infrastructure. It is not PDPP Core, and it is not primarily a connector framework UI. Its job is to prove that a personal-server owner can collect, inspect, recover, and grant data access through disciplined protocol boundaries.

The live UI failed a rushed owner walkthrough. The specific complaints are important, but they are sample evidence rather than a finite bug list. The deeper failure was that worker lanes optimized local proxies ("no dead-end labels", "green mocked tests", "copy clarified") instead of the shipped journey. The refresh document explicitly forbids this: internal construction criteria are necessary but never the acceptance target; completion is judged by user journeys on shipped surfaces.

Reverting failed commits is not the same as reaching the target state. A revert can remove newly introduced regressions, but it leaves pre-existing trust failures live: add-source dead ends, browser-session crashes, empty stream facts, route confusion, and recovery incoherence. Stabilization is the entry fee for good work, not proof of shippability.

The working target:

> PDPP's console must make a motivated personal-server owner feel: "I know what data I have, I know how to add more, I know what is broken, I know what to do next, and I trust this system."

## Stakes

If the console is unclear, it weakens more than the UI:

- It makes PDPP look like a connector dashboard rather than an authorization/disclosure protocol.
- It hides the Core vs Collection Profile split under operational noise.
- It asks the owner for repeated human QA instead of producing owner-grade evidence.
- It burns agent wall clock through reactive patching.
- It reduces confidence that Vana/OpenDataLabs engineers, standards reviewers, and peer teams would trust the reference implementation.

## Current Leaning

### 0. How we got off course

We got off course through a process failure:

- the owner gave broad signals that the surface was not shippable; workers were handed narrow tasks as if those signals were a finite bug list.
- Acceptance collapsed from "owner completes the journey" into local proxies: labels changed, tests mocked, screenshots skimmed, and copied strings passed scanners.
- Component ownership split from journey ownership. Each lane could make its file look better while the cross-route owner path got worse.
- The data model and attention model were not treated as hard dependencies before presentation changes. That let hero, runs, source detail, and diagnostics independently compute "what needs attention."
- The review object was code and isolated route output, not a confused-owner journey with real pixels, real data, console/network capture, and one declared acceptance verdict.

The correction is not "more careful UI polish." The correction is a different operating model: define the owner promise, evidence the journey, derive surfaces from one truth, and only then let workers implement bounded changes.

### 1. Product target

The console does not need to be a consumer app for everyone. It needs to be a world-class owner cockpit for a motivated personal-server operator. "Friends/family delight" is an ambition and external validation target, not the first internal acceptance bar.

The internal bar is:

- **Clarity:** The owner can identify data sources, records, freshness, and gaps.
- **Momentum:** Every primary action either completes a real step or explains honestly why no step exists.
- **Trust:** Status, copy, and actions never contradict the backend truth.
- **Craft:** The interface feels serious, calm, precise, and intentionally designed.

### 2. Dominant object

The dominant object is the configured data source/connection: a specific account, workspace, device, artifact-backed source, or browser/API source that contributes records.

Runs, traces, schedules, and diagnostics are evidence layers. They are not the front door for normal recovery or setup. This follows the control-plane prior-art pattern: Airbyte is connection-centric; Temporal is run-centric only once debugging a single execution; Dagster chooses the object the operator actually cares about. For PDPP owner work, the object is the source/connection, not raw traces.

Practical UI rule:

- The Sources area answers: what data do I have, what condition is it in, how do I add/update/fix it?
- Runs answer: what happened during one bounded collection attempt?
- Traces answer: what protocol/runtime events occurred?
- Connect AI apps answers: who can read already-collected data under a grant?

### 3. Archetype state matrix

We do not test every connector/state combination. We test one representative for each owner-decision class:

| Archetype | Example | Owner question | Required surface behavior |
|---|---|---|---|
| Healthy scheduled API | Gmail, Slack | Is my data current? | Calm status, freshness, records, optional manual refresh. |
| Static-secret setup | Gmail/GitHub app password/PAT | Can I add another account? | Manifest-generated form, validation before commit, identity echo, durable status page. |
| Browser-session setup | Amazon/ChatGPT/Chase-style | Can I log in safely? | Real browser starts or inline cause-specific failure; no page error boundary. |
| Local collector/device | Claude Code/Codex | Is the device pushing? | Device identity, last push, backlog/recovery only when owner can act. |
| Manual artifact import | WhatsApp/Timeline/Apple Health | What did this file add? | Upload/preview/import receipt, coverage, gaps, duplicate handling. |
| Unsupported/unavailable source | Strava/Pocket-like | Can I set this up now? | Hidden by default or clearly separated as unavailable; no primary setup button. |
| Revoked source | revoked Notion/Reddit | What remains and how do I resume? | Records remain visible, revocation state clear, reconnect/reactivate affordance only if real. |
| Running source | current sync/import | Is work progressing? | Progress, last message/count/total if connector can emit it; no fake certainty. |
| Degraded self-healing | retryable gap/cooldown | Do I need to act? | Advisory or calm per agency rule; no false alarm; detail one click down. |
| Degraded owner-action | expired credential/local dead-letter | What do I do? | One cause-specific action, exact destination/commands, no forensic detour. |
| Maintainer/code issue | terminal code fix | Is it my fault? | Honest non-owner-action status; no "we are on it" hosted-service fiction. |
| Unknown/checking | missing evidence | Should I worry? | Grey/checking, never confident degraded/retry copy. |

Every UI journey and screenshot must map to at least one archetype. New states are added to the matrix before they are patched.

### 4. Core journeys

There are five core journeys. Everything else is secondary until these pass:

1. **Add data.** Choose a source, understand whether it can be added now, complete setup/import, and see progress/status.
2. **Manage sources.** Compare configured sources/accounts/devices, understand records, freshness, schedule, and condition.
3. **Inspect data.** Move from a source/stream to Explore and verify records are there.
4. **Recover problems.** Understand what is broken, whether the owner is needed, and the one real next action.
5. **Connect AI apps.** Understand this grants scoped read access to already-collected data; it is not data collection.

### 5. Process architecture

Use a two-layer process:

- **Codex RI owner owns truth, gates, integration, live-stack safety, and the final priority queue.**
- **Claude Opus / dynamic workflows own broad design critique, visual option generation, and adversarial review over evidence artifacts.**

Workers do not decide what ships. Workers do not "make it delightful" from a vague prompt. Workers review broadly, then implement narrowly from owner-authored acceptance packets.

### 6. Evidence artifacts

Before any more broad UI work, produce a journey-keyed screenshot/PDF atlas. Route screenshots are insufficient because they recreate the failure mode: individual pages can look locally acceptable while the owner's path is incoherent.

The atlas is organized by owner question:

- **J1: I know what data I have.** Source list, source detail, stream facts, Explore handoff.
- **J2: I can add more.** Add-source selection, available/unavailable distinction, setup/import path.
- **J3: I know what is broken.** Dashboard/hero, source list, runs, source detail agree on attention.
- **J4: I know what to do next.** Recovery CTA lands on one cause-specific action, not traces/runs or generic diagnostics.
- **J5: I trust this system.** Unknown is checking, unavailable is honest, copy does not impersonate a hosted service, no false primary actions.

Each journey artifact includes:

- Real live data plus synthetic fixtures only for missing archetypes.
- Desktop and mobile captures.
- Browser console errors and failed network requests.
- The exact route sequence and user intent.
- A pass/fail/persona verdict, not just a visual thumbnail.
- Stable filenames so workers can cite evidence precisely.

The atlas becomes the object reviewed by Opus/dynamic workflows, Codex, and future workers.

### 7. Dynamic workflow usage

Use Opus ultracode/dynamic workflows for review and synthesis, not direct shipping.

Recommended Opus workflow roles:

- Confused-owner reviewer: can a motivated owner complete the job?
- Trust/honesty reviewer: false CTAs, hidden assumptions, impossible actions, hosted-service voice.
- Visual craft reviewer: SLVP quality, layout, hierarchy, density, rhythm, mobile.
- IA/noun-model reviewer: sources/connections/runs/traces/connect-apps mental model.
- Prior-art reviewer: Stripe/Linear/Vercel/Plaid plus Airbyte/Temporal/Dagster where relevant.
- Red-team reviewer: attack proposed fixes for new contradictions or Goodharted acceptance.

Deliverable: one ranked heatmap keyed by journey + archetype + screenshot reference, with acceptance checks and explicit "do not fix yet" items. Workers may not self-certify shippability; they produce evidence for owner review.

### 8. Implementation waves

Implement by journey, not by component:

1. **Wave 0A — Stabilize.** Deploy the regression revert only after visual verification. This removes known bad changes; it does not declare the product good.
2. **Wave 0B — Single attention truth.** Establish one server-derived/rendered verdict attention set used by dashboard hero, runs, source list, source detail, and recovery CTAs. No attention-surface UI lane merges before this dependency is true.
3. **Wave 1 — Row/pill honesty invariants.** Unknown -> Checking/grey, unavailable -> unavailable, status never changes row geometry, selection affordance never collides with content.
4. **Wave 2 — Sources/connection cockpit.** One dominant source list/detail model, comparable rows, exact connection routing, useful stream facts, selected-state craft.
5. **Wave 3 — Add data truth.** Available sources only in the primary flow, honest unavailable handling, manifest-generated setup/import, no false CTAs.
6. **Wave 4 — Browser-session root cause.** Amazon/connect crash is an infra/runtime path until proven otherwise; no mocked-fetch "fix" is admissible.
7. **Wave 5 — Inspect and grant.** Source/stream -> Explore path, Connect AI apps separation, grant read-surface clarity.
8. **Wave 6 — Craft and delight.** Visual rhythm, first-run narrative, empty states, mobile, and a memorable "your data under your control" moment.

Each wave has a small owner-authored acceptance packet before any code lane starts.

### 9. Gates

No UI deploy without:

- Screenshot before/after for affected journeys.
- Real headed Playwright path for at least one canonical positive case.
- Browser console and failed-network capture.
- No false-action/jargon scanner regressions.
- Relevant unit/type/OpenSpec checks.
- Codex pixel review.
- Live-stack mutex declaration and closeout with smoke evidence.

Each gate must cite the journey row it closes. Pixel review is a deploy gate, not merely a merge gate. Unit tests are required, but never sufficient.

### 10. Confidence model

Use explicit confidence levels:

- **50%:** code compiles and unit tests pass.
- **65%:** screenshot atlas reviewed by the owner.
- **80%:** real Playwright journeys pass with console/network capture.
- **90%:** independent adversarial lanes find no P0/P1 blockers.
- **95%:** the owner completes a fresh walkthrough without discovering a new trust/task blocker.
- **95%+ external delight:** requires external users. Internal agents can prepare for it but cannot prove it.

Current honest confidence after the failed journey-batch:

- Reverting the specific bad UI regressions is correct: **99%**.
- The plan shape, as amended here, is the right operating model: **~90%**.
- Reaching a stable recovery + sources spine in one focused 72-hour cycle: **~55%**, because this is now a journey/data-truth problem, not a copy pass.
- Full "colleagues/Reddit/friends/family delight" across the whole console in 72 hours: **~20%**. That requires more than internal agent evidence; it needs external users after the core trust lies are gone.

### 11. First 72 hours

#### Hour 0-4: stabilize

- Visual-check `workstream/ui-journey-regression-stabilize`.
- If it removes the known regressions without new ones, deploy under live mutex and explicitly label remaining P0s as still open.
- Close current live-worker lanes or mark them superseded so they stop producing stale changes.

#### Hour 4-12: atlas

- Generate the journey-keyed screenshot/PDF atlas for the five core journeys and archetypes available in live data.
- Add synthetic fixtures only where live data lacks a key archetype.
- Capture console/network diagnostics for every journey.

#### Hour 12-24: Opus dynamic review

- Run one Opus dynamic workflow over the atlas with the six reviewer roles.
- Require a single heatmap report, not code.
- If web prior art is used, write to `docs/research/` per the research corpus rule.

#### Hour 24-36: owner synthesis

- Codex merges Opus heatmap, existing research, and live audit into one prioritized implementation board.
- Mark P0 trust/task blockers, P1 comprehension blockers, P2 craft, P3 expansion.
- Explicitly reject or defer work that is tempting but not load-bearing.

#### Hour 36-72: first build wave

- Wave 0B is first if any attention surface still disagrees.
- Then Wave 1 or Wave 2 depending on evidence:
  - If unknown/status/selection/geometry still lies or churns rows: Wave 1 first.
  - If source identity and streams remain useless: Wave 2 first.
  - If add-source still contains false actions/dead ends after stabilization: Wave 3 follows.
- Spawn bounded workers only from owner packets.
- Gate with screenshots + Playwright + Codex review before deploy.

Explicitly not promised in this 72-hour window:

- Full browser-session root-cause closure if the crash requires n.eko/network/runtime work.
- External-user delight proof.
- Rewriting the entire console navigation or design system.
- Any change that depends on unearned source-specific connector assumptions.

## Promotion Trigger

Promote into OpenSpec before implementing any tranche that changes:

- source/connection/state contracts,
- setup availability semantics,
- acquisition/coverage semantics,
- rendered verdict / action contracts,
- dashboard-to-runtime API shapes,
- or durable owner-facing behavior across routes.

Pure layout/copy fixes can remain ordinary branches if they do not change contracts.

## Decision Log

- 2026-06-16: Captured the RI owner plan after the failed journey-batch. Decision: stop broad UI churn, stabilize known regressions, generate an evidence atlas, use Opus/dynamic workflows for critique over evidence, use Codex as integration/deploy gate, and implement by journey waves.
- 2026-06-16: Incorporated Opus review. Corrections: atlas must be journey-keyed rather than route-keyed; revert is stabilization only, not shippability; a single attention-truth model is a dependency before more attention-surface presentation work; and workers produce evidence, not shippability verdicts.
