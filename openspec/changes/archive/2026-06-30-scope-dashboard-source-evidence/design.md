## Context

The owner-facing goal for Sources is: "I know what data I have, I know what is broken, and I know what to do next." That fails when the console mixes connector type identity (`amazon`, `chase`) with configured source identity (`connector_instance_id` / `connection_id`).

Observed live failure classes:

- Many Amazon connections share fallback labels, so connector-type pages and actions are ambiguous.
- A Chase browser-surface run is stored under connector-level spine identity and a browser profile key that does not match the visible Chase connection, yet the connector-key page can present it as source detail.
- Runs pages and source detail pages can link to `/dashboard/records/<connector_id>` even when the user clicked an action about one configured connection.

## Decision

Use configured connection identity as the dashboard source identity. A card, CTA, detail page, or recovery action that claims to be about one source must carry the exact connection route id. Connector-wide evidence can remain available for debugging, but it must be labeled as connector-wide or omitted from source-specific summaries.

This is deliberately a correctness-first tranche. It does not solve every Sources visual-design issue. It removes the class of false specificity that makes later visual work untrustworthy.

## Alternatives

- Keep connector-type fallback and improve labels: rejected because it still lets sibling run evidence appear on a source page.
- Delete duplicate configured sources automatically: rejected because multiple accounts/devices are legitimate and deletion would be destructive.
- Build a full new Sources IA first: rejected for this tranche because exact attribution is a prerequisite and can be verified independently.

## Acceptance Checks

- Multi-connection connector types do not silently route `/dashboard/records/<connector_id>` to an arbitrary configured connection.
- Recovery CTAs and Runs cards for one source link to `/dashboard/records/<connection_id>`.
- Source detail recent-run evidence is built from exact connection summary evidence, not connector-wide run lists.
- Connector-wide runs remain accessible only from neutral/global surfaces or clearly connector-wide links.
- Tests cover duplicate Amazon-style source rows and Chase-style connector-keyed run evidence that must not be attributed to a mismatched source.
