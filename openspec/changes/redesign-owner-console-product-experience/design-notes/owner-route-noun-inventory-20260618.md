# Owner Route / Noun / Headline Inventory

Date: 2026-06-18
Scope: read-only inventory for Wave 1 noun/route spine. Product code was not edited.

## Inputs Read

- `/home/user/code/pdpp/docs/inbox/the owner-feedback-6-18-26.md`
- `/home/user/code/pdpp/openspec/changes/redesign-owner-console-product-experience/design.md`
- `/home/user/code/pdpp/openspec/changes/redesign-owner-console-product-experience/tasks.md`
- `/home/user/code/pdpp/docs/voice-and-framing.md`
- `/home/user/code/pdpp/docs/research/owner-console-slvp-prior-art-index-2026-06-18.md`
- `apps/console/src/app/dashboard/**` route, nav, view, and page files in this worktree.

## 1. Current Owner-Facing Inventory

| Surface | Current route | Owner-facing label / heading / action | Terms present | Evidence |
| --- | --- | --- | --- | --- |
| Global command/nav | `/dashboard/explore` | `Explore` | Explore, records, timeline/activity keywords | `apps/console/src/app/dashboard/lib/actions.ts:25-32` |
| Global command/nav | `/dashboard/search` | `Jump`; placeholder asks for `trace_id, grant_id, run_id` | Trace, Grant, Run, ID | `apps/console/src/app/dashboard/lib/actions.ts:33-41`, `apps/console/src/app/dashboard/components/command-palette.tsx` |
| Global command/nav | `/dashboard/traces` | `Traces`; description says inspect trace timelines/failures | Trace/Traces | `apps/console/src/app/dashboard/lib/actions.ts:43-50` |
| Global command/nav | `/dashboard/grants` | `Grants`; pending approvals quick action | Grant/Grants | `apps/console/src/app/dashboard/lib/actions.ts:52-59`, `apps/console/src/app/dashboard/lib/actions.ts:135-139` |
| Global command/nav | `/dashboard/runs` | `Syncs`; route remains `/runs`; description says collection attempts and schedule health | Syncs, Runs, connector | `apps/console/src/app/dashboard/lib/actions.ts:60-68` |
| Global command/nav | `/dashboard/records` | `Sources`; description says connected data sources, streams, retained records | Sources, records, connections, stream, connector | `apps/console/src/app/dashboard/lib/actions.ts:69-77` |
| Global command/nav | `/dashboard/connect` | `Connect AI apps`; description sends data-source setup back to Sources | Connect, AI apps, read access, Sources | `apps/console/src/app/dashboard/lib/actions.ts:102-109` |
| Global command/nav | `/dashboard/deployment` and `/dashboard/deployment/tokens` | `Deployment`; quick action `Issue owner token` | Token/Tokens, owner, deployment | `apps/console/src/app/dashboard/lib/actions.ts:87-94`, `apps/console/src/app/dashboard/lib/actions.ts:140-146` |
| Sources overview | `/dashboard/records` | `Sources`; empty state says `No sources yet. Add a source` | Sources, source | `apps/console/src/app/dashboard/records/page.tsx:115-124`, `apps/console/src/app/dashboard/records/sources-view.tsx:109-113` |
| Source detail / stream detail | `/dashboard/records/[connector]`, `/dashboard/records/[connector]/[stream]` | Source/stream workbench; links to Explore and record detail | Source, Stream, Records, Connection, deprecated connector ID warning | `apps/console/src/app/dashboard/records/[connector]/page.tsx`, `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` |
| Explore | `/dashboard/explore` | `ExploreCanvas`; record workbench, query, peek, copy/share URL behavior | Explore, Records, connection facet, stream, record ID | `apps/console/src/app/dashboard/explore/page.tsx:61-114`, `apps/console/src/app/dashboard/explore/explore-canvas.tsx:74-80` |
| Syncs | `/dashboard/runs` | File comment: `Syncs - Recordroom reskin of Runs route`; view model still uses run summaries | Syncs, Runs, Run, connector | `apps/console/src/app/dashboard/runs/page.tsx:1-9`, `apps/console/src/app/dashboard/runs/page.tsx:67-96` |
| Traces | `/dashboard/traces` | `TracesHeader`, filters, trace peek | Trace/Traces, grant, reads, provider/connect | `apps/console/src/app/dashboard/traces/page.tsx:1-11`, `apps/console/src/app/dashboard/traces/page.tsx:129-149` |
| Grants | `/dashboard/grants` | `PageHeader title="Grants"` and `Pending approvals` | Grants, Grant package, source filters, client filters | `apps/console/src/app/dashboard/grants/page.tsx:94-119` |
| Grant package | `/dashboard/grants/packages/[packageId]` | `Grant package`, `Revoke` | Grant package, revoke | `apps/console/src/app/dashboard/grants/packages/[packageId]/page.tsx` |
| Connect AI apps | `/dashboard/connect` | Client/MCP setup commands for ChatGPT, Claude, Codex | Connect, client identity, MCP, read access | `apps/console/src/app/dashboard/connect/page.tsx:1-40` |
| Owner-agent access | `/dashboard/deployment/tokens` | `Owner-agent access`; breadcrumb `Tokens`; manual bearers for debugging | Tokens, owner token, bearer, device flow | `apps/console/src/app/dashboard/deployment/tokens/page.tsx:420-444` |
| Schedules | `/dashboard/schedules` | `Schedules`; copy says sync manually from Records page | Schedule, Sync, Records, connection source identity | `apps/console/src/app/dashboard/schedules/page.tsx` |
| Device exporters | `/dashboard/device-exporters` | `Local device exporters` | Device exporter, source-ish evidence layer | `apps/console/src/app/dashboard/device-exporters/page.tsx` |

## 2. Noun Drift And Route Drift Findings

1. `Sources` is the intended owner noun, but the canonical route remains `/dashboard/records`.
   - the owner feedback calls out `/dashboard/record/connection_id` style paths and says route/URL naming forces translation. The design classifies this as R2: noun and route drift.
   - Current nav labels the route `Sources` while preserving `/records`; source detail code still carries connector/connection/record implementation terms.
   - Wave 1 should decide whether `/sources` becomes the clean owner route with `/records` as compatibility redirect, or whether `/records` remains an implementation URL intentionally hidden behind owner labels.

2. `Syncs` is the owner label for `/dashboard/runs`, but run vocabulary still dominates implementation and deep-link semantics.
   - the owner explicitly noted `Dashboard > Runs, named differently in the URL`.
   - The design says Runs/Traces should be evidence layers, not primary owner destinations unless intentionally advanced/debug.
   - Current nav exposes `Syncs` as a primary item at `/runs`, and the page source states it is a reskin of Runs.

3. `Explore`, source stream tables, and record detail overlap without a crisp product contract.
   - the owner feedback: Browse the Stream goes to Explore; source stream and parent source show mostly the same detail; current Explore copy/controls such as capped windows, "same call client makes", "show current filter", and "pick a record" are not owner-grade.
   - Design maps this to R5 record workbench weakness and says every View records/Explore link must scope through URL state to source, stream, grant, or read subject.
   - Prior-art index requires URL-backed state and full record visibility; bounded samples cannot be terminal answers.

4. Grants, traces, tokens, and packages are over-promoted as artifact nouns before access-review meaning is clear.
   - the owner avoided detailed feedback on grants/traces/deployment but still flagged `Owner`, `Grant`, and problem categories as inconsistent and noted owner token/manual-debug confusion.
   - Design maps this to R6 access/grant ambiguity and R7 evidence-layer overload.
   - Current nav exposes `Grants`, `Traces`, `Deployment`, `Connect AI apps`, and owner-token quick actions as top-level or command-palette surfaces.

5. `Connection` remains a leaky internal/API noun.
   - the owner feedback mentions deprecated alias / connector instance ID warnings and route examples with `connection_id`.
   - Voice guide says owner/operator/docs must avoid confusing protocol, reference implementation, and internal/debug terms.
   - Current route params and data APIs still use `connector`, `connection`, and `source_id`; Wave 1 needs an explicit owner/internal mapping, not a string-by-string rename.

## 3. Concrete Wave 1 Acceptance Checks

- Route/noun map exists and names one owner noun for configured data-producing instances: `Source`. It includes internal mappings for `connection`, `connector`, `connector instance`, `record`, `stream`, `run`, `sync`, `trace`, `grant`, `read/disclosure`, `token`, `device`, `credential`, and `schedule`.
- Global nav, command palette, page breadcrumbs, h1/PageHeader titles, primary CTAs, and empty states use the map consistently. Grep acceptance: owner-facing copy has no unqualified `Connection`, `Connector instance ID`, raw IDs, `Run`, `Trace`, or `Token` outside approved advanced/debug contexts.
- Route hygiene decision is recorded before implementation: clean owner routes, compatibility redirects, and whether `/dashboard` remains an implementation prefix. At minimum, `/records` vs `/sources` and `/runs` vs `/syncs` are decided together.
- `Runs/Syncs`, `Traces`, `Device exporters`, and `Owner tokens` have an explicit disposition: primary route, subject-scoped evidence layer, or advanced/debug route. No implementation worker may remove the current Runs/Syncs value until the owner mock preserves the per-run stream collection facts the owner valued.
- Every `View records`, `Browse stream`, `Explore`, `Review`, `Reauthorize`, trace link, and token action declares its subject and destination state. Acceptance: from a source stream, owner lands in Explore with source/stream filters represented in URL state and can share/copy that URL.
- Every bounded list or sample copy has a full-set path. Acceptance: no owner-facing record surface ends at an artificial cap such as "32 view window, capped" or six-row preview without pagination, virtualization, or "show all/view all" path.
- Counts have basis labels and drill-through. Acceptance: source count, stream count, latest-run yield, page/window count, grant package count, read count, credential/token count, and attention count each state what is counted and link to counted subjects.
- Vocabulary-boundary review is required for the Wave 1 diff. Acceptance artifact: `tmp/workstreams/<tranche>-vocabulary-boundary-<date>.md` cites owner-visible strings and explains why any protocol/debug terms remain.

## 4. Risky Decisions Needing Owner Mock Before Implementation

- Whether `/dashboard/records` should become `/dashboard/sources` or remain a labeled route with redirects. This affects shareable URLs, docs, screenshots, and operator muscle memory.
- Whether `/dashboard/runs` remains as `Syncs`, becomes source-scoped evidence only, or keeps a secondary advanced route. the owner valued cadence/next/collected facts, so deletion by fiat is risky.
- Whether Explore replaces stream tables or only shares renderer/filter state with them. The design notes this is not settled; current stream pages may preserve useful scoped context.
- How to present grants/packages/reads/traces as an access review. A mock should prove an owner can answer "what can ChatGPT read?" and "what did ChatGPT read?" without decoding trace/package mechanics.
- How owner-agent access and manual owner bearers are separated. the owner feedback says the manual/debug bearer area is hard to understand; moving tokens behind advanced/debug needs a mocked owner path for local-agent onboarding.
- How recovery/source status collapses multi-condition failures. the owner feedback on local collector coverage/draining/checking states shows a pure command wall is not enough; owner mock must show cause, one action, progress, and terminal reconciliation.
