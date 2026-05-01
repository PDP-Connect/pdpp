## 1. Error Contract

- [x] Add `request_id` to the OAuth error schema.
- [x] Update OAuth error writing to include a request id and header.

## 2. Tests And Docs

- [x] Add route tests covering DCR, device authorization, and token errors.
- [x] Document OAuth vs PDPP error envelope policy.

## 3. Checks

- [x] Run targeted OAuth metadata/error tests.
- [x] Run reference implementation validation.
- [x] Run reference contract validation.
- [x] Run `openspec validate add-oauth-error-request-ids --strict`.
