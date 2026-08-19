# A healthy source that had never collected its own history

**Status:** found and repaired on the live instance 2026-08-19.

## What it looked like

ChatGPT (dondo) read **Healthy**. Fresh evidence, current freshness, no gaps,
nothing outstanding. It held 1,100 conversations.

A separate connection — one of three "historical archive" instances the owner
did not recognise and asked to have deleted — held 1,920 conversations for the
same account.

Every one of the live connection's 1,100 conversations exists in the archive.
The archive holds 820 the live one does not, including **825 conversations from
2023**, the oldest history on the instance. The split is clean at conversation
granularity: of 31,857 archive messages absent from live, all 31,857 belong to
conversations absent from live, and the count of "conversation present but
message missing" is exactly zero.

So the archive was not a duplicate of the live source. The live source was a
**subset of the archive**, and the archive was the only copy of 820
conversations.

## Why

`connector_state` for the live connection:

```json
conversations: {"last_update_time": "2026-06-19T20:30:04.127Z"}
messages:      {"last_update_time": "2026-06-19T20:30:04.127Z"}
```

That timestamp is the archive's newest conversation, and the minute the archive
instance was created. The live connection was seeded from the archive and
inherited its high-water mark.

The connector pages conversations by descending `update_time` and stops at the
cursor. A cursor set to the seed's newest record therefore means *everything
older than the seed is unreachable, forever*, while every subsequent run
completes successfully and reports complete coverage — because it did process
everything it fetched.

The year distribution shows the boundary rather than random loss: 2024 and 2025
are 100% covered (818/818, 164/164); 2023 is 39 of 826.

## Why nothing caught it

Coverage evidence compares `covered` against `considered`, and `considered` is
the size of the batch the run's own window returned
(`connectors/gmail/index.ts:883` is the clearest instance:
`{ considered: metas.length, covered: count }`). So `covered == considered`
asserts *"I processed everything I fetched"*, never *"I fetched everything that
exists"*. Fleet-wide, 82 of 83 streams satisfy that equality essentially by
construction.

A cursor that excludes history is invisible to a completeness check defined
relative to what the cursor selected. The measurement is downstream of the bug.

## The repair

Rewound `last_update_time` on both streams to `2020-01-01`, after backing the
prior state up. The next scheduled run walks the full history and re-collects
the missing conversations **from the provider**, which is better than merging
the archive: it restores the data at its source instead of reparenting rows
whose keys, cursors and evidence would then need reconciling.

Checked the rest of the fleet: only ChatGPT uses `last_update_time`, and the
other ChatGPT account's cursor is current. This was specific to the seeded
connection.

## What to keep from this

**A cursor inherited from a seed is not a resume point.** Seeding copies data
forward and the cursor forward with it, which silently redefines "everything
before the seed" as out of scope. If a connection is ever populated from
another source, its cursor must be set to the beginning of the desired history,
not to the seed's high-water mark — or the seeding must be recorded so the
gap is visible.

And the general form, which is the more important one: **a completeness metric
computed relative to a window cannot detect a wrong window.** Until coverage
can compare against a provider-side total (IMAP `UIDNEXT`, a conversation
count, an API-reported total), green means the narrower claim, and the product
should not imply otherwise.

## Related

`ingest-503-never-retried-2026-08-19.md` — a different silent loss, recoverable
because checkpoints never advanced past the failure.
`list-page-loses-unfillable-proof-2026-08-19.md` — evidence stranded from its
consumers.
