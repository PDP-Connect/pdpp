## ADDED Requirements

### Requirement: Local-device terminal collection evidence SHALL be explicit

The reference implementation SHALL project local-device per-stream runtime facts only from a device-authenticated terminal collection report that follows a successful collector DONE and acknowledged coverage checkpoint. It SHALL NOT infer terminal stream facts from accepted batches, heartbeats, or record payloads alone.

#### Scenario: A local collector completes and drains coverage evidence

- **WHEN** a local collector reports successful terminal collection evidence for its enrolled source instance
- **THEN** the reference SHALL append an attributable terminal spine event with safe per-stream facts
- **AND** the existing summary fold SHALL make those facts available as current per-stream runtime evidence.

#### Scenario: A local run fails or lacks its coverage checkpoint

- **WHEN** a local collector does not complete successfully with an acknowledged coverage checkpoint
- **THEN** the reference SHALL NOT create committed terminal stream facts from that run
- **AND** it SHALL NOT erase previously folded durable stream facts.
