# Cookbook example — first-party expand

Status: decided
Date: 2026-04-24

## Slack messages with link previews and reactions

After this change lands, an assistant with a grant on `messages`,
`message_attachments`, and `reactions` can hydrate both child collections
in one read:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$RS/v1/streams/messages/records\
?connector_id=$(jq -rn --arg s 'https://registry.pdpp.org/connectors/slack' '$s|@uri')\
&order=desc\
&expand=message_attachments\
&expand=reactions\
&expand_limit[message_attachments]=10\
&expand_limit[reactions]=25"
```

Each record carries an `expanded.message_attachments` and
`expanded.reactions` list, projected through the child grants. `has_more`
reflects whether the per-parent limit truncated the list. The child
records are sorted by the child stream's declared `(cursor_field,
primary_key)` basis, exactly as direct list reads would be.

## Reverse / belongs-to relations are intentionally deferred

Several first-party manifests declare descriptive relationships from
child to parent (e.g. `slack.messages.channel`, `slack.reactions.user`,
`ynab.transactions.account`). These are **not** expandable through
`query.expand` and the engine will reject them with `invalid_expand`.

This is by design:

- The current expansion engine only supports parent-to-child joins
  where `child[foreign_key] == parent.record_key`. Reverse relations
  carry the FK on the current record and need a different lookup
  shape, with its own grant projection and pagination story.
- A reverse-lookup contract requires deciding what happens when the
  related record is missing, deleted, or outside the grant time range.
- A reverse-lookup contract must also decide whether the related
  record's child collections are in scope (which slides quickly into
  nested expansion territory).

Until that contract is specified and tested, callers should fetch the
parent record directly:

```bash
# Look up the channel for a Slack message:
curl -H "Authorization: Bearer $TOKEN" \
  "$RS/v1/streams/channels/records/$CHANNEL_ID?connector_id=...&fields=id,name,is_private"
```
