## ADDED Requirements

### Requirement: Reference Spine Operator Read Operations

The reference implementation SHALL expose owner-only operator-console reads of the disclosure spine — correlation lists, per-correlation event timelines, and the spine artifact-jump search — through canonical operation modules before host route adapters shape HTTP responses.

#### Scenario: Spine correlation list operation preserves route behavior

**WHEN** the `/_ref/traces`, `/_ref/grants`, or `/_ref/runs` route serves an owner-authenticated request
**THEN** it SHALL delegate correlation summary envelope assembly to a boundary-checked `ref.spine.correlations.list` operation module
**AND** SHALL preserve the per-kind `trace_summary` / `grant_summary` / `run_summary` discriminator in each `data` entry
**AND** SHALL preserve the `{object: 'list', data, has_more}` envelope with `next_cursor` emitted only when present.

#### Scenario: Spine events page operation preserves route behavior

**WHEN** the `/_ref/traces/:traceId`, `/_ref/grants/:grantId/timeline`, or `/_ref/runs/:runId/timeline` route serves an owner-authenticated request
**THEN** it SHALL delegate timeline envelope assembly to a boundary-checked `ref.spine.events.page` operation module
**AND** SHALL preserve the kind-specific `object` discriminator (`trace` / `grant_timeline` / `run_timeline`), the identifying `*_id` key, the derived `trace_id`, the `event_count`, and the `truncated` / `next_cursor` / `limit` pagination fields
**AND** SHALL NOT echo the live bearer literal `token_id`, the `pending_consent` or `owner_device_auth` `object_id` literal, or the `device_code` / `user_code` / `request_uri` keys inside event `data` — these MUST be stripped or replaced with redaction sentinels by the operation.

#### Scenario: Spine search operation preserves route behavior

**WHEN** the `/_ref/search` route serves an owner-authenticated request
**THEN** it SHALL delegate spine artifact-jump response shaping to a boundary-checked `ref.spine.search` operation module
**AND** SHALL preserve the `{object: 'search_result', exact, traces, grants, runs}` envelope with the per-bucket summary discriminators applied to each entry.
