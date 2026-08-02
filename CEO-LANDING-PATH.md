# CEO landing path closure

Status: implemented in the requested site/operator-docs scope.

## Closure

- The public reference page no longer derives or renders a live MCP URL from
  the public docs origin. It identifies the public site as documentation only.
- The landing page now presents one ordered path: pinned Docker/Compose images
  (`reference:sha-cc07e3a` and `web:sha-cc07e3a`, the verified `v1.0.4`
  release) on port 3000 → owner login → Gmail address + Google app
  password → healthy deployment, successful first sync, and `records > 0` →
  deployed `/connect` → Claude Code MCP add, OAuth, and a known-record query.
- The new operator runbook is
  `docs/operator/self-service-gmail-mcp.md`; the page links to it without
  turning the public docs origin into the deployment.
- Artifact evidence was corrected: the blessed Compose path uses the registry-
  proven `reference/web:sha-cc07e3a` pair from source revision
  `cc07e3a896c2c0df7841da4ec6b2c660ffe1e792`. The separately released
  `railway-core:sha-2fbdb4` lineage is labeled as an alternate path and is not
  presented as the same release.
- The steering correction's GHCR evidence is reflected directly: `reference`
  and `web` expose `1.0.4`/`sha-cc07e3a`, while `railway-core`
  exposes the separate verified `sha-2fbdb4` tag. The nonexistent
  `sha-6581820` manifests are no longer advertised.
- Hosted MCP wording now names the supported PDPP profile and avoids claiming
  generic MCP/OAuth interoperability. Local loopback HTTP and remote HTTPS are
  distinguished. Docker/Compose images and port 3000 are aligned, Node is
  documented as >=22.14, and the ChatGPT browser E2E is labeled exploratory and
  browser-specific rather than the normal self-service route.
- Regression tests cover both the public-origin MCP boundary and preservation
  of the health/data gate in both the page and blessed runbook.
- A deterministic artifact-consistency oracle rejects the previously advertised
  nonexistent `sha-6581820` class and rejects unallowlisted/mutable image tags
  in the blessed page/runbook sources without querying `latest` at render time.

## Verification

Passed:

- `pnpm --dir apps/site test` — 160 tests.
- Focused reference-page and artifact tests — 5 tests.
- Focused Biome check for the changed page/tests.
- `pnpm --dir apps/site types:check`.
- `pnpm --dir apps/site build`.
- `pnpm generated-artifacts:check`.
- Mass ratchet for the changed site files — no staged server/lib/runtime source
  files.
- `git diff --check`.

The full `pnpm --dir apps/site check` remains blocked by eight existing
`lint/suspicious/noUnnecessaryConditions` diagnostics in
`apps/site/src/components/reference-app.tsx`, which is outside this change and
was not edited. No live deployment, Gmail credential, OAuth flow, push, PR, or
other live mutation was performed, so the real external journey remains
unverified beyond the deterministic documentation/page checks.

Changed files are limited to `apps/site`, operator/reference/deployment
documentation, and tests. No `apps/console`, runtime, package, or
reference-implementation code was changed.

Assisted-by: AI
