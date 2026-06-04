# Add a console connector-catalog picker to the add-connection surface

## Why

The console add-connection surface (`AddConnectionGuidance` on `/dashboard/records`)
enumerates a hardcoded set of three connectors — two local-collector
(`claude_code`, `codex`) and Amazon as the one browser-bound example — out of the
31 connector manifests the reference ships. An owner who wants to add any other
connector sees no entry for it, which reads as "the reference only knows about
these three", the exact Amazon-specific / non-generic feeling the prior lane
(`ri-connection-creation-universal-slvp-v1`) reframed in copy but could not fix
structurally.

The structural blocker the prior lane reported — "the console has no manifest at
the add-connection surface, so it enumerates the proven set by key" — is
incorrect. The add-connection surface is a server component, and
`listConnectorManifests()` (`apps/console/.../lib/rs-client.ts`) already reads
every shipped manifest from `packages/polyfill-connectors/manifests` cookie-side,
each carrying `runtime_requirements.bindings`. All 31 classify cleanly under the
same `filesystem > browser > network` precedence the backend intent route uses
(9 filesystem, 14 browser, 8 network, 0 unknown). The catalog data needed for a
generic picker is already present; only the presentation hardcodes three entries.

## What Changes

- The console add-connection surface SHALL present every shipped connector
  manifest as a catalog entry, grouped by the binding-derived modality, instead
  of three hardcoded entries.
- Each catalog entry SHALL route to its current honest next step: filesystem
  connectors deep-link into the proven enrollment form pre-selected; the
  browser-bound connector with a committed runner profile (Amazon) deep-links into
  the manual browser-collector path; other browser-bound connectors surface the
  owner-run runbook without an enrollment deep-link; API/network connectors are
  presented as not-yet-creatable with the named missing primitive.
- No connector SHALL present an "Add connection" affordance the reference cannot
  complete (no phantom zero-record connections).
- No new endpoint, wire contract, manifest field, or runtime behavior. The
  picker reads already-committed manifests via the existing function and reuses
  the existing client-side modality classifier and supported-set predicates as
  the source of truth for routing and enablement.

## Capabilities

- Modified: `reference-surface-topology` — the add-connection dashboard surface
  gains a normative requirement to present the full connector catalog with
  honest, binding-derived routing.

## Impact

- Console only (`apps/console`). The `reference-owner-agent-control-surface`
  intent route, its `unsupported` reasons, and the browser-bound proof gate are
  unchanged; the picker mirrors them, it does not relax them.
