# Audit — first-party manifest relationships

Status: decided
Date: 2026-04-24

## Method

For every manifest under `packages/polyfill-connectors/manifests/`, scanned each
stream for `relationships[]` entries and `query.expand[]` entries. For each
relationship, checked whether the declared `foreign_key` exists as a top-level
property on the **related** stream's schema (the engine join requirement —
parent record key joins against `child[foreign_key]`).

## Already shipped (kept intact)

- `gmail.messages -> message_bodies` (has_one, fk on child `messages_bodies.message_id`)
- `gmail.messages -> attachments` (has_many, fk on child `attachments.message_id`,
  default_limit=10, max_limit=50)

## Newly enabled in this change

These are the only first-party relations that satisfy the engine's parent-to-
child shape (parent stream declares the relationship; FK is a top-level property
on the child stream):

- `slack.messages -> message_attachments` (has_many, fk=`message_id` on child)
- `slack.messages -> reactions` (has_many, fk=`message_id` on child)

Both child streams already require `message_id` and emit it as a top-level
string. Both ride the same `messages.sent_at` timeline so child grant
projection and consent_time filtering remain meaningful.

Note: the parent-side `relationships[]` entries are added in this change. The
existing `message_attachments.message -> messages` and `reactions.message ->
messages` declarations on the child streams are left in place as descriptive
metadata; they are not enabled through `query.expand` because they are reverse
(belongs-to) relations.

## Deferred — reverse / belongs-to (FK on the current record, not on the related stream)

Every other declared relationship across first-party manifests is reverse. The
current engine cannot serve them, and this change does not add a reverse-lookup
contract.

| Connector | Stream | Relationship | Reason deferred |
| --- | --- | --- | --- |
| amazon | order_items | order -> orders | fk `order_id` lives on order_items, not on orders |
| anthropic | messages | conversation -> conversations | fk on parent record |
| chase | transactions, statements, balances | account -> accounts | belongs-to |
| chatgpt | messages, shared_conversations | conversation -> conversations | belongs-to |
| claude_code | messages, attachments | session -> sessions | belongs-to |
| codex | messages, function_calls | session -> sessions | belongs-to |
| doordash | order_items | order -> orders | belongs-to |
| heb | order_items | order -> orders | belongs-to |
| loom | transcripts | video -> videos | belongs-to |
| slack | channel_memberships | channel/user | belongs-to |
| slack | messages | channel/author | belongs-to (channel/user lookup) |
| slack | message_attachments | message | belongs-to |
| slack | reactions | message/user | belongs-to |
| slack | canvases | channel/author | belongs-to |
| slack | dm_read_states | channel | belongs-to |
| usaa | transactions, statements, credit_card_billing | account -> accounts | belongs-to |
| whatsapp | messages | chat -> chats | belongs-to |
| ynab | accounts/categories/payee_locations/transactions/scheduled_transactions/month_categories | budget/payee/category/account/group/etc. | belongs-to |

## Rejected candidates

- `slack.messages -> files`: `files` is keyed by file id, but the
  message↔file edge does not exist as a top-level FK on `files`. Slack files
  are referenced through `message.has_files` and a separate (not currently
  modeled) join table. The engine cannot serve this until either an explicit
  edge stream is added or a reverse-lookup contract exists.
- `slack.channels -> messages`, `slack.channels -> channel_memberships`,
  `slack.channels -> canvases`, `slack.channels -> dm_read_states`: technically
  satisfy the parent-to-child shape (channel id is a top-level FK on each
  child), but were rejected for this tranche because:
  - `channels -> messages` is the most-loaded fan-out in the entire corpus and
    needs a dedicated cardinality / pagination review;
  - the others are operationally low-value compared to the engineering cost of
    enabling them on every channels read;
  - they can be added in a follow-up tranche once the `messages -> children`
    shape is in production and we have a usage signal.
- `slack.users -> reactions`, `slack.users -> channel_memberships`,
  `slack.users -> canvases (author)`: same argument; user-fanout is huge and
  the reactions/memberships streams are usually read directly, not through
  user expansion.
- All YNAB `*-by-budget` relations: technically parent-to-child for
  `budgets -> accounts/categories/...`, but the YNAB connector is small enough
  that callers can read each stream directly. Holding until there is demand.
