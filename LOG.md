# Worklog

## 2026-09-08 — Specification development latency

- Objective: isolate site build output from the live dev server, remove production-only worker constraints from development, and requalify Turbopack on Next 16.3.3.
- Evidence: a cold `/specification` request took 164.5 seconds; 146.8 seconds was route compilation and the first dynamic MDX load added 19.9 seconds. A concurrent `next build` and `next dev` also wrote the same `.next` directory and left the dev server unresponsive.
- Decision: development and verification use separate Next and Fumadocs output trees. The one-worker default applies only to production. Webpack remains the supported dev bundler because Turbopack returns HTTP 500 on `/specification` when resolving Satteri's computed WASI binding.
- Evidence: isolated Webpack `/specification` returned HTTP 200 cold in 46.8s and after verification in 1.7s. During the production-build phase it remained available (HTTP 200 in 21.3s), although verification still causes heavy machine contention. The full site verification passed: 240 tests, Ultracite/generated-artifact checks, typecheck, and production build.
- Unresolved: strict OpenSpec CLI validation is unavailable because the CLI is not installed. Test-accounting inventory also refuses to run in a dirty worktree by policy; the new test is covered by the existing `apps/site/scripts/*.test.ts` manifest glob.
- Next: review and commit this recorded change; a separate performance change should reduce the specification route's Shiki/Mermaid/Fumadocs graph rather than weakening build stability.

## 2026-09-08 — Specification compiler graph experiments

- Objective: execute Astra's ranked compiler externalization, unused Lucide, and direct Shiki experiments with isolated cold caches.
- Decision: retain `fumadocs-mdx` server externalization and remove the unused `lucideIconsPlugin`; reject and remove the direct Shiki dependency/externalization because it demonstrated no benefit and would add unnecessary ownership.
- Evidence: repeated baseline was 61.5s cold. Fumadocs externalization measured 28.0s and 51.2s cold; removing Lucide then measured 21.9s. Direct Shiki measured 24.9s. All successful routes contained Core and Governance; highlighted code remained present.
- Completion: full site verification passed (240 tests, checks, and production build). The standalone route returned HTTP 200 in 0.05s with expected content/highlighting, proving deploy viability rather than production performance; browser navigation rendered the specification with 29 code blocks.
- Caveat: host/filesystem cache variance is high; the measurements establish useful direction, not a guaranteed latency percentage.
