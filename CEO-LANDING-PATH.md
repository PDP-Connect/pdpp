# CEO landing path closure

Status: implemented in the requested site/operator-docs scope.

## Closure

- The public reference page no longer derives or renders a live MCP URL from
  the public docs origin. It identifies the public site as documentation only.
- The landing page now presents one ordered path: pinned Docker/Compose images
  (`reference:sha-cc07e3a` and `web:sha-cc07e3a`) on port 3000 → owner login →
  Gmail address + Google app
  password → healthy deployment, successful first sync, and `records > 0` →
  deployed `/connect` → Claude Code MCP add, OAuth, and a known-record query.
- The new operator runbook is
  `docs/operator/self-service-gmail-mcp.md`; the page links to it without
  turning the public docs origin into the deployment.
- Artifact evidence was corrected: the blessed Compose path uses only the
  registry-proven `reference/web:sha-cc07e3a` pair from source revision
  `cc07e3a896c2c0df7841da4ec6b2c660ffe1e792`. The alternate single-image
  platform lanes are excluded because their current registry manifest is not
  proven, so they are not advertised as pullable or verified.
- The nonexistent `sha-6581820` class and the unproven alternate image tag are
  rejected by the deterministic artifact oracle.
- Hosted MCP wording now names the supported PDPP profile and avoids claiming
  generic MCP/OAuth interoperability. Local loopback HTTP and remote HTTPS are
  distinguished. Docker/Compose images, port 3000, and deployed `/connect` are
  aligned. Node is documented as >=22.14, and the ChatGPT browser E2E is labeled
  exploratory and browser-specific rather than the normal self-service route.
- Regression tests cover both the public-origin MCP boundary and preservation
  of the health/data gate in both the page and blessed runbook.
- Deterministic artifact and touched-surface oracles reject the previously
  advertised nonexistent tag class, unallowlisted/mutable image tags, and the
  retired owner route in every touched docs/page/test source.

## Verification

Passed with the installed workspace binaries:

- `node --test --import tsx 'scripts/*.test.ts' 'src/**/*.test.ts'` from
  `apps/site` — 19 tests.
- Focused reference-page and artifact tests — all pass, including the touched
  surface route oracle.
- Focused Biome check for the changed page/tests.
- Site type generation and `tsc --noEmit`.
- Site production build — 49 static routes generated.
- Generated-artifact compile and byte comparison — 9 artifacts identical.
- `git diff --check`.

The repository `pnpm` wrapper could not run in this sandbox because its local
SQLite state database is inaccessible; the installed binaries ran the
equivalent checks above. The full site check also remains blocked by eight existing
`lint/suspicious/noUnnecessaryConditions` diagnostics in
`apps/site/src/components/reference-app.tsx`, which is outside this change and
was not edited. No live deployment, Gmail credential, OAuth flow, push, PR, or
other live mutation was performed, so the real external journey remains
unverified beyond the deterministic documentation/page checks.

Changed files are limited to `apps/site`, operator/reference/deployment
documentation, and tests. No `apps/console`, runtime, package, or
reference-implementation code was changed.

Assisted-by: AI
