# @pdpp/reference-operations-sandbox

Vendored snapshot of the 11 pure, dependency-injected reference operations
that `apps/site`'s public `/sandbox/**` demo routes call, plus their 2 shared
internal helpers (`read-projection.ts`, `search-authority-key.ts`) and the
CLI's static `package-info.ts`. This package exists because of a decision
made during Move B (the server-embed reorg, 2026-09): once
`reference-implementation` moves to `data-connect`, `apps/site`'s sandbox
routes can no longer import `pdpp-reference-implementation/operations/*`
directly — they had no proper seam at all before this package existed.

**Why vendoring, not a network proxy.** Every one of the 19 affected files is
a Next.js `force-static`/`force-dynamic` route (or its helper) that calls the
operation function with an **in-process deterministic demo fixture dataset**
(`apps/site/src/app/sandbox/_demo/`), never real owner data. Several are
built at compile time. A network proxy would make a public, unauthenticated
marketing site depend on a live personal-server process just to serve canned
demo output — a real architectural regression, not a like-for-like proxy.
The operations themselves are already designed for exactly this seam: their
own source-level "boundary rules" documentation states they must not import
Fastify/Next/SQLite/Postgres/`process` — they only take injected capability
dependencies. Vendoring them, the same pattern D-22 already established for
`@pdpp/reference-contract`, is the smaller and more honest fix.

**Authority model**: same as `@pdpp/reference-contract`'s D-22 seam — the
canonical source of these operations lives in `reference-implementation/
operations/` (post-Move-B: in `data-connect`). This package is a manually
re-synced snapshot, version-bumped on drift.
