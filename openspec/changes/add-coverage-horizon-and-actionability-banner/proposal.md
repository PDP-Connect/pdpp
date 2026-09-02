## Why

Two related owner-facing health-model gaps kept surfacing false alarms.

First, some sources have a real, permanent boundary on what they can EVER
provide — a provider's retention policy predates the connection, or the
provider deleted history before the owner connected. There was no way to
record or disclose that boundary, so a source stuck at a permanent boundary
looked identical to one that was actually broken.

Second, the fleet-wide owner banner already commits (`FleetHealthVerdict
.banner_warranted`'s doc comment) to firing only for a proven owner action or
a materially blocked connection, "does NOT fire for ordinary cadence-relative
lateness." That commitment was not fully honored: a schedulable
(`automatic`/`background_safe`) connector whose data ages past its own
manifest-declared staleness window reaches headline `state: "degraded"` by
design (the system was supposed to refresh it and did not), and the fleet
composer read that raw headline state into its materially-blocked bucket —
firing the global alarm-toned banner for a source that is simply overdue on
its own, already cadence-proportionate, schedule.

## What Changes

- Add a provider coverage-horizon/provenance disclosure: a structured,
  reversible, append-only record of the boundary of what a source can ever
  provide, scoped per connection and optionally per stream. Durable storage
  supersedes rather than overwrites a prior confirmation, so provenance is
  never silently lost.
- Thread the coverage horizon through connection health as a PURE
  pass-through evidence field: it participates in no classification step,
  cannot move the headline state, any axis, any condition, or the forward
  disposition, and is exposed only through the owner-facing inspection layer
  (`RenderedVerdict.detail`), never the tone-bearing `pill`/`channel`.
- Close the fleet-banner gap: exclude a headline `degraded` state that is
  caused ENTIRELY by ordinary cadence-relative staleness from the
  materially-blocked banner gate, reusing the same evidence-based predicate
  the per-connection verdict already uses to render that shape as "Needs
  refresh" rather than "Missing data" — so the fleet banner cannot disagree
  with the per-connection verdict it summarizes.

## Capabilities

### Modified Capabilities

- `reference-connection-health`: coverage-horizon disclosure evidence and the
  fleet-banner actionability gate.

## Impact

- Additive SQLite and PostgreSQL schema (`connector_coverage_horizons`,
  `backup_required`).
- `ConnectionHealthSnapshot`, `ComputeConnectionHealthInput`, and
  `RenderedVerdict.detail` gain an additive `coverage_horizons` field; no
  existing caller's classification output changes.
- `FleetHealthVerdict.banner_warranted` stops firing for a connector whose
  ONLY degradation is ordinary cadence-relative staleness; `state` and
  `dimensions.system.degraded_or_broken` are unchanged (they intentionally
  stay broad diagnostic signals).
