## Context

The ChatGPT connector emits `conversations` from the list endpoint and emits `messages` by fetching each conversation detail. A conversations-only run intentionally avoids detail fetches and records list-only conversation rows. The same `conversations.last_update_time` cursor currently controls later message-detail fetches, so enabling `messages` after a conversations-only run can skip older parents.

The live Redactable conversation reproduced this state: the parent conversation exists, its detail-derived fields are null, and `messages` filtered by that conversation id returns zero.

## Goals / Non-Goals

**Goals:**

- Make message-detail progress independent from the parent conversation cursor.
- Preserve parent-first record emission and fail-closed detail behavior.
- Add a regression that models "conversations-only first, messages later".

**Non-Goals:**

- Do not change ChatGPT record schemas or public query semantics.
- Do not add reverse expansion from `conversations` to `messages`.
- Do not backfill production data in this change; the next ChatGPT messages run should do that through normal connector collection.

## Decisions

- Use `state.messages.last_update_time` as the detail cursor for the ChatGPT `messages` stream. This keeps child-stream completeness tied to child-stream collection, not to whether the parent stream was previously listed.
- Keep `state.conversations.last_update_time` for the parent stream. Conversations-only runs can keep advancing that cursor without claiming child-message detail coverage.
- When both streams are requested, fetch details for conversations newer than the message-detail cursor. That can re-emit older conversation parents with detail fields if the parent stream is also requested; this is an intentional repair of prior list-only rows.
- Emit `DETAIL_COVERAGE` and `STATE stream="messages"` only after required detail work settles. The existing `STATE stream="conversations"` remains after parent-list emission for the parent cursor.

## Risks / Trade-offs

- First `messages` run after existing conversations-only history can fetch many details. Mitigation: the existing adaptive detail lane, pressure gaps, and coverage events already bound and report this work.
- Re-emitting conversation records with detail fields can update existing parent rows. Mitigation: this is the desired repair path for list-only parents; downstream storage already upserts by primary key.
