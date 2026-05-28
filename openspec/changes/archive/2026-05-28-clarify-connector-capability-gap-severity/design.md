## Context

Slack declares four streams that slackdump archive mode does not collect: `stars`, `user_groups`, `reminders`, and `dm_read_states`. The connector emits `SKIP_RESULT` with `reason: "not_available"` for those streams. The runtime stores every skip as a known gap, and connector health treats any known gap on a succeeded run as degraded.

That behavior is honest at the event level but misleading at the product level. It fails to distinguish:

- capability: what a connector mode can collect;
- selection: what the owner/run requested;
- outcome: what happened during this run.

Mature integration systems make that distinction. Unsupported or unselected streams should not look like failed selected streams.

## Goals / Non-Goals

**Goals:**

- Make connector health reflect actionable degradation, not expected limitations.
- Represent stream availability as manifest metadata.
- Classify gaps by severity/reason class.
- Keep existing `SKIP_RESULT` compatibility while giving the runtime better semantics.
- Make Slack green when the only gaps are expected slackdump-mode limitations.

**Non-Goals:**

- Do not implement Slack API fallback in this change.
- Do not hide limitations from detail views.
- Do not make all source-specific partial data semantics part of Collection Profile.
- Do not change public records/search APIs.

## Decisions

### 1. Add Stream Availability Metadata

Connector manifests should be able to mark a stream as:

- `supported`
- `unsupported_in_mode`
- `experimental`
- `deprecated`

For Slack, the four slackdump-only gaps are `unsupported_in_mode` for mode `slackdump_archive`. Unsupported-in-mode streams should not be requested by default for that mode.

### 2. Classify Known Gaps By Severity

Known gaps should carry a class that the dashboard and health projection can interpret:

- `informational`: expected limitation, user-disabled stream, out-of-scope stream.
- `transient`: rate limit, temporary unavailable, upstream pressure.
- `actionable`: selected data was not delivered and requires owner/operator/developer action.
- `recoverable`: detail-gap/backlog semantics with an explicit recovery path.

Existing historical gaps without a class should be treated conservatively as actionable until migrated or superseded by a newer run.

### 3. Compute Health From Outcome, Not Gap Count

The connector-health classifier should not use non-empty `known_gaps` as a direct degraded signal. It should degrade only when the latest relevant run has actionable/transient gaps, auth/setup problems, stale freshness, or failure state.

Informational gaps remain visible in detail views but do not color the connector yellow.

### 4. Keep Slack Fallback Separate

Slack API fallback is valuable for `stars`, `reminders`, and possibly `user_groups`, but it is a separate enhancement. This change only makes current slackdump-mode status honest.

## Risks / Trade-offs

- [Risk] Informational gaps hide real missing data.
  - Mitigation: informational severity is only for unselected, user-disabled, or manifest-declared unsupported-in-mode streams; selected unsupported streams become actionable unless the selection explicitly accepts the limitation.
- [Risk] Historical runs remain ambiguous.
  - Mitigation: default unclassified historical gaps to actionable, and let a new successful run with classified informational gaps clear the false yellow state.
- [Risk] The manifest model becomes too detailed.
  - Mitigation: only stream-level availability and optional mode/reason metadata, not a capability DSL.

## Migration Plan

1. Add manifest schema support for stream availability metadata.
2. Mark Slack's four slackdump-unavailable streams as unsupported in `slackdump_archive` mode.
3. Add gap severity classification in runtime known-gap construction.
4. Update health and dashboard partial-coverage logic to ignore informational gaps for degraded status.
5. Preserve detail-view visibility for informational limitations.
