## Why

Source webhook ingress used the event id as the durable idempotency key, but did not bind that event id into the HMAC signed material. A captured valid body and timestamp could therefore be replayed within the tolerance window with a fresh event id.

## What Changes

- Bind `PDPP-Webhook-Event-Id` into the source webhook HMAC signed material before timestamp and body.
- Update the reference operation, local route/test signers, and source-webhook architecture requirement together.
- Add an operation regression test that rejects a signature replayed under a different event id.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

- Affects only reference-only source webhook ingress at `POST /_ref/source-webhooks/:sourceId`.
- Does not change outbound Standard Webhooks client-event delivery.
