# ChatGPT GitHub Slack Coverage Audit

Status: decided-defer
Owner: worker lane connector:chatgpt-github-slack
Created: 2026-04-25
Updated: 2026-04-25
Related: openspec/changes/add-polyfill-layer-two-stream-coverage

## Question

Which ChatGPT, GitHub, and Slack Layer 2 streams are already covered by manifests, collectors, and non-live tests, and which remaining items require live authentication or a new scoped stream proposal?

## Context

This worker lane was scoped to ChatGPT, GitHub, and Slack only. It could update the Layer 2 coverage task list and make one bounded non-live connector/test improvement, preferring parser/manifest/test coverage over new live scraping behavior.

## Stakes

Marking a stream done without runnable evidence would overstate reference connector coverage. Conversely, leaving already-shipped streams unchecked keeps the OpenSpec backlog stale and makes future worker lanes duplicate audit work.

## Current Leaning

ChatGPT's `custom_gpts`, `custom_instructions`, and `shared_conversations` are shipped enough for this change: they are manifest-declared, schema-validated, collector-backed, and now have fake-API integration coverage for the non-live endpoints that were missing emit-path tests.

GitHub's `issues`, `pull_requests`, and `gists` are shipped enough for the current task. `followers` and `following` are profile count fields on the existing `user` stream, not standalone relationship streams. Adding row-level follower/following streams should be a follow-up because it changes manifest shape and needs live token verification for pagination and scope behavior.

Slack v0.3.0 has shipped archive-backed `reactions`, `message_attachments`, and `canvases`. `stars`, `user_groups`, and `reminders` are intentionally manifest-declared but unavailable in slackdump archive mode, with runtime `SKIP_RESULT` behavior. Filling them requires an API fallback that calls Slack Web API methods not used by slackdump archive.

## Promotion Trigger

Promote a follow-up OpenSpec change before adding standalone GitHub follower/following relationship streams or a Slack API fallback for stars, user groups, or reminders, because those changes would alter connector manifest contracts and live-auth behavior.

## Decision Log

- 2026-04-25: Marked ChatGPT, GitHub evaluation, and Slack audit tasks complete with evidence notes.
- 2026-04-25: Added bounded ChatGPT fake-API integration coverage for `custom_gpts` and `shared_conversations`; no live scraping behavior changed.
- 2026-04-25: Deferred standalone GitHub follower/following relationship streams and Slack API-only streams to future scoped live-auth work.
