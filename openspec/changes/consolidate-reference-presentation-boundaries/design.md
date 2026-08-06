## Context

The two web deployables share presentation behavior but currently reach it through several accidental boundaries. Framework-independent record and identity rules live under React-oriented packages. Brand tokens, application prose, route-specific stream CSS, and component CSS are mixed in global stylesheets. Theme state is implemented separately in each application.

## Decision

Use four explicit ownership layers:

1. `@pdpp/display` owns framework-independent presentation policy and has no React, Next.js, or CSS dependency.
2. `@pdpp/brand` owns shared tokens, typography, utilities, fonts, and stylesheet composition.
3. `@pdpp/brand-react` and `@pdpp/operator-ui` own React components and their component-specific CSS.
4. Each application owns CSS and navigation that are specific to that deployable or route.

Both applications consume the theme provider exported by `@pdpp/operator-ui`. `next-themes` owns client preference and system-theme synchronization; the applications own only layout wiring and their theme controls.

Generated and policy artifacts are regenerated from the composed source tree rather than hand-merged across slices.

## Alternatives

- Keeping formatting helpers inside `@pdpp/operator-ui` preserves a React-oriented dependency for non-React consumers.
- Keeping all CSS in application globals hides ownership and makes route/component changes modify unrelated surfaces.
- Maintaining two custom theme runtimes preserves duplicated persistence and hydration behavior.
- Creating one package for logic, CSS, and React components would replace the current tangling with a larger undifferentiated boundary.

## Scope

In scope: package ownership, imports/exports, shared styling, theme runtime, component CSS, app-owned CSS, tests, manifests, and generated policy artifacts.

Out of scope: protocol behavior, owner-console information architecture, public-site content strategy, and visual redesign beyond preserving the current approved presentation.

## Acceptance checks

- OpenSpec validates strictly.
- Package type checks and tests pass for display, brand-react, and operator-ui.
- Site and console type checks and targeted runtime tests pass.
- Site and console production builds complete.
- Public-site and console theme behavior remains usable in light, dark, and system modes.
