## 1. Inventory And Classification

- [x] 1.1 Inventory all `apps/web/src/app` route families and classify each as protocol docs, reference explainer, live dashboard, sandbox, project planning, or legacy/demo. (see `design-notes/route-and-docs-inventory-2026-04-24.md`)
- [x] 1.2 Inventory docs pages under `apps/web/content/docs` and classify pages that are protocol-normative, reference-implementation explanatory, project-history/planning, or mixed. (see `design-notes/route-and-docs-inventory-2026-04-24.md`)
- [x] 1.3 Write a short migration table listing the current route, target category, target route, and whether the page should move, be relabeled, or remain. (see `design-notes/route-and-docs-inventory-2026-04-24.md`)

## 2. Route Topology And Navigation

- [ ] 2.1 Add or update navigation so `/docs`, `/reference`, `/dashboard`, `/sandbox`, and `/openspec` are labeled by artifact category. *(Deferred: nav entries for `/reference` and `/sandbox` will be added by Sections 3 and 5 when those surfaces exist; adding 404 links now would create dead nav. Existing nav already labels `/docs` and `/planning`. `/dashboard` is intentionally not a public nav entry.)*
- [x] 2.2 Ensure protocol docs pages do not include live dashboard chrome, live operational state, owner-auth-only CTAs, or copy implying reference behavior is normative protocol behavior. *(Partial: unambiguous fixes applied — `index.mdx` cards regrouped so protocol and reference are no longer peers, `meta.json` reshelves `spec-change-tracking` and `spec-deferred` into Core Protocol, `spec-dti-alignment` moved to its own "Adjacent Ecosystems" group. Mixed-authority docs `spec-architecture.md` and `spec-connector-ecosystem.md` deferred — they require owner split-vs-relabel decisions tracked in the inventory note.)*
- [x] 2.3 Ensure `/dashboard/**` pages use live-instance copy, noindex metadata, dynamic rendering/no static cache for live data, and owner-access gating when configured. *(Added `robots: noindex/nofollow` via dashboard layout metadata. Owner gating already in place via `isDashboardEnabled()` + `requireDashboardAccess()`. `dynamic = "force-dynamic"` already set per-page.)*
- [x] 2.4 Decide whether `/openspec/**` remains public in hosted builds; if it remains public, label it as project planning rather than protocol truth. *(Owner decision: keep public, labeled as planning. Routes renamed from `app/openspec/**` to `app/planning/**` so source paths match the user-facing URL. Existing planning copy already labels these as project artifacts, not protocol authority.)*

## 3. Reference Explainer

- [x] 3.1 Create `/reference` as a public reference-implementation explainer with purpose, non-goals, architecture, trust boundaries, and run/deploy CTAs.
- [x] 3.2 Add links from `/reference` to GitHub, README, architecture docs, OpenSpec, sandbox, and self-hosted/local dashboard instructions.
- [x] 3.3 Move or relabel existing reference implementation docs so they are reachable from `/reference` without blurring protocol docs.

## 4. Coverage Matrix

- [ ] 4.1 Define the minimum coverage matrix schema: concept/flow, category, specified, documented, implemented, tested, demonstrated, status, evidence links, notes.
- [ ] 4.2 Seed the matrix with major PDPP flows, retrieval extensions, collection/profile flows, reference-only control plane surfaces, and known deferred items.
- [ ] 4.3 Render the matrix publicly from `/reference` or `/reference/coverage`.
- [ ] 4.4 Add tests or static checks that coverage rows have valid evidence links when marked implemented, tested, or demonstrated.

## 5. Sandbox Placeholder

- [ ] 5.1 Create `/sandbox` as a clearly labeled mock-backed pedagogical placeholder if the full sandbox runtime is not built in this change.
- [ ] 5.2 Document the intended sandbox contract: no real credentials, resettable state, seeded data, protocol-flow walkthroughs, and distinct chrome from live dashboard.
- [ ] 5.3 Add CTAs between `/reference`, `/sandbox`, and `/docs` that preserve artifact-category labels.

## 6. Documentation And Validation

- [ ] 6.1 Update README and website copy to describe the route topology and self-hosted/live-dashboard posture.
- [ ] 6.2 Update any pages that currently conflate protocol, reference implementation, and live dashboard language.
- [ ] 6.3 Run `openspec validate define-reference-surface-topology --strict`.
- [ ] 6.4 Run `openspec validate --all --strict`.
- [ ] 6.5 Run relevant web checks after implementation, including typecheck, lint/check, and build.
