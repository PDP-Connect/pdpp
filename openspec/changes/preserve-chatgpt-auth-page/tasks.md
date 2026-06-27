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
- [ ] After deployment, verify one ChatGPT approval unblocks an immediate follow-up run without another approval prompt.
