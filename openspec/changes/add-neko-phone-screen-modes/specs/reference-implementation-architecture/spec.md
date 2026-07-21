## ADDED Requirements

### Requirement: The reference n.eko image SHALL expose CSS-sized phone screen modes

The reference n.eko image SHALL expose XRandR configurations for 412x915 and 915x412. Static Compose and dynamically allocated n.eko surfaces SHALL use that same image configuration. These modes SHALL represent CSS pixels at DPR 1; the reference SHALL NOT replace them with DPR-scaled device-pixel modes.

#### Scenario: A portrait owner viewport is attached

- **WHEN** the streaming adapter selects a n.eko configuration for a 412x915-class viewport
- **THEN** the available configuration list SHALL contain 412x915
- **AND** cover-fit selection SHALL choose 412x915

#### Scenario: The owner viewport rotates to landscape

- **WHEN** the streaming adapter selects a n.eko configuration for a 915x412-class viewport
- **THEN** the available configuration list SHALL contain 915x412
- **AND** cover-fit selection SHALL choose 915x412

#### Scenario: A selected phone screen is waiting for Chromium to resize

- **WHEN** n.eko accepts a phone-sized screen configuration but the `RemoteBrowserApp` window does not yet match the active X root dimensions
- **THEN** the streaming adapter SHALL NOT report that screen configuration as settled
- **AND** it SHALL NOT promote a captured frame for that lifecycle epoch

#### Scenario: Chromium matches the active X screen

- **WHEN** the container-local window-settle surface reports every `RemoteBrowserApp` window at the applied screen dimensions
- **THEN** the streaming adapter SHALL complete the serialized presentation operation
- **AND** it MAY promote subsequently captured frames for that lifecycle epoch

#### Scenario: A n.eko surface is allocated dynamically

- **WHEN** the allocator starts a dynamic n.eko surface
- **THEN** it SHALL use the same image configuration as the static Compose n.eko service
- **AND** that image configuration SHALL expose both CSS-sized phone modes
