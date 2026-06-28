## 1. Runtime lifecycle

- [x] Add opt-in failed-page preservation to browser runtime config.
- [x] Keep default cleanup behavior unchanged.
- [x] Enable failed-page preservation only for ChatGPT.

## 2. ChatGPT auth refresh

- [x] Prefer the current ChatGPT session endpoint token before DOM bootstrap fallback.
- [x] Keep one-shot 401 reauth bounded.

## 3. Tests and validation

- [x] Add focused runtime tests.
- [x] Add focused ChatGPT auth-refresh test.
- [x] Run focused tests.
- [x] Run `openspec validate harden-chatgpt-session-reuse --strict`.
- [ ] Deploy and run owner-attended immediate + one-hour ChatGPT validation before re-enabling schedule.
