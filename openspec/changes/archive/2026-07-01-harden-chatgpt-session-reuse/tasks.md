## 1. Runtime lifecycle

- [x] Add opt-in failed-page preservation to browser runtime config.
- [x] Keep default cleanup behavior unchanged.
- [x] Enable failed-page preservation only for ChatGPT.

## 2. ChatGPT auth refresh

- [x] Prefer the current ChatGPT session endpoint token before DOM bootstrap fallback.
- [x] Keep one-shot 401 reauth bounded.
- [x] Keep browser-context auth extraction independent of Node/bundler helper symbols.

## 3. Tests and validation

- [x] Add focused runtime tests.
- [x] Add focused ChatGPT auth-refresh test.
- [x] Add regression coverage that auth extraction is sent as a literal browser expression.
- [x] Add managed n.eko Chrome policy coverage for browser-session restart restore.
- [x] Add ChatGPT browser-login assistance coverage proving owner-completed login auto-resumes without an explicit interaction response.
- [x] Add dashboard stream coverage proving no-response browser-surface assistance opens the streaming companion without a submit/continue control.
- [x] Add streaming-route coverage proving no-response browser-surface assistance can mint from a ready browser-surface lease without a pending interaction.
- [x] Run focused tests.
- [x] Run `openspec validate harden-chatgpt-session-reuse --strict`.
- [x] Live-prove owner-attended repair followed by immediate no-owner-action reuse on the same n.eko browser process.
- [x] Live-prove forced n.eko restart does not preserve ChatGPT API-session auth; document this as a residual risk instead of a closeout criterion.
- [x] Deploy the browser-login auto-resume fix and run an owner-attended repair validation before closing the change.

Live evidence, 2026-07-01:

- Owner-attended ChatGPT repair run `run_1782872690957` completed at
  `2026-07-01T02:29:37.461Z` and collected records after the owner completed
  the secure-browser login flow.
- Immediate follow-up run `run_1782873029952` completed at
  `2026-07-01T02:30:44.645Z` with no owner interaction and
  `api_session_user=true`, proving same-browser-process session reuse.
- Forced browser-process restart probe `run_1782873061583` lost
  ChatGPT API-session auth and requested interaction, so post-restart
  API-session survival remains the explicit residual risk documented in the
  design.
