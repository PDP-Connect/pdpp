# OpenSpec explorer execution plan — 2026-04-22

**Status:** canonical execution plan for the first `/openspec` web surface  
**Audience:** owner-directed implementation agent  
**Date:** 2026-04-22

## Purpose

Turn the current decision into one low-decision execution plan for adding a
read-only OpenSpec explorer to the website.

This plan is intentionally narrow:

- render the **official** OpenSpec artifact model only
- place it in the app in a way that fits the existing site IA
- derive the UI from the repository automatically, without manual content
  registration
- keep the layering honest relative to `/docs`, `/dashboard`, root specs,
  code/tests, and OpenSpec

This is not a speculative architecture note. Treat the decisions below as
frozen unless implementation finds a real contradiction with:

- the current app structure
- the current OpenSpec directory shape
- the authority order already recorded in
  `openspec/specs/reference-implementation-governance/spec.md`

## Problem statement

The repository has a real OpenSpec layer:

- `openspec/specs/*/spec.md`
- `openspec/changes/<change>/proposal.md`
- `openspec/changes/<change>/design.md`
- `openspec/changes/<change>/tasks.md`
- `openspec/changes/<change>/specs/**`

But the website does not expose that layer at all. This causes three
problems:

1. the project-governance / change-review layer is invisible from the web
2. reviewers cannot browse active changes and durable architecture notes
   without dropping into the repo or CLI
3. the site currently has no explicit reader-facing surface for the
   authority-order distinction between:
   - root PDPP specs
   - OpenSpec
   - executable code/tests

The goal of this tranche is to fix that cleanly, without inventing new
artifact types or overloading the docs system.

## Frozen decisions

These are **not** open during implementation.

### 1. The new surface lives at `/openspec`

It is a new top-level surface, sibling to `/docs` and `/dashboard`.

Do not:

- put this inside `/dashboard`
- bury it inside the `/docs` Fumadocs tree
- call it `/governance` in this tranche

Reason:

- `/docs` is the curated protocol/spec reading surface
- `/dashboard` is the operator/control-plane surface
- OpenSpec is the project/change-review surface and deserves its own lane

### 2. V1 renders only official OpenSpec artifacts

Render only:

- `openspec/specs/*/spec.md`
- `openspec/changes/*/proposal.md`
- `openspec/changes/*/design.md`
- `openspec/changes/*/tasks.md`
- `openspec/changes/*/specs/**`

Do **not** render in v1:

- `design-notes/`
- scratch notes
- archived inbox memos
- ad hoc repo markdown outside the official OpenSpec structure

If the repo later wants supplemental notes, that is a separate tranche.

### 3. The surface is read-only

This is a browser/viewer, not an editor and not a CLI replacement.

Do not add:

- write actions
- mutation endpoints
- “archive this change” buttons
- inline task toggling
- browser-invoked `openspec` commands

### 4. Use filesystem discovery, not runtime shelling out

The app must derive OpenSpec content by reading the repository on disk.

Do not shell out to `openspec` at request time.

Allowed:

- use `openspec list --json` during local exploration/debugging
- use the filesystem as the application source of truth

Reason:

- less runtime brittleness
- no subprocess dependency in request handling
- easier local and production reasoning

### 5. Keep the component layering honest

Use a three-layer model:

- generic primitives in `apps/web/src/components/ui/*`
- OpenSpec-specific reusable wrappers in
  `apps/web/src/components/openspec/*`
- route composition only in `apps/web/src/app/openspec/*`

Do not put OpenSpec semantics into `components/ui`.

Do not make route files carry large chunks of layout/presentation logic that
belong in reusable wrappers.

### 6. Align visually with `/design`, but do not copy from `/design`

The implementation should use the established design-system tokens and shared
primitives already visible in:

- `apps/web/src/components/ui/*`
- `apps/web/src/components/SiteHeader.tsx`
- the docs-shell visual language

Do not copy sections or ad hoc specimen code from
`apps/web/src/app/design/page.tsx`.

That page is a showcase, not the reusable foundation.

### 7. The IA is change-centric

The new surface must support both `Specs` and `Changes`, but the landing page
should prioritize active changes first.

Reason:

- the repo currently has a small number of capability specs
- the more dynamic and immediately useful review unit is the change

### 8. No first-class “Open Questions” surface in v1

Official OpenSpec does not define a separate open-question artifact type.

So v1 must not invent:

- `/openspec/questions`
- “open question” cards derived from arbitrary markdown heuristics

If later desired, that can be a derived filter or a supplemental-notes
feature.

## Scope

### In scope

- new top-level `/openspec` route family
- automatic discovery of official OpenSpec artifacts
- index pages for `Changes` and `Specs`
- change overview page
- artifact pages for proposal, design, tasks, and spec deltas
- capability-spec pages
- cross-linking between change pages and spec pages
- source links back to the repo
- site-nav integration

### Out of scope

- rendering `design-notes/`
- diff visualization beyond plain rendered delta markdown
- editing or mutating OpenSpec
- search across OpenSpec content
- tags/facets beyond the official structure
- CLI integration beyond structural alignment

## Information architecture

The route tree is frozen as follows:

```text
/openspec
/openspec/specs
/openspec/specs/[capability]
/openspec/changes
/openspec/changes/[change]
/openspec/changes/[change]/proposal
/openspec/changes/[change]/design
/openspec/changes/[change]/tasks
/openspec/changes/[change]/specs
/openspec/changes/[change]/specs/[capability]
```

No alternate route names in this tranche.

### IA behavior by route

#### `/openspec`

Landing page with:

1. short explanation of what OpenSpec is in this repo
2. explicit “authority order” callout
3. active changes section
4. capability specs section

The authority-order callout must communicate:

- root PDPP specs are normative for protocol behavior
- code/tests are authoritative for current implementation behavior
- OpenSpec is the project/change-planning and reference-architecture layer

That language should align with
`openspec/specs/reference-implementation-governance/spec.md`.

#### `/openspec/specs`

List all capability specs from `openspec/specs/*/spec.md`.

Each row/card must show:

- capability name
- title
- short excerpt
- related active changes count
- link to detail page

#### `/openspec/specs/[capability]`

Render the capability spec markdown.

Above the body, show:

- capability name
- title
- source path / GitHub link
- list of related changes that touch the capability

#### `/openspec/changes`

List all discovered changes.

Each change row/card must show:

- change name
- title
- status
- completed tasks / total tasks
- last modified
- affected specs
- short excerpt

Sort order is frozen:

1. `in-progress`
2. `complete`
3. anything else / unknown
4. within each group, most recently modified first

#### `/openspec/changes/[change]`

This is the overview page for one change.

It must show:

- change title
- change name
- status
- task progress
- artifact links to `Proposal`, `Design`, `Tasks`, `Spec Deltas`
- affected specs
- short excerpt from proposal
- short excerpt from design

It must also include a local subnav for:

- Overview
- Proposal
- Design
- Tasks
- Spec Deltas

#### `/openspec/changes/[change]/proposal`
#### `/openspec/changes/[change]/design`
#### `/openspec/changes/[change]/tasks`

Render the underlying markdown directly with consistent markdown styling.

Each page must show:

- breadcrumb back to `/openspec/changes/[change]`
- artifact label
- artifact title
- source path / GitHub link

#### `/openspec/changes/[change]/specs`

List all capability-delta markdown files under the change’s `specs/`
directory.

If none exist, render a deliberate empty state, not a 404.

#### `/openspec/changes/[change]/specs/[capability]`

Render that delta markdown file directly.

## UX and visual direction

### Overall stance

This should feel like a serious reading/review surface, closer to `/docs`
than to `/dashboard`.

Use:

- the existing top header pattern with `SiteHeader`
- docs-adjacent typography and spacing
- restrained cards and rails

Do not:

- make it look like an admin tool
- use dashboard operator chrome
- introduce a second unrelated visual language

### Required visual pieces

Create reusable OpenSpec wrappers under `apps/web/src/components/openspec/`.

Required wrappers:

- `OpenSpecShell`
- `OpenSpecSidebar`
- `OpenSpecSectionCard`
- `OpenSpecArtifactCard`
- `OpenSpecChangeHeader`
- `OpenSpecStatusPill`
- `OpenSpecProgressPill`
- `OpenSpecMarkdownPage`
- `OpenSpecBreadcrumbs`
- `OpenSpecEmptyState`

These wrappers must compose existing `ui` primitives where practical.

### Design-system rule

If a needed primitive is generic, add or adapt it under `components/ui`.

If a needed component is OpenSpec-specific in semantics or defaults, add it
under `components/openspec`.

Only place something under an `experimental` subfolder if the pattern is
clearly provisional and likely to be replaced soon. Do not hide core layout
or card primitives under `experimental`.

## Data model and loader contract

Create a dedicated server-side loader layer:

```text
apps/web/src/lib/openspec/
  index.ts
  filesystem.ts
  parse.ts
  types.ts
```

You may split this slightly differently if needed, but the functional
separation below is fixed.

### `types.ts`

Define explicit types for:

- `OpenSpecArtifactKind`
- `OpenSpecArtifact`
- `OpenSpecSpecSummary`
- `OpenSpecSpecDetail`
- `OpenSpecChangeSummary`
- `OpenSpecChangeDetail`
- `OpenSpecChangeArtifactSummary`
- `OpenSpecLandingSummary`

Minimum required shape:

```ts
type OpenSpecArtifactKind = 'proposal' | 'design' | 'tasks' | 'spec';

type OpenSpecArtifact = {
  kind: OpenSpecArtifactKind;
  title: string;
  markdown: string;
  excerpt: string | null;
  repoRelativePath: string;
  absolutePath: string;
  lastModified: string | null;
};

type OpenSpecSpecSummary = {
  capability: string;
  title: string;
  excerpt: string | null;
  repoRelativePath: string;
  lastModified: string | null;
  relatedChanges: string[];
};

type OpenSpecChangeSummary = {
  name: string;
  title: string;
  status: string;
  completedTasks: number;
  totalTasks: number;
  lastModified: string | null;
  excerpt: string | null;
  affectedCapabilities: string[];
  hasProposal: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
  hasSpecDeltas: boolean;
};
```

Additional fields are allowed if they are clearly useful.

### `filesystem.ts`

Implement repository-root discovery and raw file enumeration.

Required behavior:

1. resolve repo root robustly
2. locate `openspec/specs` and `openspec/changes`
3. enumerate files under the official structure only
4. tolerate missing optional files like `.openspec.yaml`

Implement `resolveRepoRoot()` by walking upward from `process.cwd()` until
you find:

- `pnpm-workspace.yaml`
- `openspec/`

If no repo root is found, throw a descriptive server-side error.

Do not hardcode absolute paths.

### `parse.ts`

Implement lightweight parsing helpers.

Required helpers:

- `extractTitle(markdown, fallback)`
- `extractExcerpt(markdown)`
- `countTasks(markdown)` using task checkboxes in `tasks.md`
- `readYamlHeaderFields(pathToDotOpenspecYaml)` for `schema` and `created`
  if present
- `humanizeName(slug)` as fallback only

Parsing rules:

- title = first markdown H1 if present, else fallback
- excerpt = first non-empty paragraph after the H1 block, excluding pure
  metadata lines like `**Status:**`
- task counts = count `- [x]` and `- [ ]`
- affected capabilities for a change = derived from filenames under
  `changes/<change>/specs/**`

Do not implement a heavy markdown AST pipeline just for indexing.

### `index.ts`

Export the high-level loader API the routes use.

Required exports:

- `getOpenSpecLandingSummary()`
- `listOpenSpecSpecs()`
- `getOpenSpecSpec(capability)`
- `listOpenSpecChanges()`
- `getOpenSpecChange(changeName)`
- `getOpenSpecChangeArtifact(changeName, kind)`
- `listOpenSpecChangeSpecDeltas(changeName)`
- `getOpenSpecChangeSpecDelta(changeName, capability)`

Behavior rules:

- return `null` for missing specific records and let routes call `notFound()`
- sort in the loader, not ad hoc in routes
- keep route code thin

## Runtime and rendering strategy

### Use server components and filesystem reads

All OpenSpec route pages should be server components.

Do not introduce client components unless a small interactive affordance
genuinely requires one.

### Prefer static param generation for detail routes

For:

- `/openspec/specs/[capability]`
- `/openspec/changes/[change]`
- `/openspec/changes/[change]/proposal`
- `/openspec/changes/[change]/design`
- `/openspec/changes/[change]/tasks`
- `/openspec/changes/[change]/specs/[capability]`

implement `generateStaticParams()` from the filesystem loader.

This keeps the site zero-maintenance while letting build output reflect the
current repo state cleanly.

### Do not reuse the Fumadocs source pipeline for OpenSpec content

Do not add OpenSpec files to:

- `apps/web/content/docs`
- `apps/web/source.config.ts`
- the existing Fumadocs docs tree

Reason:

- OpenSpec has a different artifact model
- forcing it into Fumadocs content registration would either need manual
  registration or awkward synthetic metadata

Use a custom OpenSpec loader with custom pages instead.

### Markdown rendering

Add explicit dependencies if needed to render raw markdown nicely.

Preferred approach for v1:

- add `react-markdown`
- add `remark-gfm`

Render markdown through a reusable `OpenSpecMarkdownPage` wrapper.

Do not render markdown as raw HTML.

Do not build a custom markdown parser from scratch.

## File-by-file execution map

This is the expected touch set.

### Must modify

- `apps/web/package.json`
  - add `react-markdown`
  - add `remark-gfm`
- `packages/pdpp-brand/chrome.js`
  - add `{ text: 'OpenSpec', link: '/openspec' }`

### Must add

- `apps/web/src/lib/openspec/types.ts`
- `apps/web/src/lib/openspec/filesystem.ts`
- `apps/web/src/lib/openspec/parse.ts`
- `apps/web/src/lib/openspec/index.ts`

- `apps/web/src/components/openspec/OpenSpecShell.tsx`
- `apps/web/src/components/openspec/OpenSpecSidebar.tsx`
- `apps/web/src/components/openspec/OpenSpecSectionCard.tsx`
- `apps/web/src/components/openspec/OpenSpecArtifactCard.tsx`
- `apps/web/src/components/openspec/OpenSpecChangeHeader.tsx`
- `apps/web/src/components/openspec/OpenSpecStatusPill.tsx`
- `apps/web/src/components/openspec/OpenSpecProgressPill.tsx`
- `apps/web/src/components/openspec/OpenSpecMarkdownPage.tsx`
- `apps/web/src/components/openspec/OpenSpecBreadcrumbs.tsx`
- `apps/web/src/components/openspec/OpenSpecEmptyState.tsx`
- `apps/web/src/components/openspec/index.ts`

- `apps/web/src/app/openspec/layout.tsx`
- `apps/web/src/app/openspec/page.tsx`
- `apps/web/src/app/openspec/specs/page.tsx`
- `apps/web/src/app/openspec/specs/[capability]/page.tsx`
- `apps/web/src/app/openspec/changes/page.tsx`
- `apps/web/src/app/openspec/changes/[change]/page.tsx`
- `apps/web/src/app/openspec/changes/[change]/proposal/page.tsx`
- `apps/web/src/app/openspec/changes/[change]/design/page.tsx`
- `apps/web/src/app/openspec/changes/[change]/tasks/page.tsx`
- `apps/web/src/app/openspec/changes/[change]/specs/page.tsx`
- `apps/web/src/app/openspec/changes/[change]/specs/[capability]/page.tsx`

### Allowed additions if implementation needs them

- `apps/web/src/components/openspec/experimental/*`
- one small utility under `apps/web/src/lib/` if it is generic beyond
  OpenSpec

### Do not modify in this tranche

- `apps/web/content/docs/*`
- `apps/web/source.config.ts`
- dashboard routes/components
- reference implementation server/runtime code

## Required page behavior details

### Header and shell

`apps/web/src/app/openspec/layout.tsx` must:

- use `SiteHeader currentLabel="OpenSpec"`
- use a custom shell, not the dashboard shell
- provide a left rail / top rail that supports:
  - Overview
  - Specs
  - Changes

When inside a change route, the shell must also show the local artifact nav:

- Overview
- Proposal
- Design
- Tasks
- Spec Deltas

### Breadcrumbs

Use breadcrumbs on detail pages.

Required patterns:

- spec page:
  - `OpenSpec / Specs / <capability>`
- change overview:
  - `OpenSpec / Changes / <change>`
- change artifact:
  - `OpenSpec / Changes / <change> / Proposal`
  - etc.

### Source links

Every detail page must show a source link back to the repo path.

The page should display the repo-relative path in text and provide a GitHub
link in the same style as the docs pages do for `/docs`.

### Empty states

Use deliberate empty states for:

- no spec deltas under a change
- no active changes on the landing page
- no specs (unlikely, but do not crash)

Do not use empty states for missing routes that should not exist; use 404 via
`notFound()`.

### Title derivation

Use these fallback rules:

1. H1 from the markdown file
2. humanized artifact/change/spec name

Do not leave titles blank.

## Implementation order

Execute in this exact order.

### Phase 1: data layer

1. add `apps/web/src/lib/openspec/types.ts`
2. add `filesystem.ts` with repo-root resolution and file reads
3. add `parse.ts` with title/excerpt/task-count helpers
4. add `index.ts` with the public loader API
5. manually inspect loader output from current repo structure before touching
   route code

Stop if:

- repo-root resolution is unreliable
- the current OpenSpec folder structure differs materially from this plan

### Phase 2: component layer

1. add `components/openspec/*`
2. keep them server-safe by default
3. wire them to existing `ui` primitives
4. ensure no OpenSpec semantics leak into `components/ui`

Do not build routes before the wrappers exist.

### Phase 3: route skeleton

1. add `app/openspec/layout.tsx`
2. add `/openspec`
3. add `/openspec/changes`
4. add `/openspec/specs`

Verify these index pages render correctly before adding detail pages.

### Phase 4: detail routes

Add detail routes in this order:

1. `/openspec/changes/[change]`
2. `/openspec/changes/[change]/proposal`
3. `/openspec/changes/[change]/design`
4. `/openspec/changes/[change]/tasks`
5. `/openspec/changes/[change]/specs`
6. `/openspec/changes/[change]/specs/[capability]`
7. `/openspec/specs/[capability]`

### Phase 5: nav and polish

1. add `OpenSpec` to site nav
2. verify source links
3. verify breadcrumbs
4. verify sort order and progress pills
5. verify empty states

## Acceptance criteria

The tranche is complete only if all of the following are true.

### IA and routes

- `/openspec` exists and explains the layer correctly
- `/openspec/specs` lists capability specs automatically
- `/openspec/changes` lists changes automatically
- change overview and artifact pages work for all current changes
- spec pages work for all current capability specs

### Automation / no manual maintenance

- adding a new official change folder under `openspec/changes/` makes it
  appear in the UI without editing app config
- adding a new capability spec under `openspec/specs/` makes it appear in the
  UI without editing app config
- changing task checkboxes in `tasks.md` updates the displayed progress after
  rerender/build

### Boundaries

- the feature does not render `design-notes/`
- the feature does not shell out to the OpenSpec CLI at request time
- the feature does not modify the `/docs` content pipeline
- the feature does not invent a browser mutation surface

### Visual / design-system consistency

- the new surface feels visually aligned with the site
- the implementation uses `components/ui` for generic primitives
- OpenSpec-specific patterns live under `components/openspec`

## Validation sequence

The implementation agent must run these checks before reporting completion.

### Required commands

1. `pnpm --dir apps/web types:check`
2. `pnpm --dir apps/web build`

### Required manual smoke checks

Run the app locally and verify these routes:

1. `/openspec`
2. `/openspec/changes`
3. `/openspec/changes/reference-implementation-program`
4. `/openspec/changes/reference-implementation-program/proposal`
5. `/openspec/changes/reference-implementation-program/design`
6. `/openspec/changes/reference-implementation-program/tasks`
7. `/openspec/specs`
8. `/openspec/specs/reference-implementation-governance`

Also verify:

- site nav includes `OpenSpec`
- change progress matches `tasks.md`
- affected capabilities are accurate
- missing change-spec-delta pages 404 correctly

### Required grep/readback hygiene

Before reporting done:

1. grep for `OpenSpec` route/component names to verify naming consistency
2. read every new `components/openspec/*` file
3. read every new `app/openspec/*` page file
4. verify no route names drifted from the frozen IA above

## Explicit non-decisions

The implementation agent must not reopen these questions during this tranche:

- whether OpenSpec should live under `/docs`
- whether `design-notes/` should render too
- whether the app should use OpenSpec CLI as the runtime backend
- whether to add an “Open Questions” page
- whether to rename the surface to `/governance`
- whether to merge this with `/dashboard`

If implementation pressure suggests one of those changes, stop and escalate
instead of improvising.

## Suggested future follow-ups

Not part of this tranche, but reasonable later:

- render supplemental `design-notes/` as a clearly labeled second layer
- add search across OpenSpec content
- add richer change/spec relationship views
- add archived-change browsing if the repo starts using archive heavily

## Success condition

At the end of this tranche, a reviewer who knows nothing about the repo
should be able to:

1. click `OpenSpec` in the top nav
2. understand what layer OpenSpec occupies in this project
3. browse active changes and current capability specs
4. open proposal/design/tasks/spec-delta artifacts directly in the app
5. trust that the site is showing the real official OpenSpec structure rather
   than a hand-curated markdown dump
