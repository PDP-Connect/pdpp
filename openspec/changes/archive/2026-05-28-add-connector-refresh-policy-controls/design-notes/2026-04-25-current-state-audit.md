# Current-state audit: schedule + manifest surfaces

**Status:** decided / informational — captures the landscape this change builds on.
**Date:** 2026-04-25
**Author:** worker on `connector-refresh-policy-controls`

## Why

Before adding `capabilities.refresh_policy` and dashboard policy controls,
record what the reference already does so later tranches don't re-invent
existing surfaces.

## Schedule persistence and routes

- `connector_schedules` table is owned by the runtime controller
  (`reference-implementation/runtime/controller.ts`).
- `ConnectorSchedulePatch` accepts `enabled`, `interval_seconds`,
  `jitter_seconds` only. There is no policy field today.
- Owner-only `_ref` routes already cover the lifecycle:
  - `POST /_ref/connectors/:connectorId/schedule` upsert
  - `POST /_ref/connectors/:connectorId/schedule/pause`
  - `POST /_ref/connectors/:connectorId/schedule/resume`
  - `DELETE /_ref/connectors/:connectorId/schedule`
  - `GET /_ref/connectors` lists with schedule + last-run projection
  - `GET /_ref/connectors/:connectorId` returns the per-connector projection
- `ScheduleApi` already exposes `active_run_id`, `last_started_at`,
  `last_finished_at`, `last_error_code`, `next_due_at`. There is no
  field for declared-policy provenance, recommended cadence, or
  human-attention state yet.

## Scheduler behavior

- `reference-implementation/runtime/scheduler.ts` is the loop.
  Coverage in `reference-implementation/test/scheduler.test.js` already
  exercises retry/backoff, deterministic-failure non-retry, overlap
  prevention, and active-run reconciliation across restarts.
- There is no concept of a "needs human attention" pause yet beyond the
  generic active-run lock; an automatic schedule that hits a credentials/
  OTP/manual-action interaction will keep launching attempts on the
  configured interval.

## Manifest registration and validation

- First-party manifests live under `packages/polyfill-connectors/manifests/`.
- `reference-implementation/server/auth.js#validateConnectorManifest`
  is the single registration-time validator and the read-time validator
  used by `getConnectorManifest`. It validates streams aggressively but
  does **not** currently look at `manifest.capabilities` at all. The
  existing `human_interaction` field is unvalidated metadata in practice.
- `registerConnector` is called by `POST /connectors` and by
  `polyfill-manifest-reconcile.ts` on startup. Both go through
  `validateConnectorManifest(manifest)` with the default `invalid_request`
  error code.
- `getConnectorManifest` re-validates on read with code
  `connector_invalid` and `skipCursorFieldSortCheck: true`.

## Dashboard helpers

- `reference-implementation/server/ref-control.ts` projects
  schedule + last-run + last-success per connector for
  `/_ref/connectors[/_]` reads. It currently surfaces the schedule row
  and runtime projection only; it does not include any manifest-derived
  policy hint.
- `apps/web` consumes those projections; the dashboard UX work is owned
  by a later tranche per `tasks.md`.

## First-party manifest posture

`capabilities.human_interaction` already gives a coarse posture signal.
Distribution today (per `manifests/*.json`):

- `[]` (no human interaction): apple_health, claude_code, codex, github,
  google_takeout, ical, imessage, notion, oura, pocket, reddit, spotify,
  strava, twitter_archive, whatsapp, ynab.
- `["credentials"]`: gmail, slack.
- `["manual_action"]`: anthropic, chatgpt, doordash, heb, linkedin,
  loom, meta, shopify, uber, usaa.
- `["manual_action","otp"]` or `["otp","manual_action"]`: amazon, chase,
  wholefoods.

This is the rough partition the seeded `refresh_policy` should track:

- Local file / API-token / local-ingest connectors (apple_health,
  claude_code, codex, ical, imessage, twitter_archive, whatsapp,
  google_takeout, github, ynab, oura, strava, spotify, notion, pocket,
  reddit) → automatic, modest cadence, `background_safe: true`.
- Credential-flow connectors (gmail, slack) → automatic, longer
  cadence, `interaction_posture: "credentials"`.
- Manual-action / browser-scrape connectors → manual or paused; the
  scheduler should not poke them in the background.
- Bank/OTP connectors (chase, usaa, amazon, wholefoods) → manual,
  `interaction_posture: "otp_likely"`.

## Implications for this tranche

1. The validator change is small: add a single
   `validateRefreshPolicyCapability(manifest, code)` call inside
   `validateConnectorManifest`, gated on `manifest.capabilities?.refresh_policy`.
2. Reference-runtime spec deltas around the **scheduler** behavior and
   the **dashboard** projections are not yet implemented; they are a
   later tranche owned by the same change.
3. Seeding manifests is straightforward but should stay conservative:
   honest manual posture for browser/bank connectors, automatic only
   for low-friction local/API-token sources.
4. `refresh_policy` remains polyfill/reference metadata. The validator
   should not assume it is normative PDPP core protocol.

## Out of scope for this tranche

- Schedule projection extensions for policy provenance.
- Dashboard refresh-policy UI.
- Scheduler "needs-human" pause and policy-aware backoff.
- Reference-runtime spec delta scenarios beyond the polyfill manifest
  contract.

## Prior-art posture (owner guidance)

The change's `design.md` already cites Fivetran, Airbyte, and Kubernetes
CronJob. For the next tranche of work, the audit should explicitly map
the gaps named there to concrete scheduler features:

- **Fivetran**: per-connection sync frequency, manual mode, and the
  "delayed sync" handling when a previous sync overlaps. Our scheduler
  already prevents overlap; what we lack is the *projection* that
  explains the delay/skip and a manual-mode posture distinct from a
  paused schedule.
- **Airbyte**: cron-style schedules and platform-specific maximum
  frequency. Out of scope for this tranche, but `minimum_interval_seconds`
  in `refresh_policy` is the seam a future cron implementation can
  honor.
- **Kubernetes CronJob**: separation of *schedule* from *concurrency
  policy* and *missed/deadline handling*. The reference today couples
  these in `connector_schedules.enabled` and the scheduler loop;
  splitting them is a future tranche's concern.

`refresh_policy` stays reference/polyfill-only until a later Collection
Profile or companion-spec review picks a portable subset. Treat the
manifest hint as advisory metadata: connectors recommend, owners
decide.
