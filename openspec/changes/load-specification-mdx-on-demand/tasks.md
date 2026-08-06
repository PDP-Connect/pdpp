## 1. Record the loading boundary

- [x] 1.1 Add a `reference-surface-topology` requirement for on-demand specification document bodies.
- [x] 1.2 Record the dependency and generated-artifact ownership.

## 2. Implement dynamic specification loading

- [x] 2.1 Enable dynamic mode in the Fumadocs source configuration and regenerate `.source` artifacts.
- [x] 2.2 Load the selected page body and table of contents through the dynamic page loader.
- [x] 2.3 Add `@fumadocs/mdx-remote` to the site dependency graph.

## 3. Acceptance checks

- [x] 3.1 Run `openspec validate load-specification-mdx-on-demand --strict`.
- [x] 3.2 Run the site type check and test suite.
- [x] 3.3 Run the production site build.
- [x] 3.4 Verify `/specification` and one nested specification route in a browser.
