## ADDED Requirements

### Requirement: Remote surface client SHALL expose a container-fit viewer primitive

`@opendatalabs/remote-surface/client` SHALL expose a DOM-only viewer primitive that adapts a stream to the bounds of an arbitrary container element. The primitive SHALL observe the container with `ResizeObserver`, SHALL derive fitted geometry using the existing client geometry helpers, and SHALL expose the current display rect, scale, letterbox bars, one-to-one status, a geometry subscription hook, a client-point-to-stream mapping function, and disposal.

#### Scenario: A host mounts the primitive into different container shapes

- **WHEN** a host provides a container element and an intrinsic stream viewport
- **THEN** the primitive SHALL compute fitted geometry for the container's current size
- **AND** the primitive SHALL update that geometry when the container resizes
- **AND** the primitive SHALL map client input points back into stream viewport coordinates using the existing geometry helpers

#### Scenario: A container is too small or unusually shaped

- **WHEN** the container is tiny, portrait, landscape, or otherwise non-standard
- **THEN** the primitive SHALL still report the fitted display rect and letterbox bars for the container
- **AND** the primitive SHALL keep pointer mapping consistent with the fitted rect

### Requirement: The playground SHALL demonstrate container adaptivity directly

The remote-surface playground SHALL render the viewer through the container-fit primitive and SHALL demonstrate the same viewer inside multiple container modes, including an inline box, a full-page modal container, and an odd-shaped container. The playground SHALL NOT present a separate fullscreen feature if the same effect is achieved by changing the container.

#### Scenario: The viewer is shown inline, modal, and in an odd shape

- **WHEN** an operator switches container mode in the playground
- **THEN** the same viewer primitive SHALL be mounted into the new container
- **AND** telemetry, overlay controls, action strip, and pointer mapping SHALL continue to function
- **AND** the UI SHALL not require a viewport selector to fake container sizing

#### Scenario: Fullscreen is just a modal container

- **WHEN** the playground shows the viewer in a full-page modal container
- **THEN** the viewer SHALL adapt to that container size
- **AND** no separate fullscreen-only viewer state SHALL be required
