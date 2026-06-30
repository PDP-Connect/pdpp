## MODIFIED Requirements

### Requirement: Dashboard health summaries SHALL expose degraded work

Owner dashboard summaries that roll up connection health SHALL include degraded or cooling-off connection projections in an attention-visible summary bucket. A dashboard SHALL NOT present a zero attention-relevant summary while visible connection cards are degraded, cooling off, have stalled local-device work, or carry owner-runnable advisory required actions.

Owner-runnable advisory required actions SHALL be surfaced as a distinct non-alarming review state. They SHALL NOT be promoted to urgent attention solely because the owner can run them, but they SHALL suppress calm/all-clear copy and route the owner to source review. Maintainer-only or system-only required actions SHALL remain distinct from owner-runnable actions.

#### Scenario: Degraded card appears in the list

- **WHEN** a connection card renders with dominant state `degraded`
- **THEN** the dashboard summary SHALL include that connection in an attention-visible count or a distinct degraded count
- **AND** the summary SHALL NOT imply that no operator-relevant work exists

#### Scenario: Local outbox is stalled

- **WHEN** a local-device connection projects stalled outbox work
- **THEN** the dashboard summary SHALL make that stalled/degraded state visible without reclassifying it as a scheduler failure

#### Scenario: Owner-runnable advisory action appears without urgent attention

- **WHEN** a connection verdict has `channel: "advisory"` and a required action with `audience: "owner"` and `satisfied_when.kind` other than `none`
- **THEN** the dashboard summary SHALL render a non-alarming review state for that connection
- **AND** the dashboard summary SHALL NOT render calm/all-clear copy
- **AND** the connection source list SHALL expose that an owner-runnable action is available without turning the list row into the mutation control

#### Scenario: Maintainer-only action is not shown as owner-runnable

- **WHEN** a connection verdict has a required action with `audience: "maintainer"` or `satisfied_when.kind: "none"`
- **THEN** the dashboard summary and source list SHALL NOT present that action as something the owner can fix directly
- **AND** the owner surface SHALL still make the degraded or unavailable state visible as reviewable status

#### Scenario: Retained-size internals stay out of primary owner copy

- **WHEN** retained-size or dataset-summary projection metadata contains internal stale/failure reasons
- **THEN** the owner dashboard hero SHALL describe the operational effect in owner-safe language
- **AND** primary owner copy SHALL NOT include raw internal terms such as `projection`, `rebuild`, `bulk write`, `unknown connection`, or `SQL`
