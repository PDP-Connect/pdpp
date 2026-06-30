# Design: surface-grant-client-metadata

## Context

`/_ref/grants` and `/_ref/traces` are operator-console summaries over disclosure-spine correlations. They are reference-only, but they are the substrate for the dashboard's relationship and recent-read views. The owner needs a human-recognizable client label when the server has one, and the raw `client_id` must remain visible because client names are client-authored metadata, not independent proof of identity.

## Decision

For grant and trace summaries, attach an optional `client` object:

```ts
{
  client_id: string;
  client_name: string | null;
  registration_mode: string | null;
}
```

The object is populated from the registered OAuth client row for the page's `client_id` values. Missing rows omit the object and the console falls back to the raw `client_id`.

The console displays `client.client_name` as the primary label when present and keeps `client_id` as identity text where the row has a secondary identity slot. It does not replace `client_id` in the reference response or hide provenance.

## Alternatives

- **Console-only rename from owner-issued tokens:** tried first. It is harmless but insufficient because live grant clients are not necessarily present in the owner-issued-token list.
- **Fetch each grant or trace timeline:** rejected. It adds N+1 reads, still may not contain display metadata, and makes an overview depend on detail timelines.
- **Hide raw `client_id`:** rejected. CIMD and dynamic-registration names are client-authored claims, so the identity anchor must remain visible.

## Acceptance Checks

- `/_ref/grants` and `/_ref/traces` include `client.client_name` for summaries whose `client_id` has a registered OAuth client row.
- The operator console relationship row uses that name and still preserves the raw `client_id`.
- The operator console recent-read row uses that name instead of making the raw `client_id` the primary label.
- Missing metadata continues to render the raw `client_id`.
- Existing grant summary consumers that ignore unknown fields continue to work.
