## Context

The Slack connector (`packages/polyfill-connectors/connectors/slack/index.ts`)
wraps `slackdump` (a Go CLI/library, AGPL-3.0, spawned as a subprocess) and
reads its SQLite archive output. It captures `SLACK_WORKSPACE` / `SLACK_TOKEN`
(an `xoxc-` session token) / `SLACK_COOKIE` (the browser's `d` session cookie)
from the owner and passes them to slackdump.

Four manifest streams — `stars`, `user_groups`, `reminders`,
`dm_read_states` — are declared `coverage_policy: deferred` +
`availability.state: unsupported_in_mode`, with the stated reason
"slackdump archive mode does not call `<method>`". At runtime the connector
emits `SKIP_RESULT` for all four unconditionally (`UNAVAILABLE_STREAMS` in
`index.ts`).

## Goals / Non-Goals

**Goals**
- Determine, with evidence, whether the four deferred streams are reachable
  using credentials the connector already holds.
- Implement every stream that is source-exposed, end-to-end.
- Preserve the connector's scope discipline: no new auth modality, no
  source-specific UI/browser branch, reuse the runtime's existing
  RECORD/STATE/SKIP_RESULT contract and the shared HTTP governor.
- Leave an honest manifest: `deferred`/`unsupported`/`unavailable` should
  only remain on a stream this investigation could not make reachable.

**Non-Goals**
- Building a general-purpose Slack Web API client covering methods beyond
  the four gaps.
- Adding a `slack_api` "mode" as a new top-level connector concept — the
  four new calls are additive to the existing archive-read collection path,
  not an alternate collection strategy the operator chooses between.
- OAuth app / bot-token support. The connector remains session-credential
  (`xoxc`+cookie) only, matching its existing `setup.modality: static_secret`.
- Live-credential end-to-end verification against a real workspace (owner-only,
  tracked as a residual risk).

## Evidence: is each stream reachable?

Investigated by reading slackdump's own source (`rusq/slackdump`, cloned at
`~/.tmp/slackdump-probe`) and its Slack API client dependency
(`rusq/slack`, a fork of `slack-go/slack`, cloned at
`~/.tmp/rusq-slack-probe`), plus Slack's public API reference
(`docs.slack.dev`). Full commands, greps, and source excerpts are recorded in
`design-notes/slackdump-and-slack-api-capability-audit.md`.

| Stream | Slack method | In slackdump CLI? | In `rusq/slack` client? | Tier | Reachable w/ xoxc+cookie? |
|---|---|---|---|---|---|
| `stars` | `stars.list` | No (`list` subcommand only covers `users`/`channels`) | Yes — `ListStars`/`GetStarred`/`ListAllStars` in `stars.go` | 3 (50+/min) | Yes |
| `user_groups` | `usergroups.list` | No | Yes — `GetUserGroups` in `usergroups.go` | 2 (20+/min) | Yes |
| `reminders` | `reminders.list` | No | Yes — `ListReminders` in `reminders.go`, posts `token` form field | 2 (20+/min) | Yes |
| `dm_read_states` | `conversations.info` | Called by slackdump for channel listing, but archived rows strip `last_read`/`unread_count*` | Yes — `GetConversationInfo`, response struct carries `LastRead`/`UnreadCount`/`UnreadCountDisplay` | 3 (50+/min) | Yes |

None of the four methods are marked deprecated in Slack's reference docs (the
`stars.list` usage note says stars UI was superseded by "Later" but the
method itself remains live and undeprecated). All four accept the same
session-token auth mechanism the connector already captures:
`Authorization: Bearer <xoxc token>` (or `token` form field for `postForm`
methods) plus `Cookie: d=<cookie>` on every request — verified directly in
`rusq/slackdump`'s `auth/value.go` (`NewValueAuth`) and `rusq/slack`'s
`misc.go` (`postForm`/`getResource`).

Conclusion: none of the four streams are source-unavailable. The manifest's
`unsupported_in_mode` claim was accurate about slackdump-the-tool and
misleading about the source. All four move to `coverage_policy: collect`.

## Decisions

### Decision 1: direct HTTP calls, not a slackdump upstream contribution

Two ways to close the gap: (a) contribute the four methods to slackdump
upstream (AGPL-3.0, out of this repo's control and timeline), or (b) call
Slack's Web API directly from the connector using the same session
credential slackdump uses. (b) is chosen: it needs no new auth semantics
(reuses the existing `SLACK_TOKEN`/`SLACK_COOKIE` secret bundle unmodified),
follows an established in-repo pattern (`github`/`ynab` already do
Node-`fetch` + `createConnectorHttpGovernor`), and does not make correctness
depend on an upstream PR merging on someone else's schedule. It keeps the
scope discipline the package's `AGENTS.md` states: connectors own their
record production, and the runtime already has the governor seam for exactly
this ("extend the runtime rather than work around it" — the governor already
generalizes across providers, Slack just needed its own profile).

### Decision 2: additive path, not a "mode" switch

The manifest today has no `slack_api` mode; the four gap streams' `availability`
declared `future_modes: ["slack_api"]` as a placeholder for exactly this. This
change does NOT introduce that as an operator-visible mode selector — a
`workspace`/`channels`/`messages`/etc. run still resolves entirely from the
slackdump archive as before; the four gap streams simply gain their own
direct-API collection routine, invoked from the same connector process using
the same already-validated credential. There is no scenario where an operator
picks "slackdump vs API mode" — the four gap streams always use direct API
because slackdump categorically cannot produce them, and every other stream
keeps using the archive because that path is already proven at scale (206k+
retained messages in the live verification, `docs/research/slack-coverage-live-verification-2026-06-29.md`).

### Decision 3: bound `dm_read_states` call volume by channel type, not full inventory

`conversations.info` is a per-channel call; a workspace with hundreds of
channels (973 observed live) would multiply Tier-3-budget calls if fetched
for every channel. But this stream is *specifically* about DM/MPIM read
state — public/private channel "read state" isn't a `dm_read_states`
concern. The archive's `channels` stream already parses `is_im`/`is_mpim`
per row (see `parsers.ts` / manifest `channels.schema.is_im`), so the
collector filters to only those channel IDs before calling
`conversations.info`, keeping the call count proportional to actual DM/MPIM
count (materially smaller than total channel count in every observed
workspace) rather than the full channel graph.

### Decision 4: one shared `slackApiPacingProfile()`, not four

Per `provider-profile.ts`'s established convention, pacing is declared once
per provider, at the provider's binding (slowest) documented ceiling across
methods actually called — following the same "declare at the floor, not
per-method" pattern already implicit in every other connector's single
profile. `usergroups.list`/`reminders.list` are Tier 2 (20+ req/min);
`stars.list`/`conversations.info` are Tier 3 (50+ req/min, faster). The
shared governor call site does not vary interval by method, so the ceiling
is set at the Tier 2 floor: `pacingMinIntervalMs: 3000` (20 req/min = one
req per 3s), same derivation style as `githubPacingProfile`
(documented sustained rate → margin-respecting ceiling, cited inline).

### Decision 5: manifest disposition after implementation

Per `openspec/specs/polyfill-runtime/spec.md`'s `coverage_policy` contract,
absence of the field defaults to `collect`. This change removes
`coverage_policy: deferred` and the entire `availability` block from all
four streams (deleting the now-inaccurate `unsupported_in_mode` claim)
rather than merely relabeling — an implemented stream with no explicit
policy IS `collect`, and leaving a stale `deferred` annotation on an
implemented stream would itself become the next dishonesty.

## Runtime shape

- `stars`/`user_groups`/`reminders`: full-inventory list calls (no
  pagination needed at typical scale; `stars.list`/`usergroups.list` support
  cursor pagination for larger accounts — wired using the same cursor-loop
  shape the archive-side `channels` collector already uses for consistency,
  not a new pagination primitive).
- `dm_read_states`: one `conversations.info` call per known DM/MPIM channel
  ID (sourced from the already-collected `channels` archive rows this run),
  emitting one record per channel with `last_read`/`unread_count`/
  `unread_count_display`.
- Auth failure (401/invalid_auth) on any of the four throws the connector's
  existing typed-error + `retryablePattern` path (mirroring `github_auth_failed`
  in `github/index.ts`), so a revoked/expired session surfaces as the
  standard credential-repair flow, not a manifest-declared gap.
- 429 exhaustion after governor retries throws `slack_rate_limited`,
  matching the `<name>_rate_limited` convention every governor-using
  connector already relies on for the cross-run cooldown contract.
- A non-transient, non-auth error (e.g. a legacy/free-tier workspace that
  genuinely rejects one of these methods) emits `SKIP_RESULT` with
  `reason: "not_available"` scoped to that one connection/run — this is a
  connection-level runtime fact, never fed back into the manifest.

## Acceptance checks

1. `openspec validate complete-slack-bundled-connector-coverage --strict` passes.
2. `pnpm --filter polyfill-connectors typecheck` and `pnpm --filter polyfill-connectors check` are clean on the touched files.
3. New/updated unit tests cover: success parse for each of the four streams;
   empty-result (zero stars/groups/reminders/DM channels); 429 → governor
   retry → `slack_rate_limited` terminal; 401 → `slack_auth_failed` terminal;
   `dm_read_states` scoping to `is_im`/`is_mpim` channels only.
4. `slackdump-runtime.test.ts` no longer asserts the old
   `unsupported_in_mode` SKIP_RESULT for these four streams; it asserts the
   new collection path (mocked HTTP layer, no live Slack calls).
5. `packages/polyfill-connectors/manifests/slack.json` streams `stars`,
   `user_groups`, `reminders`, `dm_read_states` carry no `availability`
   block and no `coverage_policy` field (default `collect`); `required`
   returns to unset/default rather than `false`.
6. README corrected: stream list and "declared but not realizable" section
   updated to reflect the new direct-API path; the stale `dm_read_states`
   claim removed or corrected.
