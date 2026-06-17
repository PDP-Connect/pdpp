## ADDED Requirements

### Requirement: Self-Handled Local-Device Drains SHALL Render As Background Progress

Owner inspection surfaces SHALL render a visible calm background-drain summary
when a local-device connection's trusted device progress reports pending outbox
work and the rendered verdict has no owner-actionable local-device remediation.
The summary SHALL identify that saved work is uploading from the local host,
SHALL include available queue scale and last-progress evidence, and SHALL NOT
render recovery commands.

#### Scenario: Pending local-device work is actively draining

**WHEN** a connection has trusted `local_device_progress.records_pending > 0`
and the rendered verdict has no local-device remediation action
**THEN** the owner inspection surface shows a calm background-upload summary
**AND** the summary includes the pending scale and any available host/progress
timestamps
**AND** the surface does not tell the owner to run dead-letter recovery commands.

#### Scenario: Stalled local-device work remains owner-actionable

**WHEN** a connection has a rendered verdict required action whose remediation
target is `local_device`
**THEN** the owner inspection surface shows the cause-specific recovery panel
**AND** it does not replace that recovery path with a passive background-upload
summary.
