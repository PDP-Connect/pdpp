## MODIFIED Requirements

### Requirement: Owner Surfaces SHALL Share One Projection Contract

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same connection health projection and condition contract.

Owner-console surfaces that classify connection status or owner actionability SHALL use a shared actionability projection over the server-owned rendered verdict. A surface MAY render a different layout or join additional surface-specific data, but it SHALL NOT independently decide whether the primary action is owner-satisfiable, whether the connection requires owner action now, or whether a source belongs in owner-required, review, system-issue, or checking work.

Owner surfaces that present a headline count of sources needing attention SHALL derive that headline count from one shared function over the shared actionability projection. The headline "needs your action" count SHALL equal the size of the owner-required (needs-you) work group and SHALL NOT sum in the review, system-issue, or checking groups. A surface MAY additionally show a separate, distinctly-labeled secondary count for the wider reviewable set, but SHALL NOT present that wider number as the headline "needs you" count. When a surface renders the owner-required work group as rows, the headline count SHALL equal the number of rows in that primary group on the same surface.

The owner-facing label and one-line explanation for each of the owner-required, review, system-issue, and checking work groups SHALL come from the shared actionability projection. Owner surfaces SHALL NOT re-author per-surface group labels or notes for these four groups, so the dashboard and Runs surfaces render identical category copy. The non-urgent owner-runnable (review) group SHALL be presented as concrete available actions — labeled as available actions and, per row, preferring the rendered verdict's action CTA — rather than as a "ready for review" taxonomy noun. This owner-facing copy SHALL stay product-facing and neutral: it SHALL NOT expose the internal term "reference" for the product, and SHALL NOT use dramatic phrasing for non-urgent states.

Owner-console stream rows that render Collection Report count facts SHALL distinguish a strategy-backed coverage proof from a raw collection numerator. When a stream entry is complete because a declared coverage strategy and committed/disabled checkpoint prove the boundary, the stream row SHALL name that proof instead of rendering `collected / considered` as the primary count line. The row MAY still expose the raw collected and considered values in secondary or title text.

#### Scenario: Strategy-backed complete stream names the proof

**WHEN** a stream Collection Report entry has `coverage_condition=complete`, a recognized `coverage_strategy`, and a committed checkpoint
**AND** the entry has `collected=9` and `considered=52`
**THEN** the owner-console stream row SHALL name the coverage proof as the primary count line
**AND** it SHALL NOT render `9 / 52 collected` as the primary count line.
