## Why

The reference implementation is supposed to be a forkable, provider-neutral substrate: behavior is meant to be constructed from normative PDPP protocol concepts, the manifest schema, and connector-authored facts (manifest fields, connector-emitted reason codes, connector-declared runtime requirements) — never from RI code that has hardcoded knowledge of a specific connector or provider.

That invariant has drifted. A read-only audit of `reference-implementation/` (excluding `connectors/`, manifests, fixtures, and tests) found real, current violations across every layer of the RI:

- `server/connector-key.ts` hand-maintains a frozen 40-entry allowlist of first-party connector slugs (`gmail`, `slack`, `usaa`, `chase`, `reddit`, ...) that gates which connector ids the RI will even recognize.
- `server/connection-setup-plan.ts` hand-maintains four more connector-name allowlists (`SUPPORTED_LOCAL_COLLECTOR_CONNECTORS`, `BROWSER_BOUND_CONNECTORS`, `PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS`, `STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS`) that gate setup UX and capability proof state by literal connector name instead of a manifest-declared capability.
- `runtime/scheduler-readiness.ts`'s generic per-schedule readiness gate branches directly on `canonicalId === "codex"` / `"claude-code"` and hardcodes `CODEX_HOME`, `CLAUDE_CODE_PROJECTS_DIR`, and sibling env var names inside otherwise-generic scheduler code.
- `runtime/connector-gap-bounding.ts`, a generic connector-output bounding/policy module documented as being on the hot path for "connector-evidence spine validation," hardcodes a `BROWSER_SURFACE_KINDS` set (`chase_current_activity`, `usaa_transaction_export`) and branches control flow on those literal values.
- `runtime/scheduler-source-pressure-cooldown.ts` dispatches a cooldown profile via a `Record` keyed by connector name (`chatgpt: CHATGPT_COOLDOWN_PROFILE`).
- `server/provider-auth/google-oauth-account.ts` and `server/provider-auth/google-data-portability.ts` hardcode Google's live OAuth endpoints (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`), Google-specific OAuth scope URLs, and `GOOGLE_*_CLIENT_ID`/`CLIENT_SECRET`/`REFRESH_TOKEN` env var names directly in what is otherwise generic-looking provider-auth exchange code; `server/stores/provider-auth-run-credentials.ts` is nominally a generic "resolve provider-auth run credentials" seam whose only two real code paths are both Google-specific.
- `server/version-disposition.ts` hardcodes `connector: "github"/"slack"/"ynab"/.../"usaa"` plus stream-name pairs across five different policy tables to drive generic dashboard version-disposition classification.
- `scripts/compact-record-history.ts`, an operator-run production script, hardcodes per-connector compaction policy tables keyed by `connectorIds: ["gmail", ...]` / `["usaa", ...]` / `["chase", ...]` throughout.

None of this is caught today. `connector-conformance.test.ts` and its siblings in `packages/polyfill-connectors/` prove connectors are honest about what they declare; nothing proves the reverse — that RI production code stays ignorant of which connectors exist. Some of these sites (`connector-key.ts`, `connection-setup-plan.ts`) are self-documented as deliberate, reviewed "migration groundwork" that a prior OpenSpec change (`canonicalize-connector-keys`) chose to hardcode rather than derive, so the drift is not accidental — it needs an explicit invariant and a machine gate, not just a norm.

## What Changes

- Add a new durable requirement to `reference-implementation-architecture` stating that RI production code SHALL contain zero connector/provider-specific executable knowledge: no hardcoded connector/provider id literals used for identity dispatch, no allowlists/denylists of connector names embedded in code, no provider-specific endpoints/OAuth scopes/env-var names, and no connector-specific branches in otherwise-generic runtime logic. Manifests, connector packages, fixtures/tests, generic display values, and explicitly-generated/derived data remain exempt, since those are the sanctioned channels for connector-authored facts.
- Add `reference-implementation/test/ri-zero-connector-knowledge-conformance.test.ts`, an executable static-analysis guard that scans RI production TypeScript for the violation shapes above and fails with a file:line inventory. The guard derives its notion of "known connector identity" from the manifest files themselves (`connector_key`/`connector_id` across both manifest roots) rather than hardcoding a second list, so it does not become the thing it forbids.
- Wire the guard into `pnpm --dir reference-implementation test` (auto-discovered, no extra wiring needed) and into `scripts/ci-mode.ts`'s local-signoff connector-surface trigger, so a change that touches RI production code or either manifest root re-runs the guard before local signoff can post green.
- Do not silently fix the discovered violations in this change. The guard is expected to fail against the current base — the fix is separate follow-up work, tracked as a residual risk here and left for the owning lanes to close per file/module.

## Capabilities

### Modified Capabilities
- `reference-implementation-architecture`: adds a requirement that RI production code SHALL contain zero connector/provider-specific executable knowledge, enforced by an executable conformance guard.

## Impact

- Affected code: `reference-implementation/test/ri-zero-connector-knowledge-conformance.test.ts` (new), `scripts/ci-mode.ts` (trigger wiring), `scripts/ci-mode.test.ts` (trigger coverage).
- No production behavior changes in this commit. The guard is net-new and is expected to fail against `HEAD` — see the failure inventory in `tasks.md` and the design doc.
- Follow-up (out of scope here): remediate the ~9 violating files identified in the inventory so the guard goes green.
