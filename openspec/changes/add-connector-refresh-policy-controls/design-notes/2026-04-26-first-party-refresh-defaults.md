# First-party refresh-policy defaults audit

**Status:** decided / informational — locks the section 5 classification
that already ships in `packages/polyfill-connectors/manifests/*.json`.
**Date:** 2026-04-26
**Author:** worker on `refresh-policy-defaults`

## Why

Section 5 of `tasks.md` (Connector Defaults) needs a durable record of
*how* every first-party polyfill manifest is classified, *why* a given
recommended mode/cadence was chosen, and *which connectors* either
contradict their declared posture in live runs or report progress so
poorly that the schedules dashboard cannot explain a run-in-flight to
the owner.

The validator already enforces the *shape* of `capabilities.refresh_policy`
(see `reference-implementation/server/auth.js#validateRefreshPolicyCapability`).
The classification *content* — which connector belongs in which posture
bucket — is project metadata that has to live somewhere stable so a
future tranche or contributor doesn't have to re-derive it.

## Posture buckets

`refresh_policy.recommended_mode` ∈ `{automatic, manual, paused}`.
First-party connectors only use `automatic` and `manual` today; `paused`
is reserved for future "shipped but unsupported" cases.

Within `automatic`, three cadence buckets matter for owner UX:

- **frequent** — `recommended_interval_seconds <= 1800` (≤ 30 min).
  Reserved for durable-credential streams whose value is real-time-ish.
- **moderate** — `1800 < recommended <= 3600`. Default sweet spot for
  durable-token APIs and local-file connectors.
- **daily-ish** — `recommended >= 21600` (≥ 6h). Slow-changing services
  where polling more often is wasted work and rate-limit risk.

`manual` connectors split into two subtypes by `interaction_posture`:

- **manual-by-default (manual_action_likely)** — browser-scrape,
  manual exports, OAuth consent flows that don't keep durable
  credentials.
- **bank/OTP (otp_likely)** — bank or retail flows that frequently
  challenge with one-time codes.

## First-party classification (31 manifests, 2026-04-26)

### Frequent automatic (≤ 30 min)
| Connector | Recommended | Minimum | Posture | Rationale source |
|---|---|---|---|---|
| `gmail` | 900s (15m) | 300s | credentials | Durable IMAP credentials, low rate-limit risk |
| `slack` | 1800s (30m) | 600s | credentials | Durable token, tier-based rate limits |

### Moderate automatic (~1h)
| Connector | Recommended | Minimum | Posture | Notes |
|---|---|---|---|---|
| `claude_code` | 3600s | 300s | none (local) | Local session logs |
| `codex` | 3600s | 300s | none (local) | Local CLI state |
| `github` | 3600s | 600s | none (token) | Personal access token, documented rate limits |
| `imessage` | 3600s | 300s | none (local) | Local `chat.db` read |
| `notion` | 3600s | 900s | none (token) | Durable integration token |
| `ynab` | 3600s | 900s | none (token) | Long-lived API token, slow-changing budgets |

### Daily-ish automatic (≥ 6h)
| Connector | Recommended | Minimum | Posture | Notes |
|---|---|---|---|---|
| `oura` | 21600s (6h) | 3600s | none (token) | Sleep/readiness updates a few times/day |
| `pocket` | 21600s | 3600s | none (token) | Save list changes infrequently |
| `reddit` | 21600s | 3600s | none (token) | Tighter unauthenticated rate limits |
| `spotify` | 21600s | 3600s | none (token) | Saved-tracks/recently-played update slowly |
| `strava` | 21600s | 3600s | none (token) | Activities uploaded after workouts |

### Manual-by-default (manual_action_likely)
`anthropic`, `apple_health`, `chatgpt`, `doordash`, `google_takeout`,
`heb`, `ical`, `linkedin`, `loom`, `meta`, `shopify`, `twitter_archive`,
`uber`, `usaa`, `whatsapp`.

These split into:

- **Browser-scrape behind a login wall** (`anthropic`, `chatgpt`,
  `doordash`, `heb`, `linkedin`, `loom`, `meta`, `shopify`, `uber`,
  `usaa`) — automatic polling risks lockouts and bot-detection.
- **Manual export** (`apple_health`, `google_takeout`, `ical`,
  `twitter_archive`, `whatsapp`) — data only refreshes when the owner
  produces a new file.

### Bank / OTP-likely (manual, otp_likely)
| Connector | Minimum |
|---|---|
| `amazon` | 7200s (2h) |
| `chase` | 7200s |
| `wholefoods` | 7200s |

`usaa` is currently classified as `manual_action_likely`, not `otp_likely`.
That matches the manifest rationale ("requires interactive login and
short sessions"). Owner-observed live behavior (`ERR_HTTP2_PROTOCOL_ERROR`)
is a transport failure, not a posture signal, so the classification stays
where it is.

### Paused / unsupported
None today. The bucket is reserved for connectors that ship in the
manifest set but are explicitly unschedulable; we do not have any such
case in the current first-party set.

## Verification

Every first-party manifest has a `capabilities.refresh_policy` and a
non-empty `rationale`. The validator
(`validateRefreshPolicyCapability`) rejects shape errors. The live
distribution above was confirmed by reading each manifest in the worktree
on 2026-04-26.

A new shape test
(`reference-implementation/test/polyfill-refresh-defaults.test.js`)
locks these defaults: it walks every manifest under
`packages/polyfill-connectors/manifests/` and asserts that

1. `capabilities.refresh_policy` is present and validator-clean;
2. `recommended_mode` ∈ `{automatic, manual}` (no first-party paused
   connectors today);
3. `automatic` policies declare `recommended_interval_seconds`,
   `minimum_interval_seconds`, and `background_safe: true`;
4. The declared `interaction_posture` is consistent with
   `capabilities.human_interaction`: connectors that list `otp` must
   have `interaction_posture: "otp_likely"`; connectors that list any
   `manual_action`/`credentials` requirement must use a posture other
   than `none`; connectors that list nothing must use `none` *or*
   `manual_action_likely` (manual-export connectors).

If a future contributor changes a manifest in a way that contradicts
the bucket above, the test fails and they have to either update the
classification here or fix the manifest.

## Live-behavior contradictions (durable todos)

Owner-observed live behavior on 2026-04-26 (from the workstream packet):

- **YNAB** — last run succeeded; matches declared `automatic / 1h /
  none` posture. **No action required**, but its progress reporting is
  weak (see below).
- **Chase** — succeeded but produced misleading `stream_skipped` /
  account-discovery messaging. Posture itself (`manual / otp_likely /
  background_safe: false`) still matches; the contradiction is in
  *progress reporting*, not in *policy*. Tracked under
  "Progress-reporting gaps" below.
- **GitHub** — earlier failure was caused by connector-path resolution
  (since fixed); the manifest's `automatic / 1h / none` posture is
  correct. **No policy change needed**, but flag for re-verification
  after the next end-to-end automatic run.
- **Gmail / Claude Code** — earlier runtime failures are not policy
  contradictions; both manifests still describe the right posture
  (Gmail: durable IMAP credentials; Claude Code: local-disk read).
  Re-verify on the next clean run before trusting the `automatic`
  defaults in production.
- **ChatGPT** — `manual_action` ingestion may need a host browser
  bridge to complete. Manifest already declares `manual /
  manual_action_likely / background_safe: false`. **Policy is
  correct.** The open question is *capability*: if the host browser
  bridge is missing the connector cannot succeed at all, automatic or
  not. Tracked as a non-policy capability gap; do not retroactively
  flip the posture.
- **USAA** — `ERR_HTTP2_PROTOCOL_ERROR` is a transport failure, not a
  scheduling-policy contradiction. Manifest stays at `manual /
  manual_action_likely`. Add a re-verification todo once the transport
  issue is understood; do not promote to `otp_likely` without owner
  evidence of an OTP prompt.
- **Slack** — runs long with little visible progress. Posture
  (`automatic / 30m / credentials`) is fine; the contradiction is in
  the *progress signal*, not the policy. Tracked below.

These do not require manifest changes today. They require either
connector-side fixes (Chase messaging, ChatGPT host bridge, USAA
transport) or progress-emission work (Slack, YNAB) that is owned by
later tranches.

## Progress-reporting gaps (durable todos)

Owner explicitly asked that "most connectors only report phases;
percent appears only when a connector emits both count and total"
become tracked work for core connectors. The connectors below are the
ones where the schedules dashboard most visibly fails to explain
run-in-flight progress to the owner today:

- **Slack** — long-running channel/message backfills with no per-stream
  count/total emission. Without `(count, total)` the dashboard can
  only show the phase label. Track: emit `(count, total)` per channel
  and per message page on the long-running history streams.
- **YNAB** — runs are short but the dashboard still shows phase-only
  output. Track: emit `(count, total)` per budget/account/transaction
  stream so the percent indicator works on the schedules view.
- **Chase** — `stream_skipped` / account-discovery messaging is
  misleading even when the run succeeds. Track: emit a discrete
  "discovery" phase and report skipped streams with an owner-readable
  reason rather than a generic `stream_skipped`.
- **Gmail** — IMAP polls can be long when the inbox is large. Track:
  emit `(count, total)` per folder so the dashboard can show percent
  during message backfill.
- **ChatGPT / Anthropic / browser-scrape connectors generally** — these
  are paginated browser flows. Track: emit phase + a page-level
  `(count, total)` where the connector knows the pagination bound
  before the run; otherwise emit `(count, ?)` and let the dashboard
  show "n records ingested" instead of misleading percent.
- **Claude Code / Codex** — local file reads complete fast enough that
  progress reporting is low priority, but the schedules dashboard
  still reads "phase only" today. Lower priority than the ones above.

These are connector-implementation tasks, not refresh-policy changes.
They live here so the next tranche of dashboard / connector work has
a concrete starting list rather than a free-text TODO.

## Out of scope for this audit

- Scheduler changes (already shipped on `main`).
- Dashboard UX changes (already shipped on `main`).
- Promoting `refresh_policy` to a Collection Profile or PDPP companion
  spec (explicitly deferred per `tasks.md` section 6 and
  `specs/polyfill-runtime/spec.md`).
- Adjusting any manifest's `recommended_mode` or interval based on
  one-shot owner-observed runs without sustained evidence.
