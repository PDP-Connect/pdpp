## Why

The first local request to `/specification` took 164.5 seconds, and running the production build while the development server was active made both processes write the same `.next` directory. The public site needs an isolated, bounded development path that renders documentation without production verification corrupting or blocking it.

## What Changes

- Give development and verification/build commands distinct Next output directories.
- Keep the production-build worker limit out of development.
- Requalify Turbopack on the current Next.js and Fumadocs versions, retaining Webpack only if the recorded route and reload probes fail.
- Add executable checks for output isolation and environment-specific configuration.

## Capabilities

- Added: `site-development-runtime`

## Impact

- Changes the public site's local development and verification commands and Next configuration.
- Does not change production rendering, protocol semantics, routes, or published content.
