## ADDED Requirements

### Requirement: Gmail attachment backfill is explicit and gap-aware

The reference implementation SHALL provide an explicit Gmail attachment backfill path for historical mail that is independent of the normal `messages` stream cursor. The implementation SHALL NOT claim complete Gmail attachment hydration merely because new-message sync hydrates attachments.

#### Scenario: Attachment hydration is enabled after message state advanced

- **WHEN** Gmail `messages.all_mail.uidnext` has advanced past historical messages that contain attachments
- **AND** an operator requests Gmail attachment backfill
- **THEN** the reference SHALL revisit the historical All Mail UID range needed for the `attachments` stream without rewinding the normal `messages` cursor
- **AND** it SHALL emit attachment records with populated `blob_ref` for bytes that Gmail still makes accessible

#### Scenario: Attachment backfill is interrupted

- **WHEN** a Gmail attachment backfill run stops before completing the historical UID range
- **THEN** the reference SHALL preserve enough `attachments` stream state to resume from the last durably completed window
- **AND** it SHALL NOT mark an unprocessed UID range as complete

#### Scenario: Attachment bytes cannot be fetched

- **WHEN** a historical Gmail attachment is inaccessible, too large, malformed, throttled, or otherwise cannot be hydrated
- **THEN** the reference SHALL preserve a metadata attachment record with a truthful `hydration_status`
- **AND** any diagnostic field or timeline summary SHALL be bounded and SHALL NOT include attachment bytes, source credentials, or secret download material

### Requirement: Gmail attachment blob persistence is idempotent

Gmail attachment hydration and backfill SHALL persist bytes through the existing content-addressed blob substrate. Reprocessing an already hydrated attachment SHALL preserve stable record identity and SHALL NOT duplicate blob bytes.

#### Scenario: Historical attachment is backfilled twice

- **WHEN** the same historical Gmail attachment bytes are processed by two attachment backfill runs
- **THEN** the emitted attachment record id SHALL remain stable
- **AND** the `blob_ref.blob_id` SHALL remain the same content-addressed blob id
- **AND** the blob store SHALL preserve at most one byte payload for that blob id while allowing idempotent record bindings

#### Scenario: Incremental and backfill hydration overlap

- **WHEN** a Gmail attachment is hydrated during normal incremental sync and later appears in an attachment backfill window
- **THEN** the later backfill SHALL treat the existing hydrated blob as already satisfied or re-emit the same stable blob reference
- **AND** it SHALL NOT create a conflicting attachment record for the same Gmail message part

### Requirement: Gmail attachment hydration preflight and coverage are operator-visible

The reference Docker path SHALL make Gmail attachment hydration prerequisites and coverage gaps visible before reporting success.

#### Scenario: Blob upload configuration is missing

- **WHEN** Gmail attachment hydration or backfill is requested in Docker without required blob upload configuration such as `PDPP_RS_URL` and `PDPP_OWNER_TOKEN`
- **THEN** the reference SHALL fail preflight with an actionable error before doing mailbox work
- **AND** it SHALL NOT report the Gmail run as complete attachment hydration

#### Scenario: Gmail attachment backfill completes with partial gaps

- **WHEN** a Gmail attachment backfill run completes with some attachments not hydrated
- **THEN** the run output or reference-only run timeline SHALL expose a non-secret gap summary that distinguishes hydrated, too large, failed, unavailable or skipped, and remaining historical gap counts
- **AND** it SHALL NOT include an `already_hydrated` count unless existing blob or record state is measured directly
- **AND** the summary SHALL be sufficient for an operator to know that "all mail" is not fully byte-hydrated

#### Scenario: Docker proof validates historical rehydration

- **WHEN** the documented Docker acceptance path is run with Gmail credentials and a historical attachment-bearing message
- **THEN** the reference SHALL demonstrate that the historical attachment can be discovered through Gmail records, expanded through `expand=attachments`, and fetched through the grant-visible `blob_ref.fetch_url`
- **AND** if the proof cannot run because env or credentials are missing, it SHALL report the exact missing prerequisite instead of producing a false-success result
