# Design: browser surface diagnostic evidence

## Decision

Add a small shared connector helper that produces a closed structural
`browser_surface` diagnostics object for an already-detected browser failure.
The reference runtime revalidates counts, derives posture from those counts,
and freshly reconstructs that object before
it persists it on the existing `SKIP_RESULT.diagnostics` path. A diagnostic
that includes `browser_surface` persists no sibling connector fields.
The runtime persists the resulting object on
the run trace, linked to its run and trace identifiers; no new capture,
manifest, Collection Profile, storage table, or projection is introduced.

The evidence contains only:

- one of two fixed connector-owned surface/phase pairs;
- a privacy-safe route classification (`expected`, `interstitial`, or
  `unknown`), never a URL or path;
- bounded non-negative counts for independently observed dashboard/table,
  account-detail/transaction/navigation, target, empty, and parser markers;
- a derived surface posture (`recognized`, `verified_empty`, `parser_zero`, or
  `unexpected`); and
- no fixture references. Raw capture paths, hashes, and raw DOM are never
  persisted until a trusted scrubbed-fixture registry exists.

Optional raw fixture capture continues through the existing `CaptureSession`.
It is useful to create a scrubbed regression fixture after a live failure, but
it is not required for the structural fact to be durable.

## Connector integration

Chase classifies the final URL in memory against its one known dashboard
overview route, records independent dashboard and activity-table markers plus
row-target and parsed-row counts at the final snapshot, and retains the
runtime launch posture. It does not claim an empty state: no verified Chase
empty marker exists in current evidence. A zero parse remains
`selectors_pending`.

USAA classifies known account-detail, auth/challenge, and other routes in
memory; `expected` additionally requires an independently observed account or
transaction marker. It records bounded account-detail, transaction,
navigation, and export-affordance counts at `no_export_affordance`. A known
logon redirect retains the same closed observation through its existing
re-auth failure result; it does not change the session-dead outcome or bypass
the re-auth attempt. Its
durable message is constant and its durable diagnostics contain only the
closed structural object. It retains `export_affordance_missing` and its
current degraded coverage classification; absence of an affordance remains an
automation observation, not proof of provider outage or accepted absence.

## Alternatives

- Persist raw DOM, ARIA snapshots, screenshots, or URLs in the trace:
  rejected because those can contain personal data, account identifiers,
  credentials, or tokens.
- Add selectors or accepted-empty policy to either manifest: rejected because
  the evidence does not establish either policy or new source markup.
- Add a new Collection Profile message or browser diagnostics table: rejected
  because it duplicates the existing bounded `SKIP_RESULT.diagnostics` trace
  path and couples a reference browser concern into the profile.

## Verification

Unit tests cover runtime rejection of categorical/free-text/URL/identifier
inputs, posture classification, and bounds. Runtime integration tests include
contradictory false-empty and USAA parser-zero inputs and assert the derived
truthful result through stream skips, nested/terminal gaps, and returned gaps.
Connector integration tests cover
the committed Chase wrong-surface fixture, Chase table/parser-zero fixture,
and USAA account/interstitial/unknown routes through the actual export and
re-auth call chains while preserving their skip reasons. Exact Chase and USAA connector-shape-to-spine adversarial
tests confirm event and known-gap payloads retain only the closed allowlist.
