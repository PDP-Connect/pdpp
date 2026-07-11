## Why

Six 0710/0711 workstream lanes produced connection-health fixes against a branch
(`owner/connection-health-closeout-0710`) that a subsequent gate review
(`tmp/workstreams/health-closeout-gate-0710-report.md`) and an independent
red-team audit (`tmp/workstreams/health-contract-redteam-v2-0711.md`, on
`pdpp-health-redteam-0711`) both found insufficient to land as a full
closeout: the branch normalized Slack's four deferred streams as accepted
absence when they are source-reachable, treated a USAA login stall as a
proven provider outage when the owner can log in normally in an ordinary
browser, and left an active-run/stale-nudge contradiction and a systemic
scaffold-connector blind spot unresolved. Both reviews found real, narrowly
-scoped fixes worth keeping. This change re-integrates only the parts that
survive independent verification, corrects what does not, and closes the
scaffold gap the red-team flagged as still open in the current tree
(`anthropic`, `doordash`, `heb`, `linkedin`, `loom`, `meta`, `shopify`,
`uber` — 9 connectors, not the 8 the earlier audit found).

## What Changes

- Port the verified Slack direct-API collectors for `stars`, `user_groups`,
  `reminders`, `dm_read_states` (proven source-reachable via the connector's
  existing `xoxc` + cookie credential) so the manifest no longer declares
  these four as accepted absence. Do not resolve any part of this by
  re-marking them optional/deferred.
- Revert the USAA `source_unavailable`-bypasses-`manual_action` classification
  bug and restore owner-visible `manual_action`, adding discriminating
  `captureDom` evidence so the next occurrence produces proof instead of
  narrative inference. Keep the independently-correct scheduler-retry-classifier
  fix that trusts an explicit `connector_error.retryable`.
- Fix the active-run/stale-nudge contradiction: an advancing run dominates a
  routine `Needs refresh`/`owner_refresh_due` nudge in both the connection-level
  pill and `source-actionability.ts`, without softening a genuine `Degraded`
  defect.
- Align Reddit's manual-freshness manifest posture with the precedent Amazon
  already received (`background_safe:true`, `assisted_after_owner_auth:true`,
  a `minimum_interval_seconds` floor), and carry the already-ratified
  Amazon-to-USAA schedule-test rename fix.
- Ship the accepted-absence coverage-copy fix (visible label reads "optional,
  not collected" instead of "deferred") only alongside confirmation that the
  underlying runtime treats accepted absence as non-degrading only when the
  manifest's claim is no longer contradicted by source-reachability (Slack's
  four streams move out of accepted-absence entirely as part of this change,
  closing the one live contradiction found).
- Add a TEST-ONLY explicit production-ready connector roster — no new
  manifest field, no source scanning — cross-checked exactly against
  `capabilities.public_listing.listed`: every listed connector must be in the
  roster naming its own existing collection/integration test as the
  behavioral oracle, every roster entry's test file must exist, and the 9
  known scaffolds (`anthropic`, `doordash`, `heb`, `linkedin`, `loom`, `meta`,
  `shopify`, `uber`, `wholefoods`) must stay out of both the roster and the
  listed set. A newly-listed or newly-omitted connector fails CI. This closes
  the structural blind spot the coverage-policy-manifest-honesty test cannot
  see today without introducing a second, parallel truth about connector
  maturity or a generic connector-execution harness.
- Reduce cognitive-complexity mass on `runtime/connection-health.ts`,
  `runtime/connector-verdict-input.ts`, and `runtime/rendered-verdict.ts`
  back to or below the checked-in mass-ratchet baseline through
  concept-correct extraction, with no baseline ceiling changes.

## Capabilities

Modified:

- `reference-connection-health`
- `polyfill-runtime`

## Impact

- Slack's manifest, connector, and stream evidence honestly reflect that all
  14 non-meta streams are collected; only genuine architecture-boundary or
  privacy-gated streams remain accepted-absence anywhere in the bundled
  connector set.
- USAA's owner-facing failure path returns to `manual_action` with capture
  evidence instead of asserting an unproven provider-outage diagnosis.
- An owner never sees a stale-refresh nudge or a `refresh_now` action while a
  run is genuinely already advancing.
- Reddit reaches the same owner-opt-in scheduling posture as Amazon once this
  change deploys.
- Scaffold connectors (`anthropic`, `doordash`, `heb`, `linkedin`, `loom`,
  `meta`, `shopify`, `uber`, `wholefoods`) cannot become owner-selectable
  without a real collection path proven by their own source, checked
  structurally rather than by convention.
- `connection-health.ts`, `connector-verdict-input.ts`, and
  `rendered-verdict.ts` mass ratchet returns to green without raising the
  baseline.

## Explicitly Out Of Scope

- `server/ref-control.ts` mass-ratchet reduction (separate lane, per owner
  instruction).
- Any live deploy, merge, or push. This change lands as verified,
  independently-committed tranches on a worktree branch for owner review.
- Live-only acceptance items named in the red-team report (deployed-revision
  audit, live `stream-health:audit` run, next USAA live capture, live schedule
  re-pull) remain the owner's residual post-deploy steps.
