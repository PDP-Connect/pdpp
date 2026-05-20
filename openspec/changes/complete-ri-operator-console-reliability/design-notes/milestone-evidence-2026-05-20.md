# RI Operator Console Reliability Milestone Evidence

Status: decided-promoted
Owner: reference implementation owner
Created: 2026-05-20
Related: `openspec/changes/complete-ri-operator-console-reliability`

## Outcome

The milestone is implemented for the reference implementation/operator-console boundary. The dashboard, CLI/status, and reference projections now share a deterministic connection-health model over durable evidence rather than last-run color alone.

Implemented evidence axes:

- headline health: `healthy`, `degraded`, `needs_attention`, `cooling_off`, `blocked`, `idle`, `unknown`;
- coverage: `complete`, `partial`, `retryable_gap`, `terminal_gap`, `unsupported`, `unavailable`, `deferred`, `inventory_only`, `unknown`;
- attention: durable structured attention lifecycle and non-secret next-action CTA;
- outbox/work: local/device-exporter heartbeat and backlog evidence;
- remote surface: `none`, `idle`, `waiting`, `leased`, `failed`, `unknown` axis plus non-secret detail;
- projection reliability: unreliable required evidence projects `unknown` instead of false green.

## Evidence

Key committed tranches after recovery:

- `e2a2e31e` synchronized the local collector lockfile.
- `b8da5569` and `9bb4287a` added and recorded bounded summary-reconciliation resource acceptance.
- `c45206e5`, `4e611cf9`, `4fdb4a31`, `b64f8c71`, and `0562efec` recorded residual notes, validation progress, push progress, legacy queue bridge removal, and closeout relationships.
- `b5785158` implemented manifest-aware coverage taxonomy.
- `5d47f3e2` recorded coverage completion.
- `6da58c30` projected browser remote-surface status into connection health.

Focused validation run after the final implementation:

```bash
node --test --test-timeout=60000 \
  reference-implementation/test/connection-health.test.js \
  reference-implementation/test/connection-health-acceptance.test.js \
  reference-implementation/test/connection-restart-acceptance.test.js \
  reference-implementation/test/dataset-summary-resource-acceptance.test.js \
  reference-implementation/test/connection-remote-surface-acceptance.test.js \
  reference-implementation/test/ref-connectors-list-operation.test.js \
  reference-implementation/test/ref-connectors-detail-operation.test.js

pnpm --dir reference-implementation typecheck
pnpm --dir apps/web types:check
pnpm --dir packages/local-collector test
pnpm --dir packages/polyfill-connectors typecheck
openspec validate complete-ri-operator-console-reliability --strict
openspec validate --all --strict
```

All focused checks passed.

Additional validation during the legacy queue bridge removal:

```bash
pnpm --dir packages/local-collector build
pnpm --dir packages/local-collector test
pnpm --dir packages/polyfill-connectors typecheck
pnpm --dir packages/polyfill-connectors test
openspec validate complete-ri-operator-console-reliability --strict
```

All checks passed.

## Known Non-Blocking Caveats

- `reference-implementation/test/browser-surface-leases.test.js` still has environment-sensitive failures in this shell around static surface fixture ids. The new `connection-remote-surface-acceptance.test.js` proves the production operator projection path without depending on that fixture drift.
- Per-connector manifest authoring for `coverage_policy` is connector-specific follow-up. The projection now supports the taxonomy and tests it with synthetic manifest evidence; existing manifests default to prior behavior when policy is absent.
- Connector green-state work remains separate. This milestone makes the operator console honest under gaps, attention, backoff, local backlog, and remote-surface capacity; it does not claim Chase, ChatGPT, USAA, Slack, Gmail, Claude, or Codex are all green.
- `add-local-collector-durable-work-substrate`, `publish-pdpp-local-collector`, and `complete-local-agent-collectors` remain independent changes for broader local collector polish and publish readiness.
- The local worktree still has unrelated `.claude` / `.pdpp` changes that were present outside this milestone and intentionally not touched.

## Follow-Ups

- Author connector-specific manifest `coverage_policy` only where the connector owner has evidence that a stream is unsupported, unavailable, deferred, or inventory-only.
- Repair or isolate the environment-sensitive `browser-surface-leases.test.js` fixture so full reference test runs are less noisy under local deployment env.
- Continue connector green-state work with the inspect-first workflow: use fixtures/timelines/live inspection before asking for new human runs.
- Continue local collector durability work in its own active changes: scan/drain ordering, bounded child output, cancellation propagation, lease renewal, and host-native unit templates.

