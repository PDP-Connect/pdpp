## Decision

Terminal facts are a separately owned durable component. Generic canonical
repair does not advance its checkpoint, so a fleet-wide terminal high-water
cannot be a generic repair reason. The terminal fold already scopes its own
high-water to the maintenance page and persists its own resume checkpoint.

For bounded maintenance, one cooperative absolute deadline is passed through
every repair and fold phase. Existing evidence rows receive the first finite
terminal-event batch before generic repair. A page without evidence may repair
at most its explicit small cold-row candidate cap; if a started repair unit
uses the remaining time, terminal folding resumes next round from the row's
durable evidence and checkpoint. No new repair or fold batch starts after the
deadline, although a single started SQL unit may finish cooperatively. The
same deadline is checked before every independent participant checkpoint CAS:
expiry stops the write tail, returns incomplete, and leaves unwritten durable
checkpoints eligible for the next scoped fold. No extra page cursor or durable
scheduler state is introduced.

## Observability

Each bounded-page receipt records aggregate participant count, finite event
work actually read, old and new minimum checkpoint, repair duration, and
whether an incomplete fold made zero checkpoint progress. It does not invent a
per-phase time budget. These values contain no owner, connection, cursor,
credential, or event payload data.

## Acceptance checks

- A 25-row first page with 274 terminal events advances durable fold
  checkpoints before deliberately slow generic repairs on SQLite and a real
  disposable PostgreSQL database.
- A later terminal event on another page does not rewrite current page-one
  evidence through generic repair.
- Restart/resume retains the existing lease and cursor fencing behavior.
- One-millisecond cold and 2,001-event rounds start no post-expiry unit and
  converge from existing durable state in later rounds.
- A delayed checkpoint-write trigger proves an expired fold starts at most one
  already-entered participant CAS and resumes the remaining participants.
