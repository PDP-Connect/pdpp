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

### Shared text presentation

`@pdpp/brand-react` owns one polymorphic `Text` primitive and the whole variant table behind it: the type size ladder,
typographic colour roles, the polymorphic host element, icon-aware truncation, optical sizing, section indices and
smart-quote formatting. Element semantics remain explicit at the call site; a visual `display` size does not infer `h1`
markup.

The split is table versus values, not mechanics versus policy. The shared table emits only role-named Tailwind
utilities — `text-foreground`, `text-muted-foreground`, `text-primary`, `text-body`, `text-display` — and contains no palette word.
Each surface rebinds the brand CSS variables: the concept surface maps `--foreground`/`--primary` onto editorial ink/teal,
console maps it onto its own foreground scale. Theming is therefore CSS-only; no provider, runtime binding object,
class-map factory or consumer-owned `cn` crosses the boundary. Caller `className` still overrides through the utility
layer.

An earlier revision of this decision put only the wrapper in the package and left the variant table in `apps/site`. That
inverted the value: the shared artifact was a host element with two data attributes and a single consumer, while every
decision worth reusing stayed application-local. The boundary is drawn at values instead.

Surfaces wrap the primitive only to pin their own defaults. The concept facade sets `smartQuotes` and its `data-slot` and
adds nothing else; a variant that every React surface would want belongs in the package, and a literal palette name in
the shared table would make one surface's palette the accidental global contract.

### Public-site ownership

`apps/site` completes the application-owned layer with explicit shells and stylesheet entrypoints:

- The root layout owns only the HTML document, shared fonts, metadata, providers, and the site stylesheet entrypoint.
- The concept route group owns the shared concept shell and chrome for `/`, `/self-host`, and `/participate`. Route content composes inside that shell rather than mounting the masthead and footer independently.
- The specification layout owns the Fumadocs shell and specification surface. It reuses the same site chrome contract without placing the specification route inside the concept route group.
- The root `not-found` route is explicit and composes the concept shell so unmatched routes retain intentional site presentation.
- `styles/site.css` composes site-wide dependencies. Concept styling lives under
  `styles/surfaces/concept/` as `index.css`, `components.css`, and `tokens/**`; specification shell styling lives in
  `styles/surfaces/specification.css`.
- `components/docs/prose-page.css` is imported by `ProsePage` and owns only that component's rendered Markdown rules.

This is an ownership refactor. Existing visual behavior remains the acceptance baseline except that shared footer and chrome
become structurally consistent across the concept routes, specification, and root 404.

## Alternatives

- Keeping formatting helpers inside `@pdpp/operator-ui` preserves a React-oriented dependency for non-React consumers.
- Keeping all CSS in application globals hides ownership and makes route/component changes modify unrelated surfaces.
- Maintaining two custom theme runtimes preserves duplicated persistence and hydration behavior.
- Creating one package for logic, CSS, and React components would replace the current tangling with a larger undifferentiated boundary.
- Exporting a text factory with theme class maps and an injected class merger would duplicate the CSS theme source in
  JavaScript and make consumers understand Tailwind scanning and merge configuration.

## Scope

In scope: package ownership, imports/exports, shared styling, theme runtime, component CSS, app-owned route shells and CSS,
tests, manifests, and generated policy artifacts.

Out of scope: protocol behavior, owner-console information architecture, public-site content strategy, and visual redesign beyond preserving the current approved presentation.

## Acceptance checks

- OpenSpec validates strictly.
- Package type checks and tests pass for display, brand-react, and operator-ui.
- Site and console type checks and targeted runtime tests pass.
- Site and console production builds complete.
- Public-site and console theme behavior remains usable in light, dark, and system modes.
- Concept routes, specification, and the root 404 use their owning shells; shared footer and chrome are structurally
  consistent without other intentional visual changes.
