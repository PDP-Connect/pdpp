## Context

`connector_instances.status` admits `active`, `paused`, `revoked`, `draft`. Before this change, `paused` was reachable only by data transplant or direct SQL, and escapable only through `resumePausedConnectionAfterCredentialCapture` — a side effect of the static-secret credential-capture route.

The owner asked for pause and resume directly, and two stranded production connections proved the state needed a real exit, not just an entrance.

## Goals

- One coherent state machine: `active <-> paused`, `revoked -> active` via reactivate.
- Wrong-state refusals are typed and distinguishable, never a generic inactive error.
- A paused connection is visible in the console and carries its own way back.

## Decisions

### Pause ships as an owner action

The alternative was to ship resume alone (enough to rescue the stranded rows) and defer pause until an owner asked twice. Rejected: a state that can be left but not entered is exactly the incoherence that produced this defect, and the state, the storage constraint, and the owner-facing spec language for it already existed. Shipping resume alone would have left `paused` reachable only by transplant — still a trapdoor, just a monitored one.

Pause is genuinely distinct from revoke and not redundant with it. Revoke means "stop collecting and treat the authorization as withdrawn". Pause means "stop collecting, keep the credential, resume when I say". A source you can pause without re-authorizing is the feature the owner named.

### Pause and resume are zero-cascade

Both are pure status flips on the connector-instance row, matching revoke/reactivate. Neither touches records, credentials, grants, schedules, or the spine. Pause deliberately does NOT revoke the credential — retaining it is the entire difference from revoke, and it is what makes resume a single click rather than a re-authorization.

### Wrong-state refusals get their own codes

The namespace resolver reports any status mismatch as `connector_instance_inactive` (400). Both routes re-label it: resume against a non-paused target returns `connector_instance_not_paused` (409); pause against a non-active target returns `connector_instance_not_active` (409). This mirrors reactivate's existing `connector_instance_not_revoked` and lets a caller distinguish "wrong state" from "no such connection" without parsing prose.

### The explicit owner route is not restricted by binding kind; the automatic hooks still are

The shared `applyResume` primitive takes an optional `requireSourceBindingKind`. The automatic resume hooks — credential capture and run admission — pass `historical_archive`, keeping the implicit, non-owner-initiated path as narrow as it was. The explicit owner routes pass nothing: when the owner clicks Resume, the binding kind is not the server's business, and restricting it would have re-created the trap for every other paused connection.

### Credential freshness is delegated to the next run

Resume does not validate or supply a credential, matching reactivate. A resumed connection whose credential has expired surfaces a typed credential error on its next run through the existing health projection. Validating at resume time would duplicate that machinery and could refuse a resume the owner legitimately wants (for example, a file-import connection that authenticates to nothing).

### A missing import directory is an infrastructure fault, not owner data loss

`isManualUploadBinding` returning null for an unusable binding meant the run silently received no import-dir env var and reported `source_incomplete` — which reads as "your archive was incomplete" when the truth is "this server was told to read a path that is not on this disk". The resolver now stats the directory and throws `manual_upload_import_dir_missing` naming the path, the env var, and the connection. This is the silence that let two intact archives sit unnoticed.

## Risks / Tradeoffs

- **Pause could be mistaken for revoke.** Mitigated by console copy stating that data and the credential are retained, and by keeping the two actions visually and textually distinct.
- **A paused connection stops collecting silently.** Mitigated by rendering `paused` as a first-class status and surfacing the connection with a Resume action rather than hiding it as revoked connections are hidden.
- **Statting the import directory adds a filesystem call per manual-upload run.** Negligible against a run that then reads the archive, and it converts a silent misattribution into an actionable error.

## Acceptance Checks

- Resuming a paused connection returns 200 and the row becomes `active`; a second resume returns `connector_instance_not_paused` (409).
- Pausing an active connection returns 200 and the row becomes `paused`; a second pause returns `connector_instance_not_active` (409).
- Pause and resume leave record counts, credentials, grants, and schedules unchanged.
- A paused connection renders a `paused` status and a Resume action in the console.
- A manual-upload run whose `import_dir` is absent fails with `manual_upload_import_dir_missing` naming the missing path and env var.
- A transplanted `historical_archive` binding is not claimed by the manual-upload resolver.
