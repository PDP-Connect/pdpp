# Semantic Field Coverage Audit — 2026-04-24

## Why this note exists

Tasks 1.2, 3.1, and 3.3 of `make-semantic-retrieval-operational` require:

- an audit of where `query.search.semantic_fields` currently lives in the
  first-party set
- honest additions for top-level natural-language string fields
- an explicit record of exclusions so future readers understand why a field
  that *looks* natural-language is not declared.

This note captures the audit output and the selection rules. It is not a
spec; it is a design record for the reference operators who will later add,
remove, or adjust fields.

## Starting state

Before this change:

- Zero manifests under `packages/polyfill-connectors/manifests/` declared
  `query.search.semantic_fields`.
- The native-only `reference-implementation/manifests/reddit.json` declared
  it for `posts` and `comments`, but this manifest is a native fixture, not
  a shipped first-party polyfill.
- `configureSemanticBackend(makeStubBackend())` ran on every boot, the
  semantic advertisement reported `supported: true`, and `index_state`
  resolved to `"built"` because the `semantic_search_meta` table was empty.
- Net effect for any reviewer walking through the reference: semantic
  retrieval was advertised, the endpoint was wired, and every real search
  returned an empty `data` array. The honesty failure was inside the
  corpus, not inside the API surface.

## Validator alignment (load-bearing, easy to miss)

The lexical validator accepts nullable strings via
`isTopLevelSearchableStringField()` — it admits `type: "string"` and
`type: ["string", "null"]`. The semantic validator was stricter: it
required `fieldSchema?.type === 'string'` exactly. That was a divergence
from the block comment directly above it, which said "Same v1 shape
constraints as lexical_fields". The semantic spec language ("top-level
scalar string fields defined by the stream's schema") does not require
rejection of nullable strings, and the index rebuild loop already skips
rows where the field value is actually null.

The divergence was load-bearing because almost every natural-language
field in the first-party polyfill set is declared as
`type: ["string", "null"]`: Gmail `subject`/`snippet`/`body_text`, GitHub
issue and PR `body`, Slack `messages.text`, ChatGPT `messages.content`,
Claude Code message `content`, and so on. With the strict validator, an
honest audit would have produced a handful of marginal single-word `name`
fields and nothing else.

Action taken: align the semantic validator with `isTopLevelSearchableStringField()`
and update its comment to match reality. The comment now also points
readers at the `rebuildSemanticIndexForStream` null-skip guard so it is
clear null values are handled at index time, not validator time. No public
spec change; this is a reference-implementation validator cleanup that
brings the semantic path into parity with the lexical path and with the
"Same v1 shape constraints as lexical_fields" the comment already
promised.

## Selection rules applied

For every first-party polyfill manifest, a field was declared in
`query.search.semantic_fields` only if ALL of the following held:

1. It is top-level in `schema.properties` (not nested, not an array).
2. Its declared type is `string` or `["string", "null"]` (strict-spec
   nullable is fine; arbitrary union types are not).
3. Its value at ingest time is natural-language content, not an
   identifier, enum, URL, path, hash, email, phone number, branch name,
   date string, currency code, or status code.
4. Including it does not obviously embed PII that cannot already be
   inferred from the stream's description. Email addresses, personal
   names, street addresses, account nicknames, and similar identifiers
   are excluded even where they happen to be free-text — semantic
   retrieval of those fields is low-signal, and the payoff does not
   justify the default-embedding risk.
5. The field earns its keep semantically. One-word name-like fields
   (playlist name, product name) were typically excluded because the
   stub backend's exact-match reflexivity + lexical retrieval already
   covers them, and a full transformer embedding of a single product
   name is not where operational semantic retrieval shines.

## Connectors that now declare `semantic_fields`

The full list of additions, one line per stream:

- **gmail**
  - `messages.subject`, `messages.snippet`
  - `threads.subject`
  - `message_bodies.body_text`
- **github**
  - `user.bio`
  - `repositories.description`
  - `starred.description`
  - `issues.title`, `issues.body`
  - `pull_requests.title`, `pull_requests.body`
  - `gists.description`
- **slack**
  - `channels.topic`, `channels.purpose`
  - `messages.text`
  - `message_attachments.title`, `message_attachments.text`, `message_attachments.fallback`
  - `canvases.title`, `canvases.content_markdown`
  - `user_groups.description`
  - `reminders.text`
- **chatgpt**
  - `conversations.title`
  - `messages.content`
  - `memories.content`
  - `custom_gpts.display_description`, `custom_gpts.display_welcome_message`, `custom_gpts.instructions`
  - `custom_instructions.about_user`, `custom_instructions.response_style`
  - `shared_conversations.title`, `shared_conversations.highlighted_text`
- **claude_code**
  - `messages.content`
  - `attachments.content_preview`
  - `skills.description`, `skills.content`
  - `slash_commands.description`, `slash_commands.content`
- **codex**
  - `sessions.title`, `sessions.first_user_message`
  - `messages.content`
  - `rules.rule_text`
  - `prompts.description`, `prompts.content`
  - `skills.description`, `skills.content`
- **reddit** (polyfill, distinct from the native fixture)
  - `submitted.title`, `submitted.selftext`
  - `comments.body`
  - `saved.title`, `saved.body`
- **chase**
  - `transactions.memo`
- **usaa**
  - `transactions.description`, `transactions.original_description`
  - `inbox_messages.subject`, `inbox_messages.preview`
- **ynab**
  - `accounts.note`, `category_groups.note`, `categories.note`
  - `transactions.memo`
  - `scheduled_transactions.memo`
  - `months.note`, `month_categories.note`

## Exclusions and why

The manifests below were intentionally left without any
`query.search.semantic_fields` in this pass. Each case is documented so
a future contributor does not re-open the question without new evidence.

- **amazon** — every NL-looking field (`recipient_name`,
  `shipping_address_summary`, `status_detail`, `payment_method_summary`,
  `order_items.seller`) is either PII (addresses, recipient names) or
  identifier-like. `order_items.name` is strict string but most product
  names are short identifier-ish strings, not sentences; low semantic
  payoff.
- **anthropic** — the only string fields are `id` and `projects.name`.
  Project names are too short to embed usefully.
- **apple_health** — `records.type` is an enum-like identifier
  (`HKQuantityTypeIdentifierBodyMass`), dates are dates, no NL body fields.
- **doordash / heb / wholefoods / shopify** — all three follow the same
  `orders` / `order_items` shape. `order_items.name` is the only
  candidate; names are mostly short product identifiers with low
  semantic-retrieval payoff. Re-evaluate if we later ingest item
  `description`-style fields.
- **google_takeout** — all three streams are event logs (location,
  youtube watch history, search history) with dates and ids. No NL body
  fields at the declared schema level.
- **ical / imessage / whatsapp** — current manifests expose only
  timestamps, ids, and stream-name strings. `imessage.messages` and
  `whatsapp.messages` carry no `text`/`body` field in the v1 schema. Add
  coverage when those fields are added to the manifest.
- **linkedin** — current schemas expose only ids and a skill `name`.
  The stream is intentionally thin; profile summary / experience bodies
  are not in the manifest schema yet.
- **loom** — `transcripts` and `videos` are schema stubs (ids only).
  Semantic coverage is pointless until real transcript content lands.
- **meta** — same story: `profile.username` and `posts.id` are
  identifiers; post body is not in schema.
- **notion** — `pages` and `databases` schemas only expose ids. Body
  content is out of current scope; add coverage when it lands.
- **oura** — numeric metrics, no NL.
- **pocket** — `items.url` is an identifier, not NL; title is not
  declared in the current schema.
- **spotify** — `playlists.description` is nullable-string and was
  considered. Left out this pass because user playlists rarely carry a
  description, and the other string fields (track/album/playlist names)
  are short identifiers where semantic retrieval does not pay off. Revisit
  if usage data shows description is widely populated.
- **strava** — `activities` schema exposes ids and start_date only.
- **twitter_archive** — `tweets` and `direct_messages` schemas expose
  ids and timestamps only; content body is not declared.
- **uber** — `trips.id` only.
- **chase.accounts / chase.statements / chase.balances** — fields are
  `name`/`type`/`status`/`title`/`account_reference`. All identifier or
  enum-shaped.
- **usaa.accounts / usaa.statements / usaa.credit_card_billing** — same
  identifier/enum pattern as chase.
- **ynab.budgets / ynab.accounts (name) / ynab.payees / ynab.payee_locations**
  — budget/account/payee names are short identifiers, not sentences.
  Locations are numeric lat/long.
- **github.user fields** other than `bio` — `login`, `name`, `company`,
  `location`, `blog`, `twitter_username` are identifier/PII.
- **gmail.labels / gmail.attachments** — label names are
  identifier-like; attachment filenames are identifier-like and sometimes
  leak sensitive filenames. Exclude by default.
- **slack.workspace / slack.channels.name / slack.users / slack.files /
  slack.message_attachments.author_name / slack.message_attachments.service_name**
  — identifier, PII, or enum-shaped. `users.*` in particular would
  effectively embed a workspace directory, which is PII-heavy for low
  query payoff.
- **chatgpt.messages.role / .model_slug / .finish_reason /
  custom_gpts.display_name / .author_name / .category /
  shared_conversations.title (bot-generated enum share titles)** —
  enums, identifiers, or short tags.
- **claude_code.sessions.*** — cwd, paths, version, user_type,
  entrypoint, git_branch are identifiers.
- **codex.function_calls** — `name` (tool identifier), `arguments`
  (structured JSON-ish), and `output_preview` (can carry shell output,
  file contents, or secrets). `output_preview` was the borderline call;
  excluded by default because tool outputs are the most likely place for
  secrets to appear, and the user can always re-enable via a custom
  manifest.
- **codex.sessions.*** non-title fields — identifiers and enums
  (originator, model_provider, git_branch, cwd, sandbox_policy,
  approval_mode).

## What this change deliberately does NOT do

- Does not touch the public spec. The `query.search.semantic_fields`
  shape, independence from `lexical_fields`, and snippet-safety rules are
  unchanged.
- Does not expose per-stream semantic coverage in the RS metadata
  document. Aggregate diagnostics live under the `/dashboard/deployment`
  page in later slices of this change (tasks 2.x, 7.x).
- Does not select a default language bias or a multilingual model. That
  is task 5.x, handled in a later slice.
- Does not add any transformer or embedding dependency. The stub backend
  is still the default; `rebuildSemanticIndexForStream` only sees the new
  fields once a backend is present, which is already the current
  invariant.

## Honesty checks added

- `reference-implementation/test/semantic-retrieval.test.js`
  "shipped gmail manifest contributes semantic coverage after reconcile
  without record re-ingest" — regression that loads the real shipped
  `gmail.json`, confirms it declares semantic_fields on `messages`,
  seeds realistic rows against a stripped copy (no semantic_fields),
  asserts baseline zero hits, then re-registers the shipped manifest
  (the reconcile path) and asserts the same query now finds the
  historical row without re-ingest.
- The existing `backend identity change flips index_state to stale` test
  already pins the stale-then-rebuild behavior for operator-owned model
  changes, which is the companion operational guarantee.
