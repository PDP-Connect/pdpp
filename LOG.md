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

## 2026-09-08 — Correlated Next development profiling

- Objective: profile the complete browser-visible cold and warm `/specification` sequence before making another performance change.
- Scope: isolated Webpack CPU profile and warning stack, browser waterfall across specification and manifest compilation, guarded cache-compression A/B if supported by evidence, Turbopack/Satteri requalification, and confirmation of the Mermaid font-request defect.
- Constraint: leave the user's port-3001 server and the unrelated generated `.source/dynamic.ts` hash churn untouched.
- Evidence: the Webpack warning stack originates in Next's HTTP response-compression middleware, not its filesystem cache. Blocking the manifest did not remove the cold specification delay. The official CLI CPU profile captured the wrapper rather than the server and was non-diagnostic.
- Decision: use Turbopack for development with direct/external Satteri and an explicit `.source-dev` alias; keep production builds on Webpack. A clean browser comparison observed roughly 55s Webpack versus 13s Turbopack cold render, with 7.00 MB versus 2.58 MB of scripts and about 1.42 GB versus 639 MB peak process-family memory.
- Proof: `/`, `/specification`, and a nested specification route returned successfully. The compiled graph referenced `.source-dev/dynamic.ts`; a temporary MDX sentence appeared and disappeared through Fast Refresh. The specification retained 29 highlighted blocks and three diagrams in both themes, with no Google Fonts request.
- Remaining: the roughly 11-second HTML-to-paint gap is client-side work dominated by the large document, highlighting, and diagrams. Further gains require a separate decision about deferred rendering or document composition.
- Completion: focused formatting passed; the full site gate passed with 241 tests and the production Webpack build; the standalone specification route returned HTTP 200 in 0.06s. Test-accounting inventory remains deferred because its runner intentionally refuses a dirty worktree.
