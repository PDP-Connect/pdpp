# Stealth Validation Scripts

Diagnostic scripts that exercise the n.eko Patchright stealth stack against
the running Chromium target. These are not unit tests — they require a live
neko container with Chromium attached, reachable at `$PATCHRIGHT_CDP`
(default `http://neko:9223`).

## Running from inside the reference container

```bash
docker compose --env-file .env.docker exec reference sh -c '
  cd /app/reference-implementation && node scripts/stealth/<script>.mjs
'
```

## Scripts

- **`fingerprint-probe.mjs`** — Raw CDP read of the highest-signal
  bot-detection values (`navigator.webdriver`, WebGL renderer, etc.). Use
  to verify the binary + launch-arg layer of stealth in isolation. Bypasses
  Patchright; useful when debugging "did the right binary boot?"

- **`patchright-canary.mjs`** — Attaches via `chromium.connectOverCDP` and
  verifies: (1) the cdp-proxy.py rewrite lets discovery succeed; (2)
  `addInitScript` injects into main world via Patchright's Route mechanism;
  (3) `navigator.webdriver === false`; (4) WebGL renderer is reported.
  Exits non-zero if any step fails.

- **`turnstile-check.mjs`** — Loads `chatgpt.com/auth/login` and reports
  whether Cloudflare Turnstile presents a challenge. We cannot solve the
  checkbox programmatically (synthesizing input through the Patchright
  driver would re-trigger detection), but we can verify that we get the
  login page back rather than a "verify you are human" interstitial.

## Architecture being validated

```
[reference container]
  └── patchright.chromium.connectOverCDP(http://neko:9223)
        └── cdp-proxy.py [rewrites webSocketDebuggerUrl]
              └── ws://127.0.0.1:9222 (Chromium 147 — Patchright's binary)
                    └── X server :99 (neko)
                          └── WebRTC mux → user's browser
```

See `docs/patchright-integration-spec.md` for the Patchright internals
research, and `docs/neko-adapter-refactor-spec.md` for the planned migration
of the streaming-companion adapter from raw CDP to Patchright APIs.
