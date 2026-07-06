## MODIFIED Requirements

### Requirement: Every connector run SHALL produce a per-stream Collection Report

The reference implementation SHALL expose, for owner/control-plane readers, a
structured **Collection Report**: a per-stream coverage entry for every stream
that is in scope for the connection. The Collection Report SHALL continue to be
derived from runtime facts and current durable gap evidence, not accepted as a
portable connector-authored protocol object.

Each Collection Report stream entry SHALL include objective counts where known,
the derived coverage condition, the derived forward disposition, and the count
of pending recoverable detail gaps for that stream. When that pending-gap count
comes from a bounded durable read that reached its limit, the entry SHALL mark
the count as a floor rather than an exact total.

#### Scenario: Bounded pending-gap read reaches its limit

- **WHEN** the reference builds a Collection Report from a pending detail-gap
  read limited to `N` rows
- **AND** the read returns `N` pending rows
- **AND** at least one returned row belongs to stream `order_items`
- **THEN** the `order_items` Collection Report entry SHALL include the returned
  pending-gap count
- **AND** it SHALL mark that count as a floor
- **AND** owner/control-plane UI SHALL NOT present the count as an exact total.
