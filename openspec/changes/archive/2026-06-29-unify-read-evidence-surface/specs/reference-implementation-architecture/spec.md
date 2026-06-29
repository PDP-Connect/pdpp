## ADDED Requirements

### Requirement: Shared Read Evidence Semantics

The reference implementation SHALL provide shared read/evidence semantics for evidence cards, continuation descriptors, truncation descriptors, binary metadata, manifest-declared presentation, and stable record identity. MCP, CLI, REST evidence projections, and console surfaces SHALL use those shared semantics when rendering the same read evidence concept.

#### Scenario: CLI and MCP render the same evidence primitive

**WHEN** a record search hit is rendered through MCP and through a CLI evidence/card mode
**THEN** both surfaces SHALL derive identity, source, stream, provenance, truncation state, and continuation metadata from the same shared evidence primitive
**AND** SHALL NOT define competing semantics for the same concept.

#### Scenario: Canonical REST envelope remains available

**WHEN** a REST client requests the canonical record or search endpoint without an evidence projection
**THEN** the reference implementation SHALL return the canonical REST envelope
**AND** SHALL NOT replace the canonical envelope with an agent-specific card by default.

#### Scenario: Adapter-specific client behavior stays at adapter boundary

**WHEN** a client host has behavior such as file materialization approval, hidden `structuredContent`, or missing `resources/read`
**THEN** the reference implementation SHALL handle that behavior at the adapter/rendering boundary
**AND** SHALL NOT change RS authorization or canonical query semantics to encode a single host's behavior.

#### Scenario: Presentation uses manifest-owned semantics

**WHEN** a shared evidence primitive needs display roles, field types, or searchable/temporal field capabilities
**THEN** it SHALL consume the approved manifest-declared metadata for those concepts
**AND** SHALL NOT create a competing MCP-only, CLI-only, or evidence-only role/type vocabulary for the same concept.
