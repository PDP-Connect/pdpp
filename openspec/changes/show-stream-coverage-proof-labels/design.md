## Context

The Collection Report separates the coverage verdict from the raw collection count. For strategy-backed streams, a committed checkpoint can prove the stream boundary while the run emits only records that changed. Rendering `collected / considered collected` in that case makes a healthy stream look incomplete.

## Decision

When a Collection Report entry is `coverage_condition=complete`, has a recognized `coverage_strategy`, and has a committed/disabled checkpoint, the owner console renders the strategy proof as the primary count line:

- `checkpoint_window` -> `checkpoint covered`
- `full_inventory` -> `inventory covered`
- `parent_detail_accounting` -> `details accounted`
- `snapshot_import_receipt` -> `snapshot imported`
- `singleton_presence` -> `presence checked`

If the run emitted records, the label appends `<N> collected`. The long-form title keeps the raw considered/collected facts and states that collected is not the coverage numerator for strategy-backed streams.

## Alternatives

- Leave the fraction visible and rely on the coverage chip. Rejected: the contradictory-looking count line is what made healthy streams look broken.
- Change backend coverage semantics. Rejected: live evidence showed the backend was correctly distinguishing strategy proof from raw emitted records.

## Acceptance Checks

- Strategy-backed complete streams do not render `collected / considered`.
- Non-strategy partial streams still render `collected / considered`.
- Covered-count streams still render `covered / considered`.
- Zero-emission singleton proofs render a useful proof label rather than `Collection count unavailable`.
