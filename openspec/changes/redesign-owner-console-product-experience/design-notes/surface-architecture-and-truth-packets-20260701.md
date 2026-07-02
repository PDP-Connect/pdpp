# Owner Console Surface Architecture And Truth Packets

Status: decision packet
Owner: RI owner
Created: 2026-07-01
Related: `openspec/changes/redesign-owner-console-product-experience`

## Scope

This packet closes the remaining Wave 0/Wave 1 ambiguity that does not require
new owner screenshots or a human-reviewed mock. It defines:

- which current surfaces are primary, secondary, or evidence layers;
- route alias and route-hygiene direction;
- the Source / collector / device owner-language hierarchy;
- implementation packets for source truth, counts, drill-through, full
  visibility, CTA subject scoping, and setup/recovery liveness;
- what internal agents can prove without a human walkthrough.

This packet does not claim the owner console is complete. Desktop/mobile atlas
captures, browser-console/network evidence, and human-reviewed mocks for the
Runs/Syncs and Explore merger questions remain open.

## Budget And Execution Posture

Clawmeter at tranche start:

- OpenAI: 5h 8%, 7d 38%, estimated 138% at reset.
- Claude: 5h 48%, 7d All 10%, estimated 12% at reset.

Decision: keep Codex focused on integration, source-of-truth decisions, and
validation. Use low-cost Claude lanes for future screenshot capture, broad
route inventories, and red-team checks only after the acceptance packet is
written. Do not spawn exploratory lanes before the scope has an oracle.

## Surface Architecture Decision

### Primary Owner Surfaces

| Surface | Owner job | Canonical journey | Decision |
|---|---|---|---|
| Dashboard | Show the current attention queue and next best owner move. | OJ1, OJ4 | Primary, but it must be a routing and summary surface, not its own source of truth. It consumes `sourceWorkFromConnectors` and must drill into the same subjects it counts. |
| Sources | Show configured data-producing Sources, their streams, freshness, coverage, schedule, and owner actions. | OJ1, OJ2, OJ4 | Primary. This is the collection control-plane front door. |
| Add Data | Add another Source or import/enroll data-producing material. | OJ2 | Primary, but only for setup paths this deployment can honestly perform now. |
| Explore | Query and inspect records across Sources. | OJ3 | Primary record workbench. It must share record rendering and URL state with stream-scoped views. |
| Grants / Connect AI Apps | Explain client authority and actual reads. | OJ5 | Primary access-review surface. Connect AI Apps is setup/help for client access; Grants is the durable authority/read review. |

### Secondary Subject-Scoped Surfaces

| Surface | Why it remains | Demotion rule |
|---|---|---|
| Syncs / Runs | The owner explicitly valued per-run and per-stream collection facts. It remains useful as an activity/evidence view. | It must not be the normal first stop for source recovery. Source detail and Dashboard own recovery routing. |
| Traces / timelines | Needed for audit and debugging. | Generic trace browsing is advanced. Normal owner paths reach traces from Source, Grant, Read, Run, or Credential context. |
| Schedules | Source policy. | Keep reachable, but schedule facts should render on Source detail and recovery/status surfaces. |
| Device exporters / local collectors | Runtime infrastructure attached to Sources. | Keep reachable for device setup/repair, but source status owns the owner-visible problem statement. |
| Deployment / owner tokens | Operator administration and owner-agent bootstrap. | Keep advanced. Do not present as normal data-source or client-grant UX. |

### Merge Decisions

- Do not merge or delete Runs/Syncs yet. The current decision is "secondary
  activity evidence view, retained until a human-reviewed mock proves the
  per-run/per-stream facts are preserved elsewhere."
- Do not fully merge Explore and stream-scoped record views yet. The current
  decision is "shared record model and URL state, separate destinations":
  stream views provide source context and full-set stream reachability; Explore
  provides cross-source query, facets, charting, and saved/shareable workbench
  state.
- Do not demote Grants or Connect AI Apps into advanced routes. Access review is
  a core promise; raw trace/package mechanics are the part to demote.

## Route Hygiene Plan

Near-term route rule: keep `/dashboard` as the implementation prefix. Do not
rename backend/API concepts. Add owner-clean aliases only through route helpers
after subject-preserving links are testable.

Planned aliases:

| Owner alias | Current route | Compatibility |
|---|---|---|
| `/dashboard/sources` | `/dashboard/records` | `/dashboard/records` remains supported. |
| `/dashboard/sources/add` | `/dashboard/records/add` | `/dashboard/records/add` remains supported. |
| `/dashboard/sources/[source]` | `/dashboard/records/[connector]` | Existing record links remain supported. |
| `/dashboard/sources/[source]/streams/[stream]` | `/dashboard/records/[connector]/[stream]` | Existing stream links remain supported. |
| `/dashboard/syncs` | `/dashboard/runs` | `/dashboard/runs` remains supported as the current route. |

Alias acceptance requirements:

- all links are generated through one helper per subject type;
- the rendered page uses owner nouns even when reached from a legacy route;
- links preserve `connection_id`, stream, grant/package, run, trace, credential,
  or client subject in route params or URL state;
- redirects never turn a subject-scoped action into a generic list.

Routes not aliased in this tranche:

- `/dashboard/grants`, `/dashboard/connect`, `/dashboard/traces`,
  `/dashboard/deployment`, `/dashboard/device-exporters`, and
  `/dashboard/event-subscriptions` keep current paths until their owner-spine
  packet reaches implementation.

## Source / Collector / Device Hierarchy

Owner-language hierarchy:

| Noun | Meaning | Display rule |
|---|---|---|
| Source | One configured data-producing account, device, artifact import, or provider-backed binding. | Primary owner noun. Multiple provider accounts are multiple Sources. |
| Source type | The connector/provider kind, such as Slack, ChatGPT, GitHub, or local collector. | Secondary type label, never the row identity by itself. |
| Stream | A typed record subset under one Source. | Child row or facet of a Source. |
| Collector | Runtime mechanism that emits records for a Source, such as browser, API, local CLI, upload/import, or device exporter. | Property of Source setup/status, not the primary noun. |
| Device | Physical or logical host involved in local collection. | Shown when it explains where an owner must act or why data is stale. |
| Credential | Secret/session/provider grant material used by a Source. | Shown as repair/setup policy, never as raw secret. |
| Schedule | Source collection timing policy. | Shown on Source detail and schedule surfaces. |

Default rule: one Source has one active collection authority for a given record
namespace. A Source may intentionally involve multiple collectors only when the
product contract defines why they are peers for one logical source, how duplicate
records are resolved, and which device/collector the owner must act on. Without
that explicit contract, multiple accounts/devices/imports are separate Sources.

## Implementation Packets

Each packet below is an implementation contract, not a local bug ticket.

### Packet A: Technical Probe Findings To Implementation Packets

| Probe finding | Packet | Owner promise | First implementation target |
|---|---|---|---|
| Amazon sample/count looked contradictory without proving data loss. | Count basis and full-set path. | Know data, Inspect data. | Source stream rows and Explore scoped entry must show basis labels and full-set path. |
| GitHub setup could say success without settled record-yield meaning. | First-sync status honesty. | Add data, Know data. | Setup/status surface distinguishes accepted, running, succeeded with yield, succeeded zero-yield, and failed. |
| Local collector recovery produced confusing "checking/unknown" after repair. | Recovery liveness. | Recover problems. | Source detail/Dashboard show verifying progress and terminal reconciliation. |
| Grant package count and internal source leakage were hard to interpret. | Access package model. | Grant/Connect AI Apps. | Grants show client -> package -> child grants and filter internal maintenance sources from normal owner scope. |
| Run/detail/trace navigation dropped context. | Subject-scoped evidence. | Activity/audit evidence. | Run/trace links preserve source/grant/read subject and headline it on landing. |

### Packet B: Counts Contract

Every count rendered to the owner must identify exactly one basis:

| Basis | Meaning | Allowed label shape |
|---|---|---|
| `total_held` | All retained current records for the Source/Stream/Grant-visible set. | `N records total` |
| `current_filter_total` | Full result count under current query/filter state. | `N match current filters` |
| `current_page_or_preview` | Rows currently rendered as page/window/preview. | `N shown` plus total if known |
| `latest_run_yield` | Records emitted in the latest run, including updates if available. | `latest run: N collected` |
| `latest_run_new` | New records first seen in the latest run. | `latest run: N new` |
| `latest_meaningful_run_new` | New records in the latest run that found data when the latest run only checked. | `last run with new data: N new` |
| `owner_action_predicate` | Count of Sources/actions matching a specific next-action predicate. | `N sources need you`, `N ready for review` |

Hard rule: a count label may be short in the UI only if the drill-through or
tooltip exposes the basis. A page/window count with no full-set path is not an
accepted owner answer.

Primary files likely involved:

- `apps/console/src/app/dashboard/lib/source-actionability.ts`
- `apps/console/src/app/dashboard/records/sources-view-model.ts`
- `apps/console/src/app/dashboard/records/[connector]/page.tsx`
- `apps/console/src/app/dashboard/runs/syncs-model.ts`
- `apps/console/src/app/dashboard/explore/page.tsx`
- `packages/operator-ui/src/explore/**`

Oracle:

- add or update tests that assert label basis for each count kind;
- run focused console tests for Sources, Runs/Syncs, Source detail, and Explore;
- data-truth probe compares one live Source's stream count, scoped Explore count,
  latest run yield, and page/window label.

### Packet C: Rollup Drill-Through Contract

Rollup counts must drill through to exactly the subjects counted.

| Rollup | Count predicate | Drill target |
|---|---|---|
| Dashboard "Needs you" | `SourceWorkItem` in `needsOwner` | Dashboard section row or filtered Sources list with the same Source ids. |
| Dashboard "Worth reviewing" | `SourceWorkItem` in `review` | Filtered Sources/Syncs view, not a generic Runs page. |
| System or connector issue | `SourceWorkItem` in `systemIssues` plus load issues | Filtered issue list with no owner-action CTA unless action is owner-satisfiable. |
| Checking | `SourceWorkItem` in `checking` | Filtered Sources list that explains checking basis. |
| Runs/Syncs failure cards | shared source actionability failure summary | Same Source detail or run filtered to that Source. |
| Grant package counts | package child grants visible to owner | Package detail grouped by client/source, with internal maintenance children omitted or advanced-only. |
| Credential token counts | credential/session records visible in owner scope | Credential or Source repair detail filtered to the same credential/session subject. |
| Read counts | audited resource-server reads matching the visible client, Grant, Source, or Stream predicate | Grant/read audit detail filtered to the same client, Grant, Source, or Stream predicate. |

Oracle:

- shared predicate unit tests: count equals filtered rows for every group;
- route tests: every CTA includes subject id or filter state;
- browser evidence: click one rollup and verify target list count.

### Packet D: Full-Visibility Contract

No owner list may use an artificial cap as the final answer.

Allowed bounded renderings:

- a page with next/previous or cursor;
- a virtualized full-set list backed by paged reads;
- a preview card that states its basis and links to the full set;
- a chart/histogram that states it is aggregate context, not the record list.

Disallowed:

- "showing 20 records" with no total and no next/full-set path;
- "sample" copy that still looks like the answer to the Source/Stream total;
- hiding a full-set path behind raw id search or manual query syntax.

Oracle:

- invariant test that every bounded list component used on owner surfaces carries
  a `fullSetHref`, `nextCursor`, `hasMore`, or explicit `previewOnly` plus a
  full-set path;
- browser proof on one Source stream larger than one page and one Explore result
  larger than one page.

### Packet E: CTA Subject-Scoping Contract

Every owner-facing action must preserve subject and verb.

| Verb | Required subject | Accepted target |
|---|---|---|
| View records / Explore | Source, Stream, Grant, Read, or query state | Explore or stream route with URL state/header naming the same subject. |
| Review | Source, Grant, Credential, or Run issue | Detail/recovery panel for that same subject. |
| Reauthorize / Reconnect | Source credential/session | Repair/setup route for that Source, not a new-source picker. |
| Refresh / Retry / Sync now | Source or Stream | Starts or resumes a run scoped to that Source/Stream and routes to progress/status. |
| Open run | Run id plus Source context when available | Run detail with run id and Source label. |
| Open trace | Trace id plus subject context when available | Trace detail with linked Source/Grant/Read/Run context. |
| Configure schedule | Source schedule | Schedule editor/view filtered to the Source. |

Oracle:

- route/link helper tests for every subject kind;
- invariant scan that owner CTAs do not link to generic lists unless filters are
  included;
- browser proof for Source -> stream -> Explore, Source -> Run, Grant -> records,
  and Source -> Reconnect.

### Packet F: Setup And Recovery Liveness Contract

Setup/recovery surfaces must distinguish:

- accepted input;
- waiting for owner action;
- browser/session running;
- collecting;
- completed with visible yield;
- completed with zero yield;
- failed with owner action;
- failed with maintainer/system action;
- abandoned/expired.

Owner-visible progress must come from run/interaction evidence, not from a
static route state. A surface that starts or resumes work must poll/subscribe
until terminal state, or state why live reconciliation is unavailable.

Oracle:

- fixture matrix for all liveness states;
- route test that setup/read failures stay inside setup-specific boundaries;
- browser proof that a live running setup page changes state without manual
  refresh;
- data-truth probe that terminal copy matches run status and record yield.

## Internal-Agent Versus Human-Owner Proof

Internal agents can prove:

- static route/noun/vocabulary mapping;
- shared predicate identity for counts and filtered rows;
- link subject preservation;
- unit/invariant/type tests;
- read-only live API/database truth for counts, status, grants, and active runs
  when owner-authenticated inspection is available;
- browser console/network absence for deterministic route loads;
- screenshot capture for known routes when owner auth is available.

Internal agents cannot by themselves prove:

- the human owner finds a route merger intuitive;
- a fresh external owner can complete setup without confusion;
- copy has the right emotional weight for non-builders;
- a provider credential or OTP repair is successful when it requires private
  human input;
- a broad merge of Runs/Syncs into Sources preserves the facts the owner valued;
- a full Explore/stream unification is better than shared rendering plus
  separate contexts.

Required consequence: broad route/surface mergers still require a
human-reviewed mock or live walkthrough. Agents may prepare the mock, prior-art
memo, fixture, and adversarial review, but may not mark those merger decisions
accepted without the owner.

## Delegation And Review Gate

For future implementation tranches:

1. Name the owner promise: Know Data, Add Data, Inspect Data, Recover Problems,
   or Grant/Connect AI Apps.
2. Name the affected packets in this note.
3. Run the focused oracle before asking for review.
4. Produce one compact evidence file with test output, data-truth probes, and
   desktop/mobile screenshot paths when UI changed.
5. Run an adversarial review lane only after the oracle is green; the review
   reads the diff and evidence, not the implementer's summary.

Rabbit-hole filter:

- allowed: trust blocker, subject-scoping defect, count/full-set defect, setup or
  recovery liveness defect, access-review comprehension defect, tiny opportunistic
  fix inside an accepted tranche;
- deferred: copy polish without a predicate/source-of-truth change, visual tweaks
  outside a changed journey, generic route cleanup without subject-preserving
  link helpers, evidence-browser polish that does not support a subject path.

## Task Disposition

This packet satisfies:

- 2.3 primary/secondary/evidence surface decision; Runs/Syncs and
  Explore/stream merger decisions remain separately gated by 2.5 and 2.6;
- 2.4 route aliases/redirect direction;
- 2.7 Source / collector / device hierarchy;
- 2.8 owner-route hygiene direction;
- 4.7 technical-probe-to-packet conversion;
- 4.8 counts contract;
- 4.9 drill-through packet;
- 4.10 full-visibility packet;
- 4.11 CTA subject-scoping packet;
- 4.12 setup/recovery liveness packet;
- 6.4 budget-aware execution posture for this tranche;
- 6.5 rabbit-hole filter for implementation dispatch;
- 6.6 owner-spine alignment gate for future implementation tranches;
- 8.5 internal-agent versus human-owner proof boundary.

This packet does not satisfy:

- 2.5 Runs/Syncs merge decision with human-reviewed mock;
- 2.6 Explore/stream merger decision with human-reviewed mock;
- 3.2 through 3.6 journey atlas evidence;
- 6.3 adversarial review on a substantive implementation tranche;
- the 0.x RI Owner Return Gate.
