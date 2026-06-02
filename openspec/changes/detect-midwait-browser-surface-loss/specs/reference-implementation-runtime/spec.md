# reference-implementation-runtime Specification Delta

## MODIFIED Requirements

### Requirement: Runtime SHALL broker interactions as in-process pauses and SHALL cancel open interactions when the browser surface is lost mid-wait

The reference runtime SHALL monitor the browser surface during a `manual_action` interaction wait and SHALL cancel the open interaction fail-closed if the surface becomes unavailable before the owner responds.

#### Scenario: Browser surface is lost during interaction wait
- **WHEN** a connector emits a `manual_action` INTERACTION with an active browser surface
- **AND** the browser surface becomes unreachable (CDP HTTP probe fails) before the owner responds
- **THEN** the reference runtime SHALL detect the surface loss via periodic mid-wait polling
- **AND** it SHALL emit `run.browser_surface_lost` with `probe_code`, `probe_detail`, `interaction_id`, and `kind`
- **AND** it SHALL cancel the pending interaction and record `run.interaction_completed { status: "cancelled" }`
- **AND** it SHALL clear the pending interaction entry so any subsequent owner response is rejected as stale
