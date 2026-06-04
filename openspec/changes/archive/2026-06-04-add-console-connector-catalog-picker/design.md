# Design — console connector-catalog picker

## Context

`AddConnectionGuidance` renders three sections sourced from
`apps/console/src/app/dashboard/lib/connection-modality.ts`:

- `SUPPORTED_LOCAL_COLLECTOR_CONNECTORS` (`claude_code`, `codex`) — deep-link to
  the enrollment form.
- `SUPPORTED_BROWSER_COLLECTOR_CONNECTORS` (`amazon`) — manual browser-collector
  deep-link.
- `UNSUPPORTED_ADD_MODALITIES` — one entry per non-creatable modality, with the
  named missing primitive and (for browser-bound) the runbook path.

The hardcoded literals exist so the console and the backend
`classifyConnectorIntentModality` classifier stay in lockstep; they are pinned by
`connection-modality.test.ts` against the committed manifests. They are an honest
source of truth for *what can be completed*, but they are not a catalog: they name
only the connectors the console can complete or one example of each gated class.

The add-connection surface is a Next.js server component. `listConnectorManifests()`
reads every shipped manifest (with `runtime_requirements.bindings`) at request
time, cookie-side, with no owner bearer. So the data for a generic catalog is
already reachable from exactly the surface that needs it.

## Decision

Build a pure catalog model from the live manifests and render every connector,
grouped by modality, with routing derived from the existing supported-set
predicates. Concretely:

1. Add a pure module `connection-catalog.ts` that takes the manifest list and
   produces a `ConnectorCatalogEntry[]`: `{ connectorKey (canonical key),
   displayName, modality, disposition }`, where `disposition` is one of
   `local_collector_enroll` | `local_collector_unproven` |
   `browser_collector_manual` | `browser_bound_runbook` | `api_network_unsupported`
   | `unknown_unsupported`. The disposition is computed from the binding modality
   plus the existing `isSupportedLocalCollectorConnector` /
   `isSupportedBrowserCollectorConnector` predicates — no new classification
   logic, no new source of truth.

   `local_collector_unproven` is the honest treatment for filesystem-class
   connectors outside the proven enrollment set (e.g. `slack`, `apple-health`):
   their collector path exists in principle, but the console has no committed
   enrollment proof for them, so they are named without a deep-link rather than
   either offered as a false one-click enroll OR mislabeled as "needs an API
   connection flow" by being lumped with API/network sources.
2. The records page (server component) calls `listConnectorManifests()`, builds
   the catalog, and passes it to `RecordsListView`, which forwards it to
   `AddConnectionGuidance`.
3. `AddConnectionGuidance` renders the catalog grouped by disposition:
   - **Supported from the console** — `local_collector_enroll` entries, each a
     deep-link `?connector=<id>` into the enrollment form (unchanged behavior,
     now driven by the catalog rather than the literal — still gated by
     `isSupportedLocalCollectorConnector` so only proven keys are clickable).
   - **Manual browser-collector setup** — `browser_collector_manual` (Amazon),
     deep-link as today.
   - **Browser-bound, owner-run** — `browser_bound_runbook` entries. Listed by
     name, each pointing at the runbook path. No enrollment deep-link, because
     the console has no generated runner profile for them; the
     `BrowserBoundEnrollmentNotice` already handles that case if an owner
     navigates there directly.
   - **API / network — not creatable here yet** — `api_network_unsupported`
     entries, named, with the missing-primitive reason. No deep-link.

The picker therefore shows all 31 connectors, each routed to its real next step.

## Why not call the owner-agent catalog route

`GET /v1/owner/connector-templates` already returns exactly this catalog
(manifests + modality + `supported_actions`), but it is owner-*bearer* authed
(`requireToken` + `requireOwner`). A browser owner cookie session has no owner
bearer, so the console must not call it — the same constraint that keeps the
console off `POST /v1/owner/connections/intents`. Reading the committed manifests
directly from the filesystem in the server component is the cookie-session-safe
equivalent and needs no new auth surface.

## Why this is not a new contract

The picker adds no endpoint, no response field, no manifest field, and no runtime
behavior. It reads committed manifest files via an existing function and reuses
the existing classifier and supported-set predicates. The honesty boundaries it
presents (what is creatable vs. gated) are already normative in
`reference-owner-agent-control-surface`; this change records the operator-visible
requirement that the surface present the *full catalog* honestly, in
`reference-surface-topology` (which already governs what dashboard surfaces show,
including the "browser-bound connector is documented" scenario).

## Out of scope

- Flipping any browser-bound or API/network connector to "supported" — that
  remains gated on the owner-run proof in
  `add-browser-collector-enrollment-primitive` and
  `add-static-secret-owner-connect-primitive`. This change only makes the gated
  connectors *visible and honestly explained*, never creatable.
- A new public/cookie connector-catalog endpoint. Not needed; the manifests are
  on disk in the console deployable.
- Search/filter UI over the catalog. With 31 entries grouped by modality, a
  static grouped list is sufficient; a filter is a later polish if the catalog
  grows.

## Acceptance checks

- The add-connection surface lists every connector whose manifest is shipped
  (count equals the number of `.json` manifests with a `connector_id`), each
  under its modality group.
- Every `local_collector` connector deep-links into the enrollment form
  pre-selected; no `browser_bound`/`api_network` connector renders an enrollment
  deep-link or an "Add connection" button.
- The catalog model is pure and unit-tested against the committed manifests; the
  existing `connection-modality.test.ts` invariants (supported set, unsupported
  honesty, runbook path) still pass.
- `pnpm --dir apps/console types:check` and the focused console suite pass.
