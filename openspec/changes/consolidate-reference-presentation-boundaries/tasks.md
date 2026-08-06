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
- [ ] 4.2 Run display, brand-react, and operator-ui verification. Typechecks and tests pass; brand-react's full check remains blocked by the pre-existing `copy-mono.tsx` Biome diagnostic.
- [x] 4.3 Run site and console type checks and targeted tests.
- [x] 4.4 Run site and console production builds.
- [ ] 4.5 Regenerate and verify the Biome exception ledger and test-accounting manifest.
