# GroupMe resumable pagination

## Decision

Keep GroupMe collection checkpoints on `commit_on_success` until the
connector has a separately proven recovery-progress protocol.

GroupMe message endpoints paginate newest-first with `before_id`. The API does
not provide a stable snapshot token or an incremental `since` cursor. A
`before_id` therefore identifies a position in one traversal; it does not prove
that all records before or after that position have been observed.

Persisting a partially completed traversal as the authoritative stream cursor
could skip records when:

- new messages arrive at the head while collection is running;
- groups or direct chats are added, removed, or reordered;
- different conversations reach different pagination positions; or
- a restart resumes from one saved position without revisiting the moving head.

Durably ingested records survive an interrupted run. What remains uncommitted
is the cursor and complete-coverage claim. Repeating provider reads and
idempotent upserts after interruption is inefficient, but it is preferable to
silently omitting owner data.

## Terminal direction

A future resumable implementation must keep two facts separate:

1. **Recovery progress:** per-conversation traversal state that may be saved
   after a completed page.
2. **Coverage proof:** evidence emitted only after every conversation in the
   declared boundary has been enumerated successfully.

Recovery must always revisit the newest page and continue until it overlaps a
previously observed stable identity before using older saved `before_id`
positions. It must also define how newly discovered and removed conversations
affect the traversal. A page number or a single global `before_id` is not an
acceptable recovery cursor.

Before replacing `commit_on_success`, tests must demonstrate no omissions when
messages arrive during a run, conversations change between runs, the process
crashes after any page, and recovery is repeated. Until those invariants are
proven against the provider behavior, the conservative full-pass checkpoint is
the correct design.
