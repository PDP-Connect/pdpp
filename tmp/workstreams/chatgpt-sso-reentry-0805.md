# ChatGPT SSO re-entry repair

## Change

On credentialless MANUAL repair only, the ChatGPT browser flow now clicks a
single visible accessible `Continue with Google` or `Sign in with Google`
control when present. It then checks ChatGPT's `/api/auth/session` probe and
polls until that endpoint returns a user. Duplicate/ambiguous controls, Google
account-selection or interaction pages, and changed UI fall back to the
existing owner-assisted browser flow. Stored username/password repair is
unchanged. Scheduled repair remains fail-closed before login or owner prompts.

## Exact files

- `packages/polyfill-connectors/src/auto-login/chatgpt.ts`
- `packages/polyfill-connectors/src/auto-login/chatgpt.test.ts`
- `tmp/workstreams/chatgpt-sso-reentry-0805.md`

## Tests and checks

- Passed: `pnpm --dir packages/polyfill-connectors exec node --test --import tsx src/auto-login/chatgpt.test.ts src/auto-login/chatgpt-login-flow.test.ts` — 24 passed.
- Passed: `pnpm --dir packages/polyfill-connectors typecheck`.
- Passed: scoped `ultracite check` for both changed TypeScript files.
- Passed: `pnpm --dir packages/polyfill-connectors check` — 489 files checked.
- Package `verify` was not fully green because its existing no-`await` conformance check reports 75 unlisted findings and 72 stale allowlist entries across the package, including pre-existing ChatGPT polling locations. This change did not alter that allowlist.

## Existing behavior retained

The current code already used `/api/auth/session` as the sole terminal
authentication predicate, had bounded session polling, blocked interactive
repair for scheduled/non-manual triggers, and offered owner-assisted browser
repair when no stored credential was available. The change adds only the safe
Google-provider attempt inside that existing credentialless manual branch.

## Residual risks

- ChatGPT or Google can change accessible names, routes, or authentication
  sequencing; selector miss or unexpected UI fails safe to owner assistance.
- Google account choice, approval, OTP, passkey, Cloudflare, or other
  interaction is not automated and may require the existing owner handoff.
- No live browser, real account, deployment, or production auth predicate was
  exercised.

Commit: `fix(chatgpt): reuse Google SSO during manual repair` (signed, with `Assisted-by: AI`).
