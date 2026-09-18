## Why

The conformance suite can drive a target but cannot observe a client making authorization, synchronization, or paginated resource-server requests. Eleven client-capture MUST clauses therefore remain untested.

## What Changes

- Add a small `ClientUnderTest` contract with named client actions and an instrumented authorization-server/resource-server fixture.
- Add black-box cases and injected-defect discrimination for the eleven client-capture clauses.
- Prove the contract with the PDPP MCP client transport and record the remaining client-role gaps.

## Capabilities

- Added: `conformance-client-channel`

## Impact

This changes the conformance-suite harness and its coverage accounting. It does not change PDPP wire semantics or the target adapter contract.
