## 1. Establish presentation ownership

- [x] 1.1 Add `@pdpp/display` and move framework-independent identity, record, and timestamp policy into it.
- [x] 1.2 Update consumers and remove the superseded operator-ui and brand helper modules.
- [x] 1.3 Add direct package tests and test-accounting ownership for the new boundary.

## 2. Establish stylesheet ownership

- [x] 2.1 Layer `@pdpp/brand` into tokens, typography, utilities, components, and composed entrypoints.
- [x] 2.2 Move site editorial/docs CSS and console Ink Carbon CSS to their application owners.
- [x] 2.3 Co-locate operator-ui component CSS and register the Node test CSS loader.
- [x] 2.4 Keep public-site navigation in the public-site deployable.

## 3. Consolidate theme runtime

- [x] 3.1 Replace the application-local providers with the shared operator-ui provider.
- [x] 3.2 Wire shared fonts and theme state through both application layouts.
- [x] 3.3 Update theme and reduced-motion invariants.

## 4. Acceptance checks

- [x] 4.1 Validate this OpenSpec change strictly.
- [x] 4.2 Run display, brand-react, and operator-ui verification. Typechecks, lint, and tests pass. The `copy-mono.tsx`
  `noUnnecessaryConditions` diagnostic is resolved by initialising the timeout ref to `undefined` and dropping the guard
  (`clearTimeout(undefined)` is a spec no-op), so no waiver is needed.
- [x] 4.3 Run site and console type checks and targeted tests.
- [x] 4.4 Run site and console production builds.
- [ ] 4.5 Regenerate and verify the Biome exception ledger and test-accounting manifest. Deferred: `pnpm biome:policy`
  already drifts on an unmodified tree, and regenerating sweeps ~600 lines of unrelated console drift into this change.
  Both accounting gates also require a clean worktree. Owns its own follow-up change.

## 5. Complete public-site presentation ownership

- [x] 5.1 Keep the root site layout limited to document metadata, fonts, providers, and `styles/site.css`.
- [x] 5.2 Add a concept route group whose layout owns the shared concept shell, masthead, and footer for `/`, `/self-host`,
  and `/participate`.
- [x] 5.3 Keep `/specification` in its own layout, with a specification-owned surface that reuses the shared site chrome.
- [x] 5.4 Keep an explicit root 404 that composes the concept shell and shared chrome.
- [x] 5.5 Move site CSS into `styles/site.css`, `styles/surfaces/concept/{index.css,components.css,tokens/**}`, and
  `styles/surfaces/specification.css`; move ProsePage rules to `components/docs/prose-page.css` and import them from
  `ProsePage`.
- [x] 5.6 Verify the site type check and production build, then inspect `/`, `/self-host`, `/participate`, `/specification`,
  and an unmatched route in light and dark modes. Preserve current visual behavior except for structurally consistent
  footer and chrome. Site typecheck, production build (54 routes), `check`, and 193 tests pass; console typecheck and
  build pass. The operator-ui `next-themes` children error is fixed by hoisting `@types/react`/`@types/react-dom` to the
  workspace root (`pnpm-workspace.yaml` `publicHoistPattern`) — React ships no types of its own, so a dependency's
  `import * as React from "react"` could not reach them from its isolated pnpm store directory, degrading
  `ThemeProviderProps extends React.PropsWithChildren` to `{}`. `/self-host/coverage` still carries its pre-existing
  stale `.js` evidence paths from the reference implementation's TypeScript migration — unrelated to this change.

## 6. Establish shared text presentation

- [x] 6.1 Add the theme-aware `@pdpp/brand-react` `Text` primitive and package-owned component CSS, with focused SSR tests
  for semantic size, inherited tone, polymorphic markup, native props, and caller overrides.
- [x] 6.2 Render the site concept `Text` facade through the shared primitive's unstyled mode while preserving all
  concept-owned classes, content formatting, truncation, section-index markup, and native props.
- [x] 6.3 Verify the brand-react package, focused site Text behavior, site type integration, and unchanged rendered concept
  typography in light and dark themes. Package typecheck, lint, and 43 package tests pass; site type integration and the
  full 193-test site suite pass. `concept/index.css`'s `@reference "@pdpp/brand/styles.css"` resolves `@apply font-serif`
  without re-emitting brand, so the concept surface compiles in the production build.
