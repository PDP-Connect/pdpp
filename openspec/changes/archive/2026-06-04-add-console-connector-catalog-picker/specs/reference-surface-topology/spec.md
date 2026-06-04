# reference-surface-topology spec delta

## ADDED Requirements

### Requirement: The add-connection surface SHALL present the full connector catalog with honest binding-derived routing

The dashboard add-connection surface SHALL present every connector manifest the
reference ships as a catalog entry, grouped by the connector's binding-derived
modality, rather than a hardcoded subset. Each catalog entry SHALL route to the
honest next step the reference can complete today for that modality, and SHALL
NOT present an "Add connection" affordance the reference cannot complete.

The modality SHALL be derived from the manifest `runtime_requirements.bindings`
using the same `filesystem > browser > network` precedence the owner-agent intent
route uses, so the console and the trusted-agent surface classify a connector the
same way. The surface SHALL read the shipped manifests directly (it is a
server-rendered operator surface) and SHALL NOT call the owner-bearer
`/v1/owner/connector-templates` or `/v1/owner/connections/intents` routes from a
cookie session.

#### Scenario: The add-connection surface lists every shipped connector

- **WHEN** an operator opens the add-connection surface on `/dashboard/records`
- **THEN** the surface SHALL list every connector whose shipped manifest declares
  a `connector_id`, grouped by its binding-derived modality
- **AND** the surface SHALL NOT silently omit connectors that are not creatable
  from the console today

#### Scenario: A filesystem connector is offered as a one-click enrollment

- **WHEN** the surface lists a connector whose bindings include `filesystem` and
  whose key is in the proven local-collector set
- **THEN** the entry SHALL deep-link into the device-exporter enrollment form
  pre-selected for that connector
- **AND** the entry SHALL NOT require an owner bearer or call an owner-agent route

#### Scenario: A gated connector is visible but not falsely creatable

- **WHEN** the surface lists a connector whose bindings are `browser` or
  `network` and the reference has no committed console creation path for it
- **THEN** the entry SHALL be shown with the named missing primitive or, for a
  browser-bound connector, the owner-run runbook path
- **AND** the entry SHALL NOT render an enrollment deep-link or an "Add
  connection" button that would create a phantom zero-record connection
