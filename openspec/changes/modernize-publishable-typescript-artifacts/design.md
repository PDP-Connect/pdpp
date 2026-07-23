## Context

Release policy selects exactly four publishable packages. `@pdpp/local-collector`
already provides emitted-build and pack/install/run prior art. Read-core is a pure
leaf; CLI has an optional local-collector subprocess edge; MCP consumes CLI and
read-core and has a stdio subprocess boundary.

## Goals and non-goals

Goals are installed-package correctness, supported Node resolution, declarations
where exposed, and coherent migration closures. Non-goals are a mass JS conversion,
dist output for private app-transpiled packages or the private RI, and changing
runtime behavior merely to satisfy a type or lint metric.

## Decisions

- Build and prove read-core, then CLI, preserve/prove local-collector, then MCP.
  MCP follows its published dependencies rather than workspace source.
- Every package build precedes pack. Tarballs must contain emitted targets, no raw
  TypeScript/source-only `src` or `bin`, tests, or workspace dependency ranges.
  Every export and bin is resolved and executed from the candidate installation.
- In a fresh project, install all four candidate tarballs with
  `npm install --ignore-scripts`; inspect `npm ls --all` and resolved paths; use
  `npx --no-install` for bin probes to prevent registry fallback.
- Run the matrix at Node 22.14.0 and repository Node 25; include Node 26 where
  the Neko/Docker boundary is affected. The exact matrix may use pinned images,
  but a local source import is never a substitute for installed execution.
- Migrate by dependency/runtime class and preserve JS/MJS when a host loader,
  executable wrapper, configuration format, generated boundary, or supported
  runtime requires it. Each retained file gets an owner, reason, executable probe,
  and review/expiry condition. No retained file is justified by a count target.
- Production closure migration precedes test migration. Test migration is only
  allowed after test-accounting discovery parity is green and keeps before/after
  executed sets equal except for recorded renames.

## Alternatives rejected

Applying `dist` to every package would conflict with app bundlers and private RI
runtime contracts. Installing workspace packages or importing source would miss
Node's installed-package loader behavior. A mass JS conversion would expand risk
without proving a package contract.

## Acceptance checks

The four-package install-together oracle, package-specific gates, accounting parity,
and runtime matrix must produce per-tranche receipts. A package class blocks on an
artifact or runtime failure; work does not fan out around a failed contract.
