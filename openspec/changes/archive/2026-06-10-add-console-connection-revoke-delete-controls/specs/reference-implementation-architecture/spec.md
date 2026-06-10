## ADDED Requirements

### Requirement: Owner-session connection revoke and delete SHALL reuse the owner-agent cascade implementation

The reference implementation SHALL expose owner-session reference-control routes to revoke and to delete one configured connection so the operator console can act on a connection without an owner-agent bearer. These routes SHALL be reference-only, owner-session authenticated, and SHALL NOT be reachable over `/mcp` or with a grant-scoped token. They SHALL delegate to the same connector-instance store primitives and the same non-secret audit emission as the owner-agent bearer revoke and delete routes, so that the console path and the agent path share one cascade implementation per action rather than a duplicate Console-only path.

Revoke SHALL remain zero-cascade: it SHALL flip exactly one connector instance to `revoked`, preserving that connection's already-collected records, grants, and audit, and SHALL NOT widen to sibling connections. Delete SHALL remain the connection-scoped destructive purge of exactly one connection's source-of-truth records and configured state defined by the shipped delete contract, SHALL refuse a connection with an active run and a default-account binding with the existing typed errors, and SHALL preserve the audit spine, disclosure grants, and sibling connections. Each owner-session action SHALL emit the same non-secret audit event type as its bearer sibling, including actor kind, target connection identity, operation, and outcome, without logging session credentials, provider secrets, or record contents.

#### Scenario: Owner-session revoke flips one instance through the shared primitive

- **WHEN** an authenticated owner session requests revoke for one resolved connection over the reference-control route
- **THEN** the reference SHALL flip exactly that connector instance to `revoked` through the same store primitive the owner-agent bearer revoke route uses
- **AND** it SHALL preserve that connection's already-collected records, grants, and audit and SHALL NOT affect any sibling connection
- **AND** it SHALL emit the same non-secret revoke audit event type as the bearer route without logging session credentials or provider secrets

#### Scenario: Owner-session delete delegates to the shared delete cascade

- **WHEN** an authenticated owner session requests delete for one resolved connection over the reference-control route
- **THEN** the reference SHALL erase exactly that connection's source-of-truth records and configured state through the same `deleteConnection` cascade the owner-agent bearer delete route uses
- **AND** it SHALL refuse a connection with an active run or a default-account binding with the existing typed errors
- **AND** it SHALL preserve the audit spine, disclosure grants, and sibling connections, and SHALL emit the same non-secret delete audit event type as the bearer route

#### Scenario: The owner-session routes reject non-owner-session callers

- **WHEN** a request to the owner-session revoke or delete connection route lacks a valid owner session
- **THEN** the reference SHALL reject it
- **AND** defining these owner-session routes SHALL NOT make any revoke or delete capability reachable over `/mcp` or with a grant-scoped token
