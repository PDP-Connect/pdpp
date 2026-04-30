# Query/API readiness audit - 2026-04-24

Status: audit complete; reverified by `query-api-gap-audit`
Original branch: `audit-query-api-readiness`
Verification branch: `query-api-gap-audit`
Verification worktree: `/home/user/code/pdpp-query-api-gap-audit`
Scope: read-only audit of `reference-implementation/server`, query docs/specs, OpenSpec artifacts, and `packages/polyfill-connectors/manifests`.

## Executive summary

The reference server has the core mechanics for declared range filters, declared one-hop expansion, grant-safe `changes_since`, per-stream metadata, and `blob_ref` fetches. The readiness gaps are mostly contract/declaration gaps:

- No shipped `packages/polyfill-connectors/manifests/*.json` stream declares `query.range_filters`, so first-party assistant-critical date and amount windows are unavailable even though the server can execute them.
- `expand[]` works only for relationships that are both declared in `relationships` and enabled in `query.expand`. The shipped polyfill manifests declare many relationships but no `query.expand`, and many declarations are child-to-parent shaped while the server's expansion engine expects parent-to-child foreign keys.
- Schema discoverability exists only if the caller already knows the connector source and stream. Client grants can list stream names, but owner polyfill reads still require an out-of-band connector source id; stream metadata is per-stream, not a complete schema/capability document.
- `changes_since` is usable only with an opaque version cursor. Tests bootstrap with a hand-built `{kind:"changes_since",version:0}` token, but clients have no documented initial cursor flow and raw timestamps are not accepted.
- Gmail `message_bodies` are content-bearing records and are effectively done for email body text. Gmail `attachments` are metadata only; attachment bytes are not hydrated into `blob_ref` records or the `blobs` table.

## Stop-and-report findings

These are unsafe to implement directly from the current docs/spec text without a corrective OpenSpec/doc slice:

| Finding | Why unsafe | Recommended owner action |
| --- | --- | --- |
| `apps/web/content/docs/spec-change-tracking.md` says `changes_since` comes from a previous response's `next_cursor`. | Core and implementation intentionally use distinct cursor spaces: record pagination uses `next_cursor`; incremental sync uses `next_changes_since`. Passing a page cursor as `changes_since` is rejected. | Fix the change-tracking doc before any client guidance or SDK work. |
| `apps/web/content/docs/spec-data-query-api.md` still describes stream metadata as `object: "stream"` plus `expandable`, while Core/server use `object: "stream_metadata"`, `relationships`, and `query.expand`. | A client generated from the stale doc will look for the wrong fields and miss the actual capability declaration. | Align `spec-data-query-api.md` with Core's stream-metadata shape. |
| Blob docs promise `HEAD`, range-read guidance, and cache headers, but the reference only implements `GET /v1/blobs/:blob_id` with `Content-Type` and `Content-Length`. | Blob-heavy clients may rely on size checks or partial reads that are not available. | Either implement and test the promised HTTP behavior, or downgrade the docs to the implemented subset. |
| Adding `query.expand` to current polyfill relationships blindly would expose relations that return null/empty results. | The server filters the related stream by `foreign_key IN parent record keys`; many manifests declare belongs-to relationships where the foreign key is on the current stream instead. | First decide whether v1 supports only parent-to-child expansion or adds a `belongs_to`/reverse relation shape. |

## Implementation-ready matrix

| Area | Promised by doc/spec? | Current implementation | Current tests | Impacted assistant use case | Recommended next task | OpenSpec needed? |
| --- | --- | --- | --- | --- | --- | --- |
| Range filters | Yes. Core and Data Query API list `filter[field][gte|gt|lte|lt]`; OpenSpec notes narrow this to declared `query.range_filters`. | Implemented in `records.js`: range filters are accepted only for fields declared under `stream.query.range_filters`, only with declared operators, and only for numeric or date/date-time schemas. | `query-contract.test.js` covers declared range filtering and undeclared rejection on the reference Spotify fixture. `records-nullable-filters.test.js` covers nullable scalar/date coercion. No first-party polyfill manifest coverage. | "Show Gmail from last 7 days", "YNAB transactions over $500", "Slack messages this week", "large attachments", "recent GitHub issues". | Backfill `query.range_filters` in polyfill manifests, then add an assistant-critical manifest regression test. Use `[gte, gt, lte, lt]` for every field listed below unless a stream has a narrower reason. | No for backfill under the existing contract. Yes only if adding new operators, sort-by, aggregations, geospatial, or indexed capability guarantees. |
| Schema discoverability | Partly. Core says `GET /v1/streams` and `GET /v1/streams/{stream}` exist. Lexical/semantic specs say per-stream fields are discovered via stream metadata. | `GET /v1/streams/{stream}` returns schema, primary key, cursor field, consent time field, selection, views, relationships, query, and freshness. `GET /v1/streams` returns summaries only. Owner polyfill reads require `source.kind = "connector"` plus a connector source id; no public `/v1/connectors` exists. | `pdpp.test.js` verifies full metadata is returned even for field-limited grants. `query-contract.test.js` checks query metadata on the Spotify fixture. No public connector-discovery test. | An owner agent with only an owner token cannot enumerate available connectors or all schemas without out-of-band IDs. A client can discover grant stream names, then fetch per-stream metadata one by one. | Define the v0.1 discovery floor: either keep per-stream metadata and add public connector enumeration, or create a schema/capability endpoint. In parallel, add docs/tests that `query.search`, `query.range_filters`, and `query.expand` are the source of per-stream capability truth. | Yes for new public discovery endpoints or capability documents. No for documenting the existing per-stream metadata fields. |
| `expand[]` | Yes. Core says unknown relations return `invalid_expand`, missing child stream grant returns `insufficient_scope`, and expansions appear under `expanded`. Data Query API is stale in places. | Implemented for one-hop parent-to-child expansion with per-parent SQL windowing. Requires both `relationships[]` and `query.expand[]`. No nested expansion. No belongs-to reverse lookup. | `query-contract.test.js` covers list/detail expansion, `expand_limit`, projection, and insufficient scope on reference Spotify. No Gmail, Slack, GitHub, YNAB, or polyfill relationship tests. | "Read a Gmail message with body and attachments", "read Slack message with reactions/link previews/user/channel", "read GitHub issue with repo/PR context", "read YNAB transaction with account/payee/category". | First add a manifest relationship validator/test that every `query.expand` name has a matching relationship and that the foreign key exists on the related stream. Then backfill only safe parent-to-child relations. Separately spec or defer belongs-to expansion. | No for safe parent-to-child backfill. Yes for `belongs_to`, reverse expansion, nested expansion, or graph traversal. |
| `changes_since` | Yes, but docs conflict. Core uses `next_changes_since`; change-tracking doc says previous `next_cursor`. | Implemented as a base64 JSON opaque version cursor. Supports projection-safe deltas, tombstones, 410 expiry, pagination inside a changes session, and rejects `expand` with changes. Raw timestamps are not accepted. Normal record-list responses do not mint an initial `next_changes_since`. | `pdpp.test.js` covers projection safety, hidden-field changes, tombstones, resource-limited pagination, stale cursor 410. Tests bootstrap with a hand-built version-0 cursor. `query-contract.test.js` rejects bare `since`. | Daily digest and incremental assistant sync need a documented way to establish the first bookmark without constructing internal cursors or polling and diffing everything. | Correct docs, then choose initial bookmark contract: `changes_since=beginning`, `GET /v1/streams/{stream}/changes-cursor`, normal list terminal `next_changes_since`, or documented full-sync-then-delta flow. Do not document version-0 token construction as client API. | Yes if adding any initial-cursor or timestamp-based contract. No for doc correction to existing opaque `next_changes_since`. |
| Gmail message bodies | Manifest/docs now distinguish body content from headers. Blob note records this as separate-stream shape. | `message_bodies` stream carries `body_text`, `body_html`, size fields, body source, charset/language placeholders. It is searchable lexically and semantically on `body_text`. It is not a `blob_ref`. | Gmail connector tests cover message body emission and failure fallback. Semantic retrieval tests assert Gmail semantic fields. No RS expand test from `messages` to `message_bodies`. | "Summarize the actual email text" works if the grant includes `message_bodies` and the client queries it directly or searches it. | Add relationship/query metadata so messages can hydrate body records if v1 parent-to-child expansion is chosen. Otherwise document direct-query pattern: filter `message_bodies` by `message_id`. | No for direct-query docs and manifest range/search metadata. Yes if changing blob/content-addressing model for large bodies. |
| Attachment bytes and blobs | Core/Data Query API promise `blob_ref` and `GET /v1/blobs/{blob_id}`. Blob design note says Gmail attachments bytes are not fetched in v1. | Reference blob fetch works only for records with a visible top-level `data.blob_ref` whose blob exists in the SQLite `blobs` table. Gmail `attachments` stream has metadata fields only and no `blob_ref`; connector does not fetch MIME part bytes. | `query-contract.test.js` manually inserts a blob and proves authorization and `fetch_url` injection. No first-party connector populates Gmail attachment blobs. No HEAD/range tests. | "Open the PDF/image attached to this email" cannot work today. "Find emails with large attachments" can work after range filters on `attachments.size_bytes`. | Keep Gmail attachment metadata as done. Create a separate blob-hydration OpenSpec tranche for attachment bytes, storage topology, grant affordance, `blob_ref` shape, and HTTP blob behavior. | Yes for byte hydration and storage. No for metadata-only clarity and size/date range filters. |

## Range filter declaration audit

Current state:

- `packages/polyfill-connectors/manifests/*.json`: no streams declare `query.range_filters`.
- `reference-implementation/manifests/spotify.json`: `top_artists.source_updated_at`, `saved_tracks.saved_at`, and `saved_tracks.source_created_at` already declare `[gte, gt, lte, lt]`.
- Server behavior: exact filters are globally available on authorized top-level scalar fields, but range filters are available only where `query.range_filters` declares them.

Recommended convention for the backfill:

- Declare date/date-time windows on every honest source event time, especially `consent_time_field` and useful source-created/source-updated cursor fields.
- Declare numeric filters when the number has meaningful order semantics for assistants: money amounts, balances, sizes, durations, health metrics, counts, popularity/score fields.
- Do not declare range filters for IDs, ordinals, duplicate raw epoch fields when an ISO field exists, operational `fetched_at` unless an operator feature needs it, or latitude/longitude without a separate geospatial query design.

All fields below should use `[gte, gt, lte, lt]` unless explicitly narrowed later.

### Assistant-critical first-party streams

| Connector | Streams and missing `query.range_filters` | Exclude/defer rationale |
| --- | --- | --- |
| Gmail | `messages`: `received_at`, `date`, `size_bytes`; `threads`: `first_message_date`, `last_message_date`, `message_count`, `unread_count`, `flagged_count`; `message_bodies`: `body_text_bytes`, `body_html_bytes`; `attachments`: `message_received_at`, `size_bytes`. | Do not treat `attachments` as byte-hydrated. Do not add range filters for label counts unless a concrete assistant use case appears. |
| Slack | `messages`: `sent_at`, `reply_count`, `file_count`, `attachment_count`, `reaction_count`; `files`: `created_at`, `size`, `original_w`, `original_h`; `channels`: `created_at`, `num_members`; `canvases`: `created_at`, `updated_at`, `content_bytes`; `stars`: `starred_at`; `reminders`: `scheduled_at`, `completed_at`; `dm_read_states`: `last_read_at`, `unread_count`, `unread_count_display`; `channel_memberships`: consider `fetched_at` only for operator freshness. | Prefer ISO `*_at` over raw Slack epoch duplicates. Exclude `message_attachments.index` as an ordinal, not meaningful query scope. |
| GitHub | `repositories`: `created_at`, `updated_at`, `pushed_at`, `stargazers_count`, `forks_count`, `open_issues_count`, `watchers_count`, `size_kb`; `starred`: `starred_at`, `stargazers_count`; `issues`: `created_at`, `updated_at`, `closed_at`, `comments`, `reactions_total_count`; `pull_requests`: `created_at`, `updated_at`, `closed_at`, `merged_at`, `comments`, `reactions_total_count`, `commits_count`, `additions`, `deletions`, `changed_files`, `review_comments_count`; `gists`: `created_at`, `updated_at`, `files_total_count`, `comments_count`; `user`: `created_at`, `updated_at`, `followers`, `following`, `public_repos`, `public_gists`. | Exclude issue/PR `number` from default range filters because it is an identifier; use `created_at` for windows. Add comments/reviews streams under a separate connector coverage change if desired. |
| YNAB | `transactions`: `date`, `amount`; `scheduled_transactions`: `date_first`, `date_next`, `amount`; `accounts`: `balance`, `cleared_balance`, `uncleared_balance`, `last_reconciled_at`; `budgets`: `last_modified_on`; `categories`: `budgeted`, `activity`, `balance`, goal amount/date/progress fields; `months`: `month`, `income`, `budgeted`, `activity`, `to_be_budgeted`, `age_of_money`; `month_categories`: `month`, `budgeted`, `activity`, `balance`, goal amount/progress fields. | Exclude internal transfer/payee IDs. Be careful with deleted rows: range filtering can include deleted markers only if records remain live. |
| ChatGPT | `conversations`: `create_time`, `update_time`, `message_count_on_current_branch`; `messages`: `create_time`; `memories`: `created_at`, `updated_at`; `custom_gpts`: `created_at`, `updated_at`; `custom_instructions`: `updated_at`; `shared_conversations`: `created_at`. | Nullable timestamps are okay; server treats null/non-coercible values as non-matching. |
| Codex | `sessions`: `started_at`, `last_event_at`, `message_count`, `function_call_count`, `tokens_used`; `messages`: `timestamp`; `function_calls`: `timestamp`; `prompts`: `mtime_epoch`; `skills`: `mtime_epoch`; `rules`: `mtime_epoch`. | Exclude `rules.rule_index` as an ordinal. |
| Claude Code | `sessions`: `started_at`, `last_event_at`, `message_count`; `messages`: `timestamp`; `attachments`: `timestamp`, `content_bytes`; `skills`: `mtime_epoch`; `slash_commands`: `mtime_epoch`. | Attachment `content_bytes` is metadata size only, not a byte fetch guarantee. |

### Remaining shipped polyfill manifests

| Connector | Streams and missing `query.range_filters` | Exclude/defer rationale |
| --- | --- | --- |
| Amazon | `orders`: `order_date`, `order_total_cents`, `item_count`; `order_items`: `order_date`, `unit_price_cents`, `quantity`. | Exclude `fetched_at`. |
| Anthropic | `conversations`: `create_time`, `update_time`, `message_count`; `messages`: `create_time`; `projects`: `create_time`, `update_time`. | Same nullable timestamp handling as ChatGPT. |
| Apple Health | `records`: `start_date`, `end_date`, `value`; `workouts`: `start_date`, `end_date`, `duration_minutes`, `total_energy_burned_kcal`, `total_distance_km`. | Rich health aggregations are separate OpenSpec; this is only record filtering. |
| Chase | `transactions`: `date`, `amount`; `balances`: `as_of`, `ledger_balance_cents`, `available_balance_cents`; `statements`: `date_delivered`; `accounts`: balance/credit fields plus `balance_as_of`. | Exclude `fetched_at`. Statement bytes already use local file metadata, not RS blobs. |
| DoorDash | `orders`: `order_date`, `subtotal_cents`, `tax_cents`, `tip_cents`, `delivery_fee_cents`, `service_fee_cents`, `total_cents`, `item_count`; `order_items`: `quantity`, `unit_price_cents`. | None beyond IDs. |
| Google Takeout | `location_history`: `timestamp`, `accuracy_meters`, `velocity_mps`, `altitude_m`; `youtube_watch_history`: `watched_at`; `search_history`: `timestamp`. | Exclude latitude/longitude until a geospatial/bounding-box surface exists. |
| HEB | `orders`: `order_date`, `total_cents`, `item_count`; `order_items`: `quantity`, `unit_price_cents`. | None beyond IDs. |
| iCal | `events`: `start`. | Add `end` only if/when the manifest exposes it as a typed top-level field. |
| iMessage | `messages`: `date`. | Attachment bytes are not modeled here. |
| LinkedIn | `experience`: `start_date`, `end_date`; `education`: `start_date`, `end_date`; `skills`: `endorsement_count`. | None beyond IDs. |
| Loom | `videos`: `created_at`, `duration_seconds`, `view_count`. | Transcripts are text search, not range-filtered. |
| Meta | `posts`: `taken_at`, `like_count`, `comment_count`; `profile`: `follower_count`, `following_count`, `post_count`. | None beyond IDs. |
| Notion | `pages`: `created_time`, `last_edited_time`; `databases`: `created_time`, `last_edited_time`. | Property-schema-specific filters are out of scope. |
| Oura | `sleep`: `day` plus sleep duration, HR, HRV, temperature, efficiency, latency, score fields; `readiness`: `day`, score/temperature fields; `activity`: `day`, score/calorie/step/distance fields. | Aggregations and trend summaries are separate surfaces. |
| Pocket | `items`: `time_added`, `time_updated`, `word_count`, `reading_time_minutes`. | None beyond IDs. |
| Reddit | `submitted`: `created_utc`, `score`, `num_comments`, `upvote_ratio`; `comments`: `created_utc`, `score`; `saved`: `created_utc`. | None beyond IDs. |
| Shopify | `orders`: `order_date`, `total_cents`, `item_count`. | None beyond IDs. |
| Spotify polyfill | `saved_tracks`: `added_at`, `duration_ms`, `popularity`; `top_artists`: `popularity`, `followers`; `recently_played`: `played_at`; `playlists`: `track_count`. | Package manifest lags the reference Spotify fixture; keep them aligned if this manifest remains shipped. |
| Strava | `activities`: `start_date`, distance, time, elevation, speed, heartrate, kudos/comment/achievement fields. | Route/location geometry needs a separate surface. |
| Twitter archive | `tweets`: `created_at`, `favorite_count`, `retweet_count`, `media_count`, `url_count`; `direct_messages`: `created_at`. | None beyond IDs. |
| Uber | `trips`: `requested_at`, `started_at`, `completed_at`, `distance_meters`, `duration_seconds`, `fare_total_cents`, `tip_cents`, `surge_multiplier`. | Exclude lat/lng until geospatial predicates exist. |
| USAA | `transactions`: `date`, `amount`, `balance_after_cents`; `statements`: `date_delivered`; `inbox_messages`: `date_received`; `accounts`: `balance_cents`, `available_balance_cents`; `credit_card_billing`: balance/credit/rewards fields. | Exclude `fetched_at`; statement PDF byte hydration remains separate. |
| WhatsApp | `chats`: `first_message_date`, `last_message_date`, `message_count`; `messages`: `sent_at`. | Media attachment content is not stored. |
| Whole Foods | `orders`: `order_date`, `total_cents`, `item_count`; `order_items`: `quantity`, `unit_price_cents`. | None beyond IDs. |

## Schema discoverability detail

What consumers can discover today:

- With a client token, `GET /v1/streams` returns stream names in the grant with `record_count`, `last_updated`, and derived `freshness`.
- With a known stream name, `GET /v1/streams/{stream}` returns full stream metadata, including schema, primary key, cursor field, consent time field, views, relationships, `query`, and freshness.
- With an owner token in native mode, `GET /v1/streams` works with `source.kind = "provider_native"`.
- With an owner token in polyfill mode, every `/v1/streams...` owner query requires `source.kind = "connector"` and a single connector source id.
- `_ref/connectors` exists as a reference control surface, and AS `/connectors/:connectorId` returns a known manifest, but neither is the public RS discovery contract for a bearer.

Missing for robust assistant use:

- No public owner-token connector enumeration at `/v1/...`.
- No one-shot endpoint for all accessible stream schemas/capabilities under a bearer.
- `/v1/streams` owner polyfill lists only streams with records, not all manifest-declared streams; per-stream metadata can still retrieve a declared stream if the caller knows its name.
- Exact-filter support is not enumerated per field. Clients must know the global rule: authorized top-level scalar schema fields can be exact-filtered.
- The metadata response is full schema, not grant-field-projected schema; tests explicitly assert a field-limited grant can still see schema fields outside its projection. That may be correct for discoverability, but docs should state it.

## `expand[]` detail

Working today:

- Reference Spotify fixture: `saved_tracks` declares `relationships[].name = recently_played` and `query.expand[].name = recently_played`.
- Server hydrates list and detail responses under `expanded.<relation>`, applies child grant projection, enforces `expand_limit`, and rejects missing child stream grants.

Missing or broken for first-party polyfills:

- Gmail `messages` has no relation to `message_bodies`, `attachments`, or `threads`, and no `query.expand`. Direct queries/search are the only current path.
- Gmail `message_bodies` and `attachments` declare `message -> messages` relationships, but those are not enabled in `query.expand` and are not shaped for the current parent-to-child implementation.
- Slack `messages` declares `channel` and `author` relationships but no `query.expand`; `message_attachments` and `reactions` point back to `messages`, also with no `query.expand`.
- GitHub `issues` and `pull_requests` carry repository fields inline but no relationships to `repositories`; there are no comments/reviews streams to expand.
- YNAB has rich relationships on transactions/accounts/categories, but none are enabled in `query.expand`; many are belongs-to lookups, not parent-to-child child collection expansion.

Implementation-ready next slice:

- Add a manifest validation test that scans all first-party manifests and fails if a `query.expand` entry does not match a relationship, or if the related stream lacks the declared `foreign_key`.
- Backfill parent-to-child expansions first, such as `gmail.messages -> message_bodies`, `gmail.messages -> attachments`, `slack.messages -> message_attachments`, and `slack.messages -> reactions`, where the child stream has `message_id`.
- Treat `message -> thread`, `message -> channel`, `message -> author`, `transaction -> account/payee/category`, and `issue -> repository` as a separate belongs-to design question unless the existing relationship model is explicitly extended.

## `changes_since` detail

Actual contract:

- `changes_since` must be an opaque base64 JSON cursor with `kind: "changes_since"` and an integer `version`. Legacy `{version}` is also accepted.
- `next_changes_since` is returned on every changes response in the implementation, including paginated sessions.
- A `cursor` with `session: "changes"` pages within the same changes session and carries `since_version`, `after_version`, and `session_max_version`.
- `expand` with changes is rejected as `invalid_expand`.
- Expired history returns 410 `cursor_expired` when retained `record_changes` no longer cover the requested version.

Usability gap:

- A new client has no documented opaque initial cursor. Tests use `Buffer.from(JSON.stringify({kind:"changes_since",version:0})).toString("base64")`, which is an implementation detail, not a client contract.
- Raw timestamps do not work. `changes_since=2026-04-24T00:00:00Z` fails cursor decoding and returns `invalid_cursor`; `since=...` is rejected as an unsupported query parameter.

Recommended contract choices to evaluate:

- `changes_since=beginning` returns all visible current records and mints the first opaque bookmark.
- Normal full-list terminal pages include `next_changes_since` so a client can full-sync once, then delta-sync.
- `GET /v1/streams/{stream}/changes-cursor` returns an opaque "current high-water mark" without records.
- Timestamp input remains unsupported unless a separate OpenSpec defines snapshot semantics and privacy behavior.

## Attachment content detail

Gmail body content is not the same thing as attachment byte hydration:

- `message_bodies` is a content stream. It stores `body_text` and `body_html` inline, with byte-size metadata and `body_source`.
- `attachments` is metadata only. It stores `filename`, `content_type`, `size_bytes`, `content_id`, `is_inline`, `encoding`, `part_index`, and `message_received_at`.
- The Gmail connector does not fetch MIME part bytes, does not write the `blobs` table, and does not emit `blob_ref` on attachment records.
- The reference blob endpoint authorizes only records whose visible `data.blob_ref.blob_id` matches the requested blob. Gmail attachment records have no such field.

Recommended next split:

- Manifest/query backfill now: add range filters for `attachments.message_received_at` and `attachments.size_bytes`; clarify metadata-only status.
- Separate OpenSpec tranche later: decide blob primitive shape, storage topology, grant affordance, fetch endpoint behavior, HEAD/range support, and first connector implementation.

## Top 5 recommended fixes

1. Fix the `changes_since` docs conflict and define an initial bookmark flow. This blocks safe assistant incremental sync guidance.
2. Backfill `query.range_filters` for assistant-critical manifests, starting with Gmail, Slack, GitHub, YNAB, ChatGPT, Codex, and Claude Code.
3. Decide and validate relationship direction before enabling polyfill `query.expand`; then add parent-to-child expansions for Gmail and Slack message children.
4. Add public discovery for owner polyfill connector IDs, or explicitly choose an alternate discovery model.
5. Split Gmail attachment-byte hydration into a dedicated OpenSpec change and keep current `attachments` clearly metadata-only.

## Query-api-gap-audit verification addendum

Worker lane `query-api-gap-audit` rechecked this note from `main` at `24541ed` on 2026-04-24. The requested bug-intake precedent path `docs/inbox/connector-binding-shadow-bug-2026-04-24.md` was absent; the same note exists at `openspec/changes/add-polyfill-connector-system/design-notes/connector-binding-shadow-bug-2026-04-24.md` and was used only as process precedent.

Evidence snapshot:

| Claim | Rechecked evidence | Result |
| --- | --- | --- |
| First-party polyfill manifests do not expose range filters. | Script over `packages/polyfill-connectors/manifests/*.json` counted `query.range_filters` entries. | Every shipped polyfill manifest reported `range_fields=0`; only the reference Spotify fixture has declared range filters. |
| First-party polyfill manifests do not enable expansion. | Same manifest scan counted `query.expand` entries and `relationships`. | Every shipped polyfill manifest reported `expand=0`; several have relationships, especially Slack, YNAB, Gmail, USAA, Chase, ChatGPT/Codex/Claude Code, but none are expandable. |
| Range filtering is implementation-ready but declaration-gated. | `reference-implementation/server/records.js` validates `filter[field][gte|gt|lte|lt]` against scalar/date schemas and `manifestStream.query.range_filters`; `reference-implementation/test/query-contract.test.js` covers declared and undeclared cases. | Accurate. Backfill can be manifest/test work under the existing contract. |
| `expand[]` is parent-to-child and grant-safe today. | `normalizeExpandRequest`, `fetchExpansionChildrenGroupedByForeignKey`, list/detail tests, and insufficient-scope tests in `query-contract.test.js`. | Accurate. Do not enable belongs-to relationships until the relation direction contract changes. |
| Schema metadata is present per stream but not fully discoverable for owner polyfill callers. | `GET /v1/streams/:stream` returns `object: "stream_metadata"`, schema, primary key, cursor/consent fields, relationships, query, views, freshness; owner polyfill route resolution still requires a connector scope. | Accurate. A public owner-token connector enumeration or all-schema endpoint remains the missing discovery floor. |
| `changes_since` cannot be bootstrapped by documented client API. | `parseChangesSinceCursor` accepts opaque base64 JSON with `kind: "changes_since"`/`version`; tests hand-build version-0 cursors; `since=` is rejected; docs still contain the `next_cursor` conflict. | Accurate. This needs a docs correction plus an OpenSpec change for the initial-bookmark contract. |
| Gmail attachment content is not hydrated. | Gmail manifest exposes `attachments` metadata fields only; Gmail parser/tests cover metadata; blob authorization requires visible top-level `data.blob_ref`; attachment records do not emit it. | Accurate. Keep byte/blob hydration separate from `message_bodies`. |
| Blob docs overclaim current route behavior. | Server registers `GET /v1/blobs/:blob_id` only and sends `Content-Type`/`Content-Length`; docs mention `HEAD` and range-read guidance. | Accurate. Fix docs or implement/test the broader HTTP behavior before clients rely on it. |

Concrete follow-up OpenSpec slices recommended from this worker lane:

| Recommended change name | Task slice | Notes |
| --- | --- | --- |
| `backfill-first-party-query-range-filters` | Add `query.range_filters` to first-party manifests; add manifest validation for field existence, orderable schema type, and supported operators; add assistant-critical record-list smoke tests. | Does not need a new public filter grammar, but does change first-party manifest behavior and validator expectations. |
| `define-query-schema-discovery-floor` | Choose public owner-token connector enumeration plus existing per-stream metadata, or a one-shot schema/capability endpoint; correct stale stream metadata docs. | Required before assistant clients can self-discover polyfill connector IDs and stream capabilities without out-of-band IDs. |
| `enable-safe-parent-child-expand` | Validate `query.expand` against relationships and child foreign keys; enable only safe parent-to-child joins first, especially Gmail `messages -> message_bodies/attachments` and Slack `messages -> reactions/message_attachments`. | Belongs-to/reverse/nested graph expansion should stay deferred unless explicitly specified. |
| `define-initial-changes-bookmark` | Correct `next_cursor` vs `next_changes_since` docs; define a first-bookmark flow such as `changes_since=beginning`, a changes-cursor endpoint, or terminal `next_changes_since` on full-list responses. | Do not expose or document internal version-0 cursor construction as client API. |
| `hydrate-gmail-attachment-blobs` | Add attachment byte download, content-addressing, `blob_ref`, grant affordance, extracted-text decision, and blob HTTP behavior tests. | Keep separate from the metadata-only attachment and `message_bodies` work. |

## Validation plan for implementation slices

- Manifest backfill: add a manifest-level test that all declared `query.range_filters` fields exist, are orderable, and use supported operators; add assistant-critical query smoke tests for Gmail, Slack, GitHub, and YNAB.
- Expand backfill: add manifest validator/test for relationship plus query.expand consistency; add RS tests using first-party Gmail and Slack manifests and synthetic records.
- Discovery: add owner-token polyfill tests proving a caller can enumerate connector IDs and then fetch stream metadata without out-of-band knowledge.
- Changes: add tests for the chosen initial cursor flow and a test proving raw timestamp input is either rejected with documented error or supported by the new contract.
- Blobs: add HTTP behavior tests for whichever blob contract is accepted, including auth, headers, and large-object storage assumptions.
