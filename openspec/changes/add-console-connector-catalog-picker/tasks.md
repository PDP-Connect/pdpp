# Tasks — console connector-catalog picker

## 1. Catalog model (pure, testable)

- [ ] 1.1 Add `apps/console/src/app/dashboard/lib/connection-catalog.ts`: a pure
      `buildConnectorCatalog(manifests)` that returns `ConnectorCatalogEntry[]`
      (`connectorId`, `displayName`, `modality`, `disposition`), classifying each
      manifest by `runtime_requirements.bindings` (`filesystem > browser >
      network`) and assigning disposition via the existing supported-set
      predicates from `connection-modality.ts`. No new source of truth.
- [ ] 1.2 Add `connection-catalog.test.ts`: assert the catalog covers every
      committed manifest, that dispositions match the modality + supported-set
      rules, and that no `browser_bound`/`api_network` entry is marked
      one-click-creatable.

## 2. Thread the catalog into the view

- [ ] 2.1 Records page (`records/page.tsx`, server component) calls
      `listConnectorManifests()`, builds the catalog, and passes it to
      `RecordsListView`.
- [ ] 2.2 `RecordsListView` forwards the catalog to `AddConnectionGuidance`.
- [ ] 2.3 `AddConnectionGuidance` renders the catalog grouped by disposition:
      supported local-collector (deep-link), manual browser-collector (Amazon
      deep-link), browser-bound owner-run (named + runbook, no deep-link),
      API/network (named + reason, no deep-link). Preserve the existing
      shared-module honesty (supported-set predicates, runbook path).

## 3. Validation

- [ ] 3.1 `node --test --import tsx` focused console suite incl. new
      `connection-catalog.test.ts`, `connection-modality.test.ts`,
      `records-list-view.test.ts` — pass.
- [ ] 3.2 `pnpm --dir apps/console types:check` — pass.
- [ ] 3.3 `pnpm exec ultracite check` on changed files — pass.
- [ ] 3.4 `openspec validate add-console-connector-catalog-picker --strict` — pass.
- [ ] 3.5 `git diff --check` — clean.

## Acceptance checks

- The add-connection surface lists all shipped connectors (count == number of
  `.json` manifests with a `connector_id`), grouped by modality.
- Only `local_collector` (proven set) and the Amazon manual path render
  deep-links; no `browser_bound`/`api_network` connector renders an enrollment
  deep-link or "Add connection" button.
- No browser-bound or API/network connector is flipped to supported.
