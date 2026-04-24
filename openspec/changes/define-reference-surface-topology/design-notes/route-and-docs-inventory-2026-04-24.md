# Route and Docs Inventory + Migration Table (2026-04-24)

Status: inventory pass for tasks 1.1–1.3 of `define-reference-surface-topology`.
Implementation of sections 2–6 has not started; this note exists to drive that work.

## Method

- Walked every `page.tsx`, `layout.tsx`, and `route.{ts,tsx}` under `apps/web/src/app/**`.
- Walked every file under `apps/web/content/docs/**`.
- Cross-referenced existing labeling/auth state (`siteNav` in `packages/pdpp-brand/chrome.ts`,
  `dashboard-access.ts`, `lib/openspec/public.ts`).
- Categories used match `proposal.md` and `design.md`: protocol docs (`/docs`), reference explainer (`/reference`),
  live operator dashboard (`/dashboard`), mock sandbox (`/sandbox`), project planning (`/openspec`).
- Recommendation vocabulary per task 1.3:
  - **remain** — keep route + label as-is.
  - **relabel** — keep route, change copy/metadata/chrome to clarify category.
  - **move** — same artifact, new route family.
  - **split** — page mixes categories; needs to be cut into multiple artifacts.
  - **delete** — artifact has no place in the topology.

## 1.1 — Route inventory and classification

### Top-level marketing / landing

| Route | Files | Current category (effective) | Target category | Recommendation | Notes |
|---|---|---|---|---|---|
| `/` | `app/page.tsx` + `components/reference-app.tsx` | mixed: protocol explainer + animated reference-implementation walkthrough | reference explainer | **relabel** | The page is the strongest existing reference-implementation explainer. Top-level home stays here, but framing/CTAs need to make clear this is the reference-implementation story, not normative protocol. The existing "Read the docs" CTA already points at `/docs`; add explicit `/reference` CTA once that page exists. Optionally surface a small "Protocol vs reference" breadcrumb above the hero. |
| `app/layout.tsx` | shared `<html>` chrome | n/a | n/a | **remain** | Root layout is fine; no per-category metadata yet. |

### Protocol docs

| Route | Files | Current category | Target category | Recommendation | Notes |
|---|---|---|---|---|---|
| `/docs` (index) | `content/docs/index.mdx` | mixed: links protocol pages and reference-implementation pages | protocol docs | **relabel** | Index currently lists "Reference Implementation" and "Reference Examples" as docs cards. Once `/reference` exists, the index should stop offering reference-implementation pages as if they were sibling docs; either drop those cards or keep them under a clearly-labeled "Reference implementation" subsection that links to `/reference` for the explainer. |
| `/docs/[[...slug]]` | `app/docs/[[...slug]]/page.tsx` + `app/docs/layout.tsx` | protocol docs | protocol docs | **remain** | Fumadocs sidebar tree comes from `content/docs/meta.json`. Sidebar grouping needs to change (see §1.2) but the route stays. |
| `/llms.txt`, `/llms-full.txt`, `/llms.mdx`, `/llms.mdx/docs/[[...slug]]` | `app/llms*.{txt,mdx}/route.{ts,tsx}` | protocol docs (LLM helpers) | protocol docs | **remain** | These are docs-source-driven generators. They will follow whatever is in `content/docs/`. Reconfirm after docs reshuffle. |

### Live operator dashboard

| Route | Files | Current category | Target category | Recommendation | Notes |
|---|---|---|---|---|---|
| `/dashboard` (overview) | `app/dashboard/page.tsx` | live dashboard | live dashboard | **remain** | Already `dynamic = "force-dynamic"`. Owner-gated through `dashboard-access.ts`; off by default on Vercel unless `PDPP_ENABLE_DASHBOARD=1`. Add `noindex` (see §3 below) and a one-sentence "this is a live reference instance, not a hosted PDPP service" lockup. |
| `/dashboard/grants` | `app/dashboard/grants/page.tsx` | live dashboard | live dashboard | **remain** | Same posture as overview. |
| `/dashboard/grants/[grantId]` | `app/dashboard/grants/[grantId]/page.tsx` | live dashboard | live dashboard | **remain** | |
| `/dashboard/grants/bootstrap` | `app/dashboard/grants/bootstrap/page.tsx` + `actions.ts` | live dashboard (operator setup) | live dashboard | **remain** | Owner-token bootstrap UI; correctly owner-only. |
| `/dashboard/grants/request` | `app/dashboard/grants/request/page.tsx` + `actions.ts` | live dashboard (operator setup) | live dashboard | **remain** | |
| `/dashboard/records` | `app/dashboard/records/page.tsx` | live dashboard | live dashboard | **remain** | |
| `/dashboard/records/timeline` | `app/dashboard/records/timeline/page.tsx` | live dashboard | live dashboard | **remain** | |
| `/dashboard/records/[connector]` | `app/dashboard/records/[connector]/page.tsx` | live dashboard | live dashboard | **remain** | |
| `/dashboard/runs` and `/dashboard/runs/[runId]` | `app/dashboard/runs/...` | live dashboard | live dashboard | **remain** | |
| `/dashboard/search` | `app/dashboard/search/page.tsx` | live dashboard | live dashboard | **remain** | |
| `/dashboard/traces` and `/dashboard/traces/[traceId]` | `app/dashboard/traces/...` | live dashboard | live dashboard | **remain** | |
| `/dashboard/components/*`, `/dashboard/lib/*` | shared building blocks | n/a | n/a | **remain** | Internal modules. |

### Sandbox (does not exist yet)

| Route | Files | Current category | Target category | Recommendation | Notes |
|---|---|---|---|---|---|
| `/sandbox` | (none) | n/a | mock sandbox | **(create later)** | Not present today. Section 5 of `tasks.md` covers this. Out of scope for the inventory pass; flagged here for completeness. |

### Reference explainer (does not exist yet at `/reference`)

| Route | Files | Current category | Target category | Recommendation | Notes |
|---|---|---|---|---|---|
| `/reference` | (none) | n/a | reference explainer | **(create later)** | Section 3 of `tasks.md`. The closest existing artifacts are `/` (animated walkthrough), `content/docs/reference-implementation.md`, `content/docs/reference-implementation-examples.md`. The explainer needs to stitch those together with non-goals, trust boundaries, run/deploy CTAs, and links to GitHub / OpenSpec / sandbox. |

### Project planning / OpenSpec viewer

The route family is `/openspec/**` in the codebase but everything user-facing is already labeled with `PLANNING_LABEL = "Planning"` and the canonical URL prefix is `/planning` (see `lib/openspec/public.ts` and the `siteNav` entry `{ text: "Planning", link: "/planning" }`).

This is a meaningful existing inconsistency: the **route on disk** is `/openspec/**` but **all link targets** in pages and nav use `/planning/**`. There is no rewrite or middleware in this worktree that maps `/planning/*` -> `/openspec/*`, which means in-app `Link` clicks to `/planning` likely 404 unless a `proxy.ts`/`next.config` rewrite exists elsewhere. Worth confirming before we ship anything that depends on the navigation working.

| Route | Files | Current category | Target category | Recommendation | Notes |
|---|---|---|---|---|---|
| `/openspec` (index) | `app/openspec/page.tsx`, `app/openspec/layout.tsx` | project planning | project planning | **relabel + decide on URL family** | Copy already says "internal project view," distinguishes "Root specs" vs "OpenSpec" authority, and labels everything as planning. Owner decision (already given) is to keep it public. **Open sub-question:** rename the route family from `/openspec/**` to `/planning/**` so URL matches displayed label, or vice versa. Not invented here — flagging for owner. |
| `/openspec/changes` and `/openspec/changes/[change]` | `app/openspec/changes/...` | project planning | project planning | **relabel** | Same as above. |
| `/openspec/specs` and `/openspec/specs/[capability]` | `app/openspec/specs/...` | project planning | project planning | **relabel** | These render OpenSpec-owned capability specs, which the README explicitly says are *not* PDPP protocol specs. Copy on the index already states this; the per-capability page should keep the same disclaimer near the title to prevent deep-linkers from misreading. |
| `/openspec/notes` and `/openspec/notes/[change]` | `app/openspec/notes/...` | project planning | project planning | **remain** | Already correctly labeled. |

### Internal / workbench routes

| Route | Files | Current category | Target category | Recommendation | Notes |
|---|---|---|---|---|---|
| `/design` | `app/design/page.tsx` | design workbench (developer-only) | (excluded) | **relabel + restrict** | Component gallery showing every primitive. README mentions it as "design workbench." It is not protocol, not reference explainer, not live owner state — it is a contributor surface. Recommend either gating with the same `process.env.VERCEL !== "1"` rule used by the dashboard, or adding an explicit "internal contributor surface; not part of the topology" header so it is clearly outside the artifact taxonomy. **Owner decision needed (raise as open question if needed):** is `/design` allowed on hosted builds at all? Default recommendation: hide on Vercel like the dashboard. |
| `/palette` | `app/palette/page.tsx` | design workbench | (excluded) | **relabel + restrict** | Same posture as `/design`. Token color sampler. Not user-facing. |
| `/api/**` | `app/api/{gmail,grant,query,search}/route.ts` | server-side handlers | n/a | **remain** | These are functional API routes (search, query, revoke, gmail). Out of scope for surface labeling, but worth confirming none of them respond with HTML that pretends to be a documentation page. (Spot-checked: all are JSON handlers.) |

### Routes that DO NOT exist that I expected to find (gaps relative to plan)

- No `/reference` family.
- No `/sandbox` family.
- No `/dashboard/deployment` page (the proposal mentions it as something `make-semantic-retrieval-operational` introduces). Since current `apps/web/src/app/dashboard/` does not contain a `deployment/` directory in this worktree, treating it as a future arrival under `/dashboard/` is consistent with the proposal.

## 1.2 — Docs content inventory and classification

Source: `apps/web/content/docs/*.md{,x}`. Sidebar grouping comes from `content/docs/meta.json`, which already groups pages under section dividers. Today's groupings (`---Core Protocol---`, `---Collection Profile---`, `---Design Notes---`, `---Reference Implementation---`) are *almost* right; the issues are page-level.

| File | Sidebar group today | Front-matter framing | Effective category | Target category | Recommendation | Notes |
|---|---|---|---|---|---|---|
| `index.mdx` | (root) | "Protocol documentation, reference implementation, and design system guidance in one place." | mixed | protocol docs | **relabel** | Cards section currently advertises `/docs/reference-implementation`, `/docs/reference-implementation-examples`, and "Interactive Reference -> /". Once `/reference` exists, these should point there (or stay but be placed under a clearly-labeled "Reference implementation" sub-block, not as peers of "Core Protocol"). Drop or rephrase the "Documentation Surfaces" framing so it does not equate protocol with reference UI. |
| `spec-architecture.md` ("Overview") | Core Protocol | "How the current PDPP reference components relate" — explicitly says "current reference topology, not a single mandatory deployment shape" | mixed: protocol-architecture vs reference-architecture | protocol docs (with caveat) | **split** (recommended) or **relabel** | The page is honest about the boundary inside its own first paragraph, but it is filed under "Core Protocol" with the title "Overview." A reader landing here from a "Read the docs" CTA will treat it as normative architecture. **Preferred option:** split the file: the protocol-level architectural concerns (record model boundary, native vs polyfill identity rule) stay in `/docs` as protocol architecture; the diagram of *which packages exist in this repo today* moves to `/reference` (or `/reference/architecture`). **Fallback:** keep file but rename title to "Reference Architecture" and move it under the "Reference Implementation" sidebar group. |
| `spec-core.md` ("Protocol") | Core Protocol | normative protocol semantics | protocol docs | **remain** | This is the protocol document. No change. |
| `spec-data-query-api.md` | Core Protocol | normative HTTP API | protocol docs | **remain** | No change. |
| `spec-lexical-retrieval-extension.md` | Core Protocol | optional protocol extension | protocol docs | **remain** | No change. |
| `spec-semantic-retrieval-extension.md` | Core Protocol | experimental optional protocol extension | protocol docs | **remain** | No change. The "experimental" disclaimer is load-bearing and stays. |
| `spec-auth-design.md` | Core Protocol | normative auth wire format | protocol docs | **remain** | No change. |
| `spec-collection-profile.md` ("Profile") | Collection Profile | normative collection profile | protocol docs | **remain** | No change. |
| `spec-connector-ecosystem.md` | Collection Profile | mixed: prescriptive runtime guidance + project-internal decision narrative ("Codex gpt-5.4 recommendation (2026-03-30): ...") | mixed | protocol docs (after edits) **or** planning | **split** | The first half ("Browser abstraction decision: Model A vs Model B" through the phased plan) is project planning prose with a model-attribution byline; that does not belong in protocol docs. **Recommendation:** move the decision narrative to a planning note (likely under `openspec/changes/.../design-notes/` for whichever change owns it), and keep a tight prescriptive section in `/docs` describing what connector authors actually need to know. If splitting is too costly, fallback is to **relabel** the page title to "Connector ecosystem (project notes)" and pull it out of the "Collection Profile" sidebar group entirely, into a new "Project notes" group with a clear-authority disclaimer. |
| `spec-change-tracking.md` | Design Notes | "Decision: ... grant-relative incremental sync" — decision-flavored but framing is normative for the protocol surface (cursor semantics, append-only vs mutable handling) | protocol docs | **relabel** (move sidebar group) | Substance is protocol-normative (it tells implementers what `changes_since` does). Filing it under "Design Notes" understates its authority. Move under "Core Protocol" group, or create a "Design decisions (protocol-normative)" subgroup. Filename and slug can stay. |
| `spec-dti-alignment.md` | Design Notes | strategic positioning vs DTI | planning / strategy | planning | **move** | This is project strategy / external-positioning material. It does not describe what the protocol does; it describes how PDPP relates to another organization's roadmap and what to pitch to whom. Belongs in `/planning` (or in a non-public design-notes folder if owners prefer). Recommend **moving out of `/docs`**: either to a planning surface, or to a top-level docs page explicitly labeled "PDPP and adjacent ecosystems" if there is value in keeping it indexable. Default recommendation: move to planning. |
| `spec-deferred.md` | Design Notes | itemized deferrals from protocol scope; references "v0.1 posture" | mixed: protocol-normative-scope vs planning | protocol docs | **relabel** | Substance ("X is deferred from v0.1") is protocol-relevant — implementers need to know what is intentionally out of scope. Move under the "Core Protocol" sidebar group (perhaps as the last entry titled "Deferred (v0.1)"). Keep page; no split needed; just upgrade its placement so reviewers do not mistake it for back-of-the-bus design notes. |
| `reference-implementation.md` | Reference Implementation | reference-implementation overview | reference explainer | **move** (when `/reference` exists) | This is the closest existing artifact to a `/reference` explainer. Recommendation: when `/reference` is built, host this content (or a version of it) at `/reference/architecture` or as the body of `/reference`. Until then it can **remain** at `/docs/reference-implementation`. Section 3.3 of `tasks.md` covers this directly. |
| `reference-implementation-examples.md` | Reference Implementation | example flows from the reference implementation | reference explainer | **move** (when `/reference` exists) | Same posture as above. Until `/reference` ships, keep here; afterwards the canonical home is `/reference/examples` and `/docs/reference-implementation-examples` either redirects or is removed. |
| `meta.json` | sidebar config | n/a | n/a | **edit** | After the moves/relabels above, remove `reference-implementation*` entries when their content moves to `/reference`. Restructure the "Design Notes" group so it only contains non-protocol-normative material (or eliminate the group). |

## 1.3 — Migration table summary

This is the consolidated checklist that drives sections 2–6. Per-row recommendations live in §1.1 and §1.2.

### Routes (move/relabel/create/restrict)

1. **Create `/reference`** (Section 3 of tasks.md). New top-level explainer; absorbs current `/docs/reference-implementation*` content. Owner-decided URL: `/reference`, not `/docs/reference`.
2. **Create `/sandbox`** placeholder (Section 5). Mock-only, distinct chrome.
3. **`/dashboard/**` already correctly gated** (off by default on Vercel via `PDPP_ENABLE_DASHBOARD`, owner-token-required). Outstanding work for Section 2.3:
   - Add `noindex` metadata (currently no `robots` field on dashboard pages).
   - Confirm `dynamic = "force-dynamic"` on every dashboard page (sampled and confirmed; no audit miss expected, but section 2 should grep).
   - Add a small "this is a live reference instance, not a hosted PDPP service" lockup near the dashboard header (per design.md non-goals).
4. **`/openspec/**` -> `/planning/**` URL alignment**: this is a real inconsistency in the codebase right now (`siteNav` and `planningPath()` link to `/planning/*`, but the route directory is `app/openspec/**`). **Owner decision needed before Section 2.4 work:** rename routes to `/planning/**` to match the user-facing label, or keep routes at `/openspec/**` and update `siteNav`/`planningPath()` accordingly. Either is fine; the current state is broken navigation. Flagged as a stop-and-report point for Section 2 if a rewrite/proxy is not already handling it.
5. **`/design` and `/palette`**: relabel as contributor surfaces and restrict on hosted builds (`process.env.VERCEL !== "1"` like the dashboard). Open question: are these allowed at all in production? Default: hide.
6. **`/` home**: keep as the reference-implementation walkthrough, add a direct `/reference` CTA once that page exists.

### Docs (split/move/relabel)

1. **`spec-architecture.md`**: split protocol-architectural concerns from reference-implementation topology, OR rename and move to "Reference Implementation" sidebar group.
2. **`spec-connector-ecosystem.md`**: split or relabel — first half is planning narrative.
3. **`spec-change-tracking.md`**: move to "Core Protocol" sidebar group (it is protocol-normative).
4. **`spec-dti-alignment.md`**: move out of `/docs` to planning.
5. **`spec-deferred.md`**: move to "Core Protocol" sidebar group.
6. **`reference-implementation.md` and `reference-implementation-examples.md`**: move to `/reference` once it exists.
7. **`index.mdx`**: rewrite cards to drop the `/docs/reference-implementation*` mixing, point reference traffic at `/reference`.
8. **`meta.json`**: rebuild groupings to reflect the above.

## Cross-cutting findings (worth recording, not in tasks.md)

- **`siteNav` only has Docs and Planning today.** Sections 2.1 and 3 will need to extend it (`Reference`, possibly `Sandbox`). The brand package is the single source of truth (`packages/pdpp-brand/chrome.ts`). When extending it, keep the `Dashboard` link off the public marketing nav — its visibility should follow the same `isDashboardEnabled()` logic that gates the route, and it probably belongs as an in-dashboard chrome element only.
- **OpenSpec layout already imports `PLANNING_LABEL`** and presents the surface as project planning. The relabel work for Section 2.1 is mostly done at the index; need to extend the same disclaimer to the per-spec and per-change pages so deep-link readers do not miss it.
- **Docs section divider naming in `meta.json`** is currently "Design Notes" — this group is doing two jobs: protocol-normative deferrals/decisions and project strategy. After §1.2 moves it should either be removed or renamed to something narrower.
- **No noindex anywhere yet.** Neither dashboard nor openspec pages set robots metadata. Whether that matters depends on hosted-deploy posture; the proposal explicitly says dashboard SHALL avoid search-engine indexing (Requirement: "SHALL avoid search-engine indexing"). Section 2.3 will need to add this.

## Coverage matrix data-source policy (per owner direction)

The coverage matrix (Section 4) will be **manually seeded first**, with these properties:

- The matrix is a single TypeScript module exporting a typed array of rows. One source of truth, easy to grep.
- Each row carries the schema in 4.1: `concept/flow`, `category`, `specified`, `documented`, `implemented`, `tested`, `demonstrated`, `status`, `evidence_links[]`, `notes`.
- Status values use the proposal's vocabulary: `specified`, `documented`, `implemented`, `tested`, `demoed`, `deferred`, `not-applicable`.
- A small validation test (per task 4.4) asserts that:
  - Any row marked `implemented`, `tested`, or `demonstrated` carries at least one evidence link.
  - Evidence links resolve: file paths exist on disk; URL paths exist as routes/docs; external URLs are *recorded but not network-checked* in CI to avoid flaky tests.
  - Status field is consistent with the boolean columns (e.g., `implemented = false` cannot coexist with `status = "implemented"`).
- No generator. The matrix is *not* derived from docs frontmatter, route filesystem, or test names. The reason is the same one design.md cites: gaps are the point. A generator that scans the filesystem would either produce false-positive coverage (the file exists, therefore `documented = true`) or require so many manual overrides that the seed approach is simpler.
- The matrix becomes a candidate for partial generation only after the manual schema is stable across at least one full review cycle. Even then, generation should be limited to the cheapest, lowest-judgment columns (e.g., scanning for evidence-link existence on disk), not status itself.

## Open owner questions surfaced by the inventory

These are real questions the inventory uncovered, not invented policy. Section 2 implementation will need answers, or will need to stop-and-report:

1. **`/openspec/**` vs `/planning/**` URL family.** Either rename routes or update `siteNav`/`planningPath()`. Today's nav links go to `/planning/*` while routes live at `/openspec/*` — this is broken without a rewrite. (See §1.1, project-planning row.)
2. **`/design` and `/palette` on hosted builds.** Default recommendation: hide via the same `VERCEL !== "1"` rule as the dashboard. Confirm.
3. **`spec-architecture.md` posture.** Split into protocol-architecture (stays in `/docs`) plus reference-architecture (moves to `/reference`)? Or relabel and reshelve under the reference group? The clean answer is the split; the cheap answer is the reshelve.
4. **`spec-connector-ecosystem.md` posture.** Same shape: split out the project-narrative half, or relabel the whole page as planning-flavored?
5. **Dashboard link on hosted nav.** When `isDashboardEnabled()` is false on a hosted deploy, do we hide the Dashboard nav entry entirely (recommended), show it as disabled, or rely on the route 404? Default: hide.

These are not blockers for finishing Section 1. They are the first decisions needed before Section 2 can begin.

## What this report does NOT do

- Does not implement any of Sections 2–6.
- Does not check off Sections 2–6 in `tasks.md`.
- Does not edit any application code, docs, or `meta.json` content.
- Does not move files yet. The recommendations above are the migration plan; execution belongs to follow-up changes.
