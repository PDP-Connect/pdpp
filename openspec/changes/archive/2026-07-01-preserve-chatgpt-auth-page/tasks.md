## 1. Runtime Contract

- [x] Add the opt-in browser runtime configuration field.
- [x] Select a reusable non-blank page only for opted-in connectors.
- [x] Skip remote-CDP pre-attach page cleanup only for opted-in connectors.
- [x] Preserve the run page only after successful opted-in runs.
- [x] Keep failure cleanup and default connector cleanup unchanged.

## 2. ChatGPT Adoption

- [x] Enable the preserved-page runtime policy for the ChatGPT connector.

## 3. Validation

- [x] Add runtime unit tests for page selection and close policy.
- [x] Run targeted polyfill connector tests.
- [x] Run `openspec validate preserve-chatgpt-auth-page --strict`.
- [x] After deployment, verify one ChatGPT approval unblocks an immediate follow-up run without another approval prompt.

Live evidence, 2026-07-01:

- Owner-attended ChatGPT repair run `run_1782872690957` completed at
  `2026-07-01T02:29:37.461Z` and collected records after the owner completed
  the secure-browser login flow.
- Immediate follow-up run `run_1782873029952` completed at
  `2026-07-01T02:30:44.645Z` with no owner interaction and
  `api_session_user=true`, proving that the repaired live browser process could
  be reused without another owner approval prompt.
