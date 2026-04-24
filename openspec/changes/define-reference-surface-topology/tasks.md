## 1. Inventory And Classification

- [ ] 1.1 Inventory all `apps/web/src/app` route families and classify each as protocol docs, reference explainer, live dashboard, sandbox, project planning, or legacy/demo.
- [ ] 1.2 Inventory docs pages under `apps/web/content/docs` and classify pages that are protocol-normative, reference-implementation explanatory, project-history/planning, or mixed.
- [ ] 1.3 Write a short migration table listing the current route, target category, target route, and whether the page should move, be relabeled, or remain.

## 2. Route Topology And Navigation

- [ ] 2.1 Add or update navigation so `/docs`, `/reference`, `/dashboard`, `/sandbox`, and `/openspec` are labeled by artifact category.
- [ ] 2.2 Ensure protocol docs pages do not include live dashboard chrome, live operational state, owner-auth-only CTAs, or copy implying reference behavior is normative protocol behavior.
- [ ] 2.3 Ensure `/dashboard/**` pages use live-instance copy, noindex metadata, dynamic rendering/no static cache for live data, and owner-access gating when configured.
- [ ] 2.4 Decide whether `/openspec/**` remains public in hosted builds; if it remains public, label it as project planning rather than protocol truth.

## 3. Reference Explainer

- [ ] 3.1 Create `/reference` as a public reference-implementation explainer with purpose, non-goals, architecture, trust boundaries, and run/deploy CTAs.
- [ ] 3.2 Add links from `/reference` to GitHub, README, architecture docs, OpenSpec, sandbox, and self-hosted/local dashboard instructions.
- [ ] 3.3 Move or relabel existing reference implementation docs so they are reachable from `/reference` without blurring protocol docs.

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
