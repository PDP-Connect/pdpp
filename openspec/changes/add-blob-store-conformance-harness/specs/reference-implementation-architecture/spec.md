## ADDED Requirements

### Requirement: Blob Store Conformance Harness

The reference implementation SHALL maintain a test-only blob-store conformance harness before promoting blob persistence into a production storage interface.

#### Scenario: Multiple drivers prove the blob-store contract

**WHEN** the blob-store conformance suite runs
**THEN** it SHALL exercise at least the production SQLite-backed driver and one non-SQLite memory driver
**AND** both drivers SHALL satisfy the same content-address and binding invariants while advertising their backend identity.

#### Scenario: Broken driver proves falsifiability

**WHEN** a deliberately broken blob-store driver violates content-address dedupe or binding idempotency
**THEN** the conformance suite SHALL fail.

#### Scenario: Harness remains test-only

**WHEN** the harness is introduced
**THEN** it SHALL NOT create a production `BlobStore` interface
**AND** SHALL NOT change public `/v1/blobs` wire behavior
**AND** SHALL NOT move blob bytes out of SQLite.
