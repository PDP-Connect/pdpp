## 1. Implementation

- [x] 1.1 Add a ChatGPT `messages` detail cursor independent from `conversations.last_update_time`.
- [x] 1.2 Preserve parent-first conversation/message emission and existing detail-gap recovery behavior.
- [x] 1.3 Emit message detail coverage and `STATE stream="messages"` only after message-detail work settles.

## 2. Tests

- [x] 2.1 Add a regression for conversations-only collection followed by messages collection.
- [x] 2.2 Keep existing ChatGPT connector integration and cursor tests green.

## 3. Validation

- [x] 3.1 Run targeted ChatGPT connector tests.
- [x] 3.2 Run relevant polyfill connector tests or type checks when practical.
- [x] 3.3 Run `openspec validate fix-chatgpt-message-detail-cursor --strict`.
