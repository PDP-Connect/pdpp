## ADDED Requirements

### Requirement: Runtime repair requests SHALL use bounded owner-action surfaces

The reference runtime SHALL route owner-mediated repair through bounded owner-action surfaces rather than connector-specific dashboard branches or manifest-specific provider-state enums. A connector MAY provide safe, source-specific instructions inside a bounded action after observing source state, but the owner-action surface itself SHALL be one of the shared product classes used by the reference projection.

#### Scenario: Connector observes an owner challenge

- **WHEN** a connector observes that the owner must provide a value, approve an external prompt, operate a browser, provide an artifact, or wait for provider/system retry
- **THEN** it SHALL emit or record structured assistance or required-action evidence using the shared action surface that matches the owner task
- **AND** it MAY include safe provider-specific instructions under that action.

#### Scenario: Connector-specific strings do not define actionability

- **WHEN** the dashboard, CLI, owner-agent, or scheduler decides whether a current item is owner-actionable
- **THEN** it SHALL use the structured assistance, required-action, or connection-health contract
- **AND** it SHALL NOT infer actionability from connector-specific progress text or error-string matching.

#### Scenario: Browser-session repair is explicit owner participation

- **WHEN** a connector asks the owner to operate a browser session for repair
- **THEN** the action SHALL be represented as browser-session operation with its response obligation and attachment state
- **AND** the runtime SHALL NOT treat credentials typed into the provider page as stored credentials unless the owner explicitly used a stored-credential capture flow.
