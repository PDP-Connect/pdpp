## Why

PDPP has strong bespoke falsifiability tests, but no common way to define, run, and audit deliberate faults across its AI-authored implementation and tests. A mutation score would hide the important question: whether a relevant test detects a plausible failure at an acceptable evidence and compute cost.

## What Changes

- Add a risk-falsification service that accepts machine-readable mutation packets and emits replayable, revision-bound receipts.
- Require baseline-first, isolated execution, exact cleanup, explicit resource budgets, and honest outcome classification.
- Route mutation checks through the existing test-accounting authority and record both focused tests and a relevant backstop.
- Add an adapter for an existing PDPP falsifiability oracle as the first end-to-end implementation.
- Keep mutation runs advisory during calibration. Do not introduce a repository-wide mutation score, coverage quota, or automatic test-deletion rule.
- Leave room for later domain-mutator, StrykerJS, and agent-generated-mutant adapters without making any one generator the architecture.

## Capabilities

### New Capabilities

- `mutation-falsification`: Defines mutation packets, execution safety, result classification, evidence receipts, test-authority integration, and calibrated rollout.

### Modified Capabilities

None.

## Impact

- Adds repository tooling, schemas, tests, and documentation for mutation packets and receipts.
- Integrates with `test-accounting.manifest.json` and its runners without changing suite ownership.
- Initially wraps one existing mutation or falsifiability oracle; production behavior and public APIs do not change.
- Mutation work remains bounded and non-blocking until observed evidence supports a narrower gate.
