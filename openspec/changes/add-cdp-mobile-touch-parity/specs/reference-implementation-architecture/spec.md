## MODIFIED Requirements

### Requirement: Remote surface package SHALL expose backend adapters through host-neutral contracts

The remote-surface package SHALL expose host-neutral adapter contracts for supported browser-surface backends. Backend-specific local input policy MAY differ where prior art or browser behavior proves that a different translation is needed, but the policy SHALL be explicit and covered by adapter-level regression tests.

#### Scenario: CDP DOM touch taps are translated through the mouse click path

- **WHEN** a mounted CDP remote-surface adapter receives a local DOM `touchstart` followed by `touchend` without crossing the drag threshold
- **THEN** it SHALL prevent the local browser default gesture
- **AND** it SHALL blur the remote active element before committing the gesture
- **AND** it SHALL suppress synthetic mouse events for the post-touch window
- **AND** it SHALL dispatch a CDP mouse press followed by a CDP mouse release at the mapped stream coordinates
- **AND** it SHALL NOT dispatch a CDP touch event for that DOM tap

#### Scenario: CDP DOM touch drags start only after the drag threshold

- **WHEN** a mounted CDP remote-surface adapter receives a local DOM touch sequence whose movement crosses the configured drag threshold
- **THEN** it SHALL dispatch a CDP mouse press at the starting mapped stream coordinates
- **AND** it SHALL dispatch drag movement as CDP mouse move events with the primary button held
- **AND** it SHALL dispatch a CDP mouse release at the ending mapped stream coordinates

#### Scenario: CDP DOM touch cancel releases a held drag

- **WHEN** a mounted CDP remote-surface adapter receives `touchcancel` after a drag has started
- **THEN** it SHALL dispatch a CDP mouse release at the last mapped stream coordinate
- **AND** it SHALL clear the active touch gesture state

#### Scenario: Programmatic CDP pointer input remains explicit

- **WHEN** a caller invokes `sendPointer()` with a `pointerType` of `touch`
- **THEN** the CDP adapter SHALL forward that explicit touch pointer input through the CDP touch path
- **AND** the mouse-backed tap/drag policy SHALL apply only to local DOM touch events handled by the adapter
