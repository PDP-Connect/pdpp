## 1. X11 and launch configuration

- [x] 1.1 Add the 915x412 Xorg mode to the shared n.eko image.
- [x] 1.2 Derive Chromium's default launch dimensions from `NEKO_DESKTOP_SCREEN`.
- [x] 1.3 Gate selected-screen reporting and frame promotion on the container's live Chromium-window size acknowledgement.

## 2. Regression coverage

- [x] 2.1 Assert the static and dynamic paths use the shared image configuration containing both phone modes.
- [x] 2.2 Assert cover-fit selection chooses portrait and rotated landscape phone modes.
- [x] 2.3 Assert a blocked window resize prevents phone-frame promotion until acknowledgement, and assert the terminal baseline restore separately from the two selection posts.

## 3. Validation

- [x] 3.1 Run `openspec validate add-neko-phone-screen-modes --strict`.
- [x] 3.2 Run the touched RI tests and Compose validation.

## Acceptance checks

1. `node --test server/streaming/neko-adapter.test.js test/neko-surface-allocator.test.js test/neko-surface-allocator-server.test.js test/run-interaction-stream-neko-compose.test.js`
2. `docker compose -f docker-compose.yml -f docker-compose.neko.yml --profile neko-dynamic config >/dev/null`
