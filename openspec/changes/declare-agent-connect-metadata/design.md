## Decision

`agent_connect_endpoint` is part of the reference's public agent-native authorization-server metadata. The field is reference/PDPP-specific, but it is already emitted by the AS metadata builder and used by agent discovery flows.

The public contract should declare it as a URI and require it for the current reference profile because the implementation emits it unconditionally.

## Acceptance Checks

- Provider metadata tests assert `agent_connect_endpoint`.
- Public contract schema includes `agent_connect_endpoint`.
- Generated OpenAPI and route docs include the field.
