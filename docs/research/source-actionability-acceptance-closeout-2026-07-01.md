# Source actionability acceptance closeout - 2026-07-01

Status: durable acceptance note for the owner-console source-actionability
closeout. This records evidence for the shared UI model after the owner reported
that Sources, Runs, and detail surfaces appeared to use inconsistent problem
language.

## Contract

The durable contract lives in
`openspec/specs/reference-connection-health/spec.md`:

- owner-console surfaces that classify source status or owner actionability use
  the shared source-actionability projection over the server-owned rendered
  verdict;
- a connection appears in at most one actionability group on a given panel;
- owner-required, review, system/maintainer, and checking rows are separately
  grouped and counted;
- a surface may own its layout, but not a separate owner-action classifier.

## Verified surfaces

The following surfaces are covered by targeted acceptance and invariant tests:

- Overview: hero counts and source-work sections are derived from
  `sourceWorkFromConnectors`.
- Sources: source rows derive status, primary action, review cues, and stream
  actionability from `projectSourceActionability`.
- Runs: failure cards carry the shared source-work group and use shared status
  instead of remapping raw rendered-verdict tones.
- Source detail: diagnostics receives the same rendered verdict and derives
  status through the shared helpers.

Explore is intentionally not a source-health surface. It can deep-link from a
source/stream and show recordset state, but it does not own a separate
connection-actionability classifier.

## Acceptance evidence

On 2026-07-01, the targeted owner-surface suite passed:

```text
pnpm --dir apps/console exec tsx --test \
  src/app/dashboard/lib/source-actionability.test.ts \
  src/app/dashboard/runs/syncs-model.test.ts \
  src/app/dashboard/components/views/standing-view-model.test.ts \
  src/app/dashboard/records/sources-view-model.test.ts \
  'src/app/dashboard/records/[connector]/page-health-surfaces.invariants.test.ts' \
  src/app/dashboard/components/views/sources-ia.invariants.test.ts \
  'src/app/dashboard/records/[connector]/connection-diagnostics.test.ts'
```

Result: 147 tests passed, 0 failed.

The run initially exposed a stale invariant that expected an old literal
assignment shape. The product code already consumed the shared projection; the
test was updated to pin the real contract: `projectSourceActionability`,
`actionability.renderedStatus`, `actionability.primaryVerdictAction`, and
`actionability.nextAction`.

## Residual

This closes the shared-model acceptance item. It does not claim every connector
is healthy. Connector-specific failures remain separate collection-quality or
provider-auth issues and should be investigated as connector residuals, not as
source-actionability taxonomy failures.
