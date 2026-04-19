# ChatGPT connector — design notes

**Status:** design captured 2026-04-19 overnight.
**Source:** ChatGPT backend-api audit subagent 2026-04-19; prior art at `~/code/data-connectors/openai/chatgpt-playwright.js`.

## Auth
- **Shared Playwright persistent profile.** Cookie-driven session; user logged in during bootstrap.
- Extract bearer token at run start from `#client-bootstrap` JSON in page DOM.
- Extract device ID from `oai-did` cookie.
- Token lifetime ~30 days (verify via JWT `exp` claim). If expiry < now+5min, stop and emit `INTERACTION kind=manual_action` with a link to chatgpt.com.

## Critical: TLS fingerprint preservation
All fetches to `/backend-api/` MUST go through `page.evaluate(fetch)` inside the browser context. Node.js fetch will be 403'd by Cloudflare. Non-negotiable.

## Streams

### `conversations` (`mutable_state`, primary_key `["id"]`, consent_time_field `"create_time"`)
- `id` (UUID)
- `title`
- `create_time` (ISO 8601)
- `update_time` (ISO 8601; cursor field)
- `is_archived` (boolean)
- `is_starred` (boolean)
- `workspace_id` (nullable; enterprise)
- `current_node` (the "tip" of the conversation tree)
- `message_count_on_current_branch`
- `gizmo_id` (nullable, foreign key to `gizmos`)

### `messages` (`append_only`, primary_key `["id"]`, consent_time_field `"create_time"`)

Note: semantics = `append_only`. A message node in ChatGPT's tree doesn't mutate once written; new user prompts create new children. However, the *path from root to current_node* can change if the user regenerates. For v1 we emit only messages on the current branch.

- `id` (message node UUID)
- `conversation_id` (foreign key)
- `parent_id` (nullable; allows tree reconstruction even though we emit only current branch)
- `children_ids` (array; informational — which siblings exist on alt branches)
- `role` (`user` / `assistant` / `system` / `tool`)
- `content` (text; joined from `content.parts[]`)
- `content_type` (`text` / `multimodal_text`)
- `model_slug` (nullable; e.g. `gpt-4o`, `gpt-5.4`)
- `create_time` (ISO 8601)
- `finish_reason` (nullable; `stop` / `tool_calls` / `length`)
- `citations` (array of `{url, index_start, index_end, text}`; nullable)
- `tool_calls` (array of `{name, arguments}`; nullable)
- `attachment_ids` (array of file IDs; nullable)
- `on_current_branch` (boolean; `true` for all v1-emitted messages)

### `memories` (`mutable_state`, primary_key `["id"]`, consent_time_field `"created_at"`)
- `id`
- `content`
- `created_at`
- `updated_at`
- `type` (default `"memory"`)

**Gotcha:** API doesn't emit deletion events. Connector compares against previous state to detect deleted memories, emits as tombstones.

### `gizmos` (`mutable_state`, primary_key `["id"]`, consent_time_field `"created_at"`)
- `id`
- `name`
- `description`
- `access` (`private` / `shared_link` / `public`)
- `instructions` (system prompt)
- `tools` (array of tool specs)
- `created_at`, `updated_at`

Captures custom GPTs the user has created.

### `files` (`append_only`, primary_key `["id"]`, consent_time_field `"created_at"`)
- `id`
- `name`
- `size`
- `mime_type`
- `created_at`
- `origin_conversation_id` (nullable)
- `origin_message_id` (nullable)

Metadata only. Byte download deferred.

### `models` (`mutable_state`, primary_key `["id"]`)
- `id` (model slug)
- `name` (display)
- `type` (`chat` / `gpt4` / `custom_gpt`)
- `available_to_tier`
- `context_window`
- `knowledge_cutoff` (nullable)

Reference data. Refreshed once per day.

## Tree flattening policy (autonomous 2026-04-19)

Emit only messages on the **current branch** (root → current_node path per `conversation.mapping`). This matches the prior art and the user's visible UI. Store `parent_id` and `children_ids` so a consumer can reconstruct the full tree if they ever want to. If audit later shows alt branches matter, flip to emitting all nodes and use `on_current_branch` flag to distinguish. Easy reversal.

## Incremental sync
- **Global cursor:** `last_seen_update_time` per conversation.
- **Flow:**
  1. `GET /backend-api/conversations?offset=0&limit=100&order=updated` — iterate until the first conversation with `update_time <= last_seen_update_time`.
  2. For each new/updated conversation, `GET /backend-api/conversation/{id}` and walk the tree.
  3. Update per-conversation cursor: `{ conversation_id: { update_time, current_node } }`.

## Rate limiting
- 5 concurrent conversation detail fetches via `Promise.all`.
- 200 ms delay between batches.
- 30 s timeout per detail fetch.
- On 429 or Cloudflare challenge: exponential backoff (2, 4, 8 s, max 16 s), abort conversation after 3 retries.

## Memory tombstone strategy
Memories don't have a delete event. Connector reads prior-run memory IDs from state, computes diff, emits tombstones for IDs no longer present.

## Explicit non-goals v1
- File byte downloads (metadata only).
- Generated image bytes.
- Real-time streaming events (only post-completion state).
- Custom instructions endpoint (unverified; punt to v2 if endpoint confirmed).
- Workspace member lists (enterprise-only).
- Usage/billing data.
- Plugin/action execution logs.

## Risks / open questions
- [?] Exact endpoint for custom instructions — unconfirmed. May require DOM scraping /settings.
- [?] Archived conversations: does `/conversations` default include them or do we need `?is_archived=true`?
- [?] Shared conversations: does the API expose share metadata or only the content?
- [?] Token refresh — does cookie-driven refresh work silently or does expiry always force re-auth?

Testing tonight will answer these empirically; answers get folded back here.
