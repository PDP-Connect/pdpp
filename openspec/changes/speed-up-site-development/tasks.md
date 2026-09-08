## 1. Command isolation

- [x] 1.1 Give development and verification/build distinct ignored Next and generated-source output directories.
- [x] 1.2 Add an executable configuration check that proves supported commands cannot share output.

## 2. Development qualification

- [x] 2.1 Scope the conservative worker default to production builds.
- [x] 2.2 Measure isolated cold and warm `/` and `/specification` responses under Webpack and Turbopack.
- [x] 2.3 Retain Webpack because Turbopack fails the `/specification` cold-load probe before an edit/reload probe is meaningful.

## 3. Acceptance

- [x] 3.1 Run the configuration check, site typecheck/tests/check, and production build.
- [x] 3.2 Run a live development/build coexistence probe and confirm the development route returns HTTP 200 during build and afterward.
- [ ] 3.3 Run strict OpenSpec CLI validation when the CLI is available. The change was manually checked and final timings and tradeoffs are recorded in `design.md`.

## 4. Compiler graph reduction

- [x] 4.1 Benchmark externalizing the server-only Fumadocs compiler and retain it after repeated cold-route improvement.
- [x] 4.2 Remove the unused Lucide page-tree plugin and verify the rendered specification remains intact.
- [x] 4.3 Benchmark direct Shiki ownership/externalization and reject it after it fails to improve the preceding result.
- [x] 4.4 Verify the retained changes through the full site gate, standalone server, and browser navigation.
