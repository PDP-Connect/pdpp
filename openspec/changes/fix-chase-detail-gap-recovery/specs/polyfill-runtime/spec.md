# polyfill-runtime (delta)

## ADDED Requirements

### Requirement: A connector served a pending detail gap it hydrates SHALL emit DETAIL_GAP_RECOVERED

A connector SHALL emit exactly one `DETAIL_GAP_RECOVERED` message, carrying a
served gap's `gap_id`, for each pending `DETAIL_GAP` row it was served at `START`
(`ctx.detailGaps`) whose detail it reaches and hydrates during the run.
"Hydrates"
means the connector successfully reached the parent record's detail source for
the run's window, including a source-limited empty result (e.g. a 0-row detail
fetch) — an empty result for a reached key is coverage, not a failure.

The `gap_id` in `DETAIL_GAP_RECOVERED` SHALL be a `gap_id` the runtime served
this run. A connector SHALL NOT emit `DETAIL_GAP_RECOVERED` for a served gap
whose detail it did not reach; such a gap SHALL remain served and fall through to
the runtime's existing served-but-unrecovered reset (back to `pending`). A
connector SHALL NOT synthesize a `gap_id` for a gap the runtime did not serve.

This makes explicit the recovery half of the detail-gap lifecycle that the
run-cap requirement already relies on ("a later run SHALL recover the deferred
records"): without a `DETAIL_GAP_RECOVERED` the durable gap row is reset to
`pending` after the run and the source is projected as permanently degraded even
though its detail was fully collected.

#### Scenario: A reached account-detail gap is recovered on retry

- **WHEN** a connector is served a pending `DETAIL_GAP` for record key K at
  `START`
- **AND** the run reaches and hydrates K's detail (including a 0-row result)
- **THEN** the connector SHALL emit `DETAIL_GAP_RECOVERED` with the served gap's
  `gap_id`
- **AND** the runtime SHALL mark that `connector_detail_gaps` row `recovered`
  with `recovered_run_id` set to the current run

#### Scenario: A served gap whose detail is not reached stays pending

- **WHEN** a connector is served a pending `DETAIL_GAP` for record key K at
  `START`
- **AND** the run does not reach K's detail (K still fails, or K is not among the
  keys considered this run)
- **THEN** the connector SHALL NOT emit `DETAIL_GAP_RECOVERED` for K's gap
- **AND** the served gap SHALL remain durable and be reset to `pending` after the
  run so a later run retries it

#### Scenario: Chase recovers a served account gap on a successful retry

- **WHEN** the Chase connector is served a pending `transactions` `DETAIL_GAP`
  with `detail_locator {kind: chase.account, account_id: A}` at `START`
- **AND** the run enumerates account A and parses its QFX (including a
  0-transaction QFX)
- **THEN** the connector SHALL emit `DETAIL_GAP_RECOVERED` with the served gap's
  `gap_id` and `stream` `transactions`
- **AND** it SHALL NOT emit `DETAIL_GAP_RECOVERED` for any account it did not
  reach
