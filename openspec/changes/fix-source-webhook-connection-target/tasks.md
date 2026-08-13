## 1. Implementation

- [x] Resolve authenticated source webhooks to explicit owner, connector, and connector instance before claim.
- [x] Preserve legacy `PDPP_SOURCE_WEBHOOK_SECRETS` only when it resolves to one active writable connection.
- [x] Add structured JSON webhook config for explicit multi-connection targets.
- [x] Thread the target through ingest, run start, and scheduler fallback.

## 2. Tests

- [x] Add operation tests for custom-owner/two-instance target propagation and no-claim/no-mutation rejection.
- [x] Add route-boundary tests proving exact instance storage, run, scheduler, and rejection behavior.
- [x] Add real HTTP route coverage for structured JSON parsing, URL-shaped connector config, exact instance storage, and bad-target no-claim retry.

## 3. Validation

- [x] Run focused source-webhook tests.
- [x] Run reference implementation typecheck.
- [x] Run Biome/checks relevant to touched files.
- [x] Run `openspec validate fix-source-webhook-connection-target --strict`.
