## 1. Envelope

- [x] 1.1 Replace `specversion: "1.0-pdpp"` with `specversion: "1.0"` everywhere the envelope is written.
- [x] 1.2 Add a `pdppversion: "1"` CloudEvents extension attribute to every envelope.
- [x] 1.3 Centralize envelope construction in `buildEventPayload(eventId, derivedEvent)` exported from `operations/as-client-event-subscriptions/index.ts`; replace the three inline writers in the operation and the one in `server/index.js`.

## 2. Signing

- [x] 2.1 Rewrite `signEvent` / `verifySignatureHeader` in `operations/rs-client-event-deliver/index.ts` to sign `{webhook-id}.{webhook-timestamp}.{body}` and emit `v1,<base64>`.
- [x] 2.2 Decode `whsec_`-prefixed secrets as base64 keys before HMAC (`decodeWebhookSecret`); fall back to UTF-8 bytes for unprefixed test secrets.
- [x] 2.3 Replace `PDPP-Event-*` request headers in the delivery worker with `webhook-id`, `webhook-timestamp`, `webhook-signature`. Drop the `PDPP-Subscription-Id` header.
- [x] 2.4 Issue subscription secrets with the `whsec_` prefix and 32 random bytes encoded base64.

## 3. Discovery

- [x] 3.1 Update `buildClientEventSubscriptionsCapability` (`server/metadata.ts`) — both the TypeScript type and the runtime value — to publish the CloudEvents 1.0 envelope, the `pdppversion: "1"` extension, and the Standard Webhooks signing profile.

## 4. Tests

- [x] 4.1 Update `test/rs-client-event-deliver-operation.test.js` for the new signing primitives and headers; add a rotation-tolerance assertion; assert legacy headers are absent.
- [x] 4.2 Update `test/as-client-event-subscriptions-operation.test.js` to assert the new secret prefix and envelope fields.
- [x] 4.3 Update `test/client-event-subscriptions-e2e.test.js` receiver and verifier to read `webhook-*` headers and verify against the Standard Webhooks signing construction, then assert the envelope carries `specversion: "1.0"` / `pdppversion: "1"`.
- [x] 4.4 Update the discovery test to assert the Standard Webhooks profile fields and the CloudEvents 1.0 envelope fields.

## 5. Validation

- [x] 5.1 `pnpm exec openspec validate align-client-event-subscriptions-with-webhook-standards --strict` → "is valid".
- [x] 5.2 `pnpm exec openspec validate --all --strict` → 139 passed, 0 failed.
- [x] 5.3 Targeted `node:test` suites pass: `rs-client-event-deliver-operation.test.js`, `as-client-event-subscriptions-operation.test.js`, `rs-client-event-derive-operation.test.js`, `client-event-subscriptions-e2e.test.js` (31 tests, 0 failures).
- [x] 5.4 `pnpm exec tsc --noEmit` in `reference-implementation/` → no errors found.
