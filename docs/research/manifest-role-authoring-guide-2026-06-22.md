# Manifest role-authoring guide — full SLVP-ideal pass (2026-06-22)

ABD goal: author `x_pdpp_role` (+ `x_pdpp_type` where money) on ALL 18 of the owner's LIVE connectors so Explore rows show real content, not "Id: <uuid>". Grounded in `docs/research/record-presentation-ideal-2026-06-22.md` (the tiered authorship model) + the Codex-gated rules from the chatgpt/gmail pilot. Target dir: **`packages/polyfill-connectors/manifests/`** (this is what the live console feed reads — rs-client.ts:157; NOT reference-implementation/manifests/).

## The 18 live connectors (manifest filenames)
amazon, chase, chatgpt*, claude_code*, codex*, github, gmail*, google_maps, google_maps_data_portability, notion, oura, reddit, slack, spotify, strava, usaa, whatsapp, ynab
(* = already partially authored; github roles exist only in ref-impl/manifests, NOT the live polyfill copy — must be added there too.)

## The role vocabulary (the ONLY valid values — others were pruned)
`primary-title` | `secondary` | `event-time` | `actor` | `amount`
- `primary-title` = the row headline (real content a human recognizes).
- `secondary` = body/subtitle/supporting content.
- `actor` = who (author/sender/payee).
- `amount` = money slot (pair with x_pdpp_type for formatting).
- `event-time` = ONLY for genuine EVENT-kind streams (calendar/appointments) where the displayed time-of-day is a card detail. DO NOT put event-time on message/transaction streams — it's inert there (consumed only by buildEventPreview/kind=event) and duplicates the displayAt axis (cursor_field/consent_time_field). [Codex event-time check, 2026-06-22]

## x_pdpp_type (only where money; dates use JSON Schema "format":"date-time", not a type)
`currency`/`currency_minor_units`/`cents` (integer cents ÷100) · `currency_milliunits`/`milliunits` (÷1000, e.g. YNAB). Put on the SAME field that gets the `amount` role.

## HARD RULES (Codex-gated, non-negotiable — these are the honesty boundary)
1. **Declare roles ONLY on fields that actually exist** in that stream's schema.properties. Inspect each schema first.
2. **primary-title = the meaningful HUMAN field**, never an id/uuid/foreign-key. If the only "name-like" field is an id, declare NOTHING (leave honest-generic) — do NOT promote an id to a title.
3. **STOP-CONDITION — telemetry/system/inventory streams get NO roles.** Any stream that is operational metadata (coverage_diagnostics, *_inventory, config_*, cache_*, logs, session_index, shell_snapshots, file_history, debug_artifacts, downloads, backup_inventory, channel_stats, user_stats, account_stats, memberships, read_states, dm_read_states, observed_on-style stat streams, balances/account snapshots without a human label) STAYS honest-generic. Do not force a title to prettify.
4. **NO field-name guessing as a mechanism** — you (the author) choose the role per real schema knowledge; the renderer never guesses. This is manifest-authored, the trusted path.
5. **amount needs both** the `amount` role AND the `x_pdpp_type` (currency/milliunits) — a currency field is NOT the amount just because it's currency.
6. **One primary-title per stream** (the strongest single declaration). secondary/actor are optional adds.

## Per-connector authoring intent (author verifies each field EXISTS first)
- amazon/orders, order_items → primary-title=item/product title or order description; secondary=merchant/total; amount+type on price if present.
- chase/usaa transactions → amount (+type) on amount field; secondary=merchant/description/payee; actor=payee. accounts/statements/balances/*_stats → likely NO human title (stop-condition; balances/stats are telemetry).
- ynab transactions → amount(+milliunits type); secondary=payee_name/memo; payees→primary-title=name; categories/category_groups→primary-title=name; months/month_categories/accounts→stop-condition unless a clear name field.
- github/repositories → name→primary-title, description→secondary (the pilot — add to the POLYFILL copy); issues/pull_requests→title→primary-title, body→secondary; gists→description; starred→repo name; user→login/name.
- gmail (done: messages subject/from_name; message_bodies body_text) → verify threads→subject, labels→name.
- notion/pages, databases → primary-title=title/name.
- reddit/submitted,comments,saved,etc → primary-title=title (submissions) or body (comments); actor=author; secondary=subreddit.
- slack/messages → primary-title=text, actor=user/username; channels→name; users→real_name/name; files→name/title. message-stat/membership/read-state streams→stop-condition.
- spotify/saved_tracks,recently_played,top_artists,playlists → primary-title=track/artist/playlist name; actor=artist; secondary=album.
- strava/activities → primary-title=name; secondary=type/distance; (no amount).
- oura/sleep,readiness,activity → these are daily-metric records; primary-title likely a day/score label OR stop-condition if no human title (lean stop-condition — they're metrics, render honest-generic with the day; don't fabricate).
- whatsapp/imessage messages → primary-title=text/body, actor=sender.
- google_maps, google_maps_data_portability, google_takeout → inspect; place/visit name→primary-title if present, else stop-condition.
- chatgpt/codex/claude_code (mostly done: messages content/role) → verify conversations/sessions→title; the many telemetry streams (inventory/diagnostics/logs/skills/memory_notes/etc.) → stop-condition.

## Gate (per the ABD)
Each connector: JSON valid, roles only on existing fields, reconcile-manifests test green, role values ∈ the 5-value vocabulary, NO roles on telemetry streams. Then combined: tsc, the manifest-role + declared-role + record-preview tests, openspec --strict, lint. Codex end-review against these rules. Deploy + live re-walk: rows for each connector show real content or honest-generic (never a fake-titled id). >95% Claude+Codex confidence it's the SLVP-ideal.
