## Why

Presentation policy is currently duplicated across the public site, operator console, `@pdpp/operator-ui`, `@pdpp/brand`, and `@pdpp/brand-react`. Formatting logic sits inside React packages, global styles own route-specific behavior, and each app maintains its own theme runtime.

## What Changes

- Add a framework-independent `@pdpp/display` package for connector identity, record presentation, and timestamp policy.
- Make `@pdpp/brand` the layered token, typography, utility, and shared-style source while applications retain surface-specific CSS.
- Use one `next-themes` runtime from `@pdpp/operator-ui` across the public site and console.
- Co-locate component styling and Node test CSS handling with `@pdpp/operator-ui`.

## Capabilities

- Modified: `reference-surface-topology`

## Impact

- Affected packages: `@pdpp/display`, `@pdpp/brand`, `@pdpp/brand-react`, and `@pdpp/operator-ui`.
- Affected deployables: `apps/site` and `apps/console`.
- Added dependencies: `next-themes`; existing Tailwind and shared-style dependencies move to their owning package.
- No protocol, endpoint, schema, authorization, or record-storage contract changes.
