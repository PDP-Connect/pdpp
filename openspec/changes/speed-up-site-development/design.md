## Context

The public site currently forces Webpack for development and production and applies `experimental.cpus: 1` in both environments. Fumadocs dynamic mode avoids eagerly compiling every MDX body, but the first `/specification` request still compiles a large route graph and then compiles Core and Governance at runtime. The observed cold request spent 146.8 seconds in route compilation and 19.9 seconds in the first MDX generation.

The immediate incident was compounded by `next dev` and `next build` sharing `apps/site/.next`. A production build ran for 161 seconds while the development server was active; subsequent warm requests stopped returning.

## Decisions

### Separate runtime output by command role

Development uses `.next-dev` and `.source-dev`. Verification uses `.next-verify` and `.source-verify`; direct production builds retain `.next` and `.source`. The paired site-owned environment variables prevent Next manifests/caches and generated Fumadocs modules from being rewritten across command roles.

### Scope worker stability to production

The one-worker default exists to prevent native production-build crashes. Development does not inherit that default. An explicit `PDPP_WEB_BUILD_WORKERS` override remains available for intentional comparison and CI control.

### Qualify the current development bundler empirically

Webpack is the baseline. Turbopack is adopted for `site:dev` only when an isolated cold run on Next 16.3.3:

- serves `/` and `/specification` successfully;
- survives an edit and recompiles the changed route;
- does not reproduce the prior async-hook leak or native crash;
- materially improves the cold `/specification` response.

Production builds remain on Webpack. Requalifying production Turbopack is outside this change.

## Qualification results

- Webpack, isolated cold `/specification`: 46.8 seconds, HTTP 200. A prior cold run before this change took 164.5 seconds; cache and host state make cold timings variable, so this is evidence rather than a guaranteed speedup.
- Webpack, after verification: 1.7 seconds, HTTP 200.
- Turbopack cold `/`: 7.2 seconds, HTTP 200.
- Turbopack cold `/specification`: 7.1 seconds, HTTP 500. It cannot resolve Satteri's runtime-computed `@bruits/satteri-wasm32-wasi` binding path. Turbopack is therefore rejected and Webpack remains the supported development bundler.
- During the production-build phase of verification, the already compiled Webpack `/specification` route returned HTTP 200 in 21.3 seconds. Verification still creates severe CPU/I/O contention: an earlier request during its type/test phase exceeded a 30-second timeout. Isolation prevents state corruption; it does not make two expensive compilers cheap to run together.

## Compiler graph experiments

Experiments used one Webpack server at a time with fresh, uniquely named Next and Fumadocs output directories. Because host and filesystem caches remain variable, timings are directional rather than statistically controlled.

- Baseline repeat: 61.5 seconds cold, 2.4 seconds warm.
- Externalize `fumadocs-mdx`: 28.0 and 51.2 seconds cold across two runs, 1.0 and 1.2 seconds warm. Retained because both cold observations beat the adjacent 46.8–61.5-second baseline range, while acknowledging substantial host variance.
- Remove `lucideIconsPlugin`: 21.9 seconds cold and 1.0 second warm on top of compiler externalization. Retained because no document icon metadata exists and the route content remained intact; its individual timing contribution is not isolated by this combined run.
- Add direct `shiki@4.4.3` and explicitly externalize it: 24.9 seconds cold and 1.1 seconds warm. Rejected because it demonstrated no benefit and would add unnecessary direct dependency ownership; the dependency and lockfile changes were removed.

The retained configuration passed the full 240-test site verification and production build. The actual standalone server returned `/specification` in 0.05 seconds with Core, Governance, and highlighted-code markers present, proving the built output still works rather than a production speedup. A browser navigation confirmed the rendered title and 29 code blocks.

## Alternatives

- Keeping one `.next` directory is rejected because concurrent supported commands can corrupt each other's state.
- Removing Fumadocs dynamic mode is rejected because the repository records eager compilation exhausting the Node heap.
- Reworking Shiki, Mermaid, or document composition is deferred until the isolated bundler/worker measurements show the remaining cost.

## Acceptance checks

- A live development server returns HTTP 200 during the production-build phase of `pnpm --dir apps/site verify` and remains usable afterward.
- The development server and build command report distinct output directories.
- Development configuration does not default to `experimental.cpus: 1`; production builds still do.
- Cold and warm timings for `/` and `/specification` are recorded for Webpack and Turbopack.
- The selected development bundler passes an edit/reload probe.
