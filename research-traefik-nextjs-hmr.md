# Traefik 3.6 + Next.js 16 dev HMR WebSocket — best-practice fix

## Verdict

**Recommended fix (sustainable, idiomatic):**

1. On the **Traefik** side, give the HMR endpoint its own router that:
   - matches `Host(...) && PathPrefix(\`/_next/webpack-hmr\`)`,
   - has **higher `priority`** than the main app router,
   - is attached to **no auth/forward-auth/headers middleware** (any middleware that
     can short-circuit with `401`/`Unauthorized` is the prime suspect for the
     "malformed HTTP response \"Unauthorized\"" error you are seeing — Go's
     `net/http` client is parsing literal bytes `Unauthorized\n...` left on a
     reused keep-alive connection by something that responded *before* the
     upgrade was attempted),
   - uses a dedicated `serversTransport` with `disableHTTP2: true` and a small
     `maxIdleConnsPerHost` (or `0` to fully disable pooling for that route).
2. On the **Next.js** side, add the proxy hostname to `allowedDevOrigins` in
   `next.config.js` (required since Next 13.5+, enforced in 16) and pin to
   **Next.js >= 16.1.7** (CVE-2026-27977 fix to the dev-HMR Origin check). No
   `webSocketUrl` option exists in `next.config.js` itself — that key is a
   webpack-dev-server option Next does not expose. The HMR path is fixed at
   `/_next/webpack-hmr` for both webpack and Turbopack backends.

This same shape works for Vite (`/@vite/client` / `/__vite_hmr`), Storybook
(`/storybook-server-channel`) and Remix dev — *separate router, no auth,
dedicated transport, HTTP/1.1 only*.

## Why this is the right fix (not just the easy one)

- The error string `malformed HTTP response "Unauthorized"` is Go's
  `net/http` client trying to read a response line and finding the literal
  word `Unauthorized` as the first bytes on the wire. That is **not** what
  Next's dev server emits — it emits `HTTP/1.1 101 Switching Protocols`,
  which your `nc` probe confirmed. So the bytes are coming from somewhere
  in Traefik's pipeline: either an auth middleware that wrote a body and
  returned the connection to the pool, or an HTTP/2-→1.1 upgrade-handling
  quirk against a pooled idle conn. PR
  [traefik/traefik#11408](https://github.com/traefik/traefik/pull/11408)
  documents that the Go HTTP/2 server's CONNECT-style WS upgrade is
  *incompatible with the net/http HTTP/1 reverse proxy* — Traefik disables
  it via `GODEBUG=http2xconnect=0` for exactly this reason.
- Disabling HTTP/2 to the upstream and disabling idle-conn reuse on the HMR
  route guarantees every WS upgrade dials a fresh HTTP/1.1 socket, which
  is what the WebSocket RFC actually requires.
- The dedicated, higher-`priority` router is the canonical way in Traefik
  to bypass middlewares for one path — it scales cleanly, is declarative,
  and survives middleware additions on the main router.

## Tradeoffs vs alternatives

| Option | Verdict |
|---|---|
| Single router, just add `disableHTTP2` globally | Works but pollutes prod traffic; loses HTTP/2 to other upstreams. |
| `webSocketUrl: 'auto'` in `next.config.js` | Not a real Next option — it's a webpack-dev-server key Next doesn't pass through. Don't rely on it. |
| `next dev --turbopack` (default in 16) | Same `/_next/webpack-hmr` endpoint, same proxy requirements — does not avoid the issue. |
| Disable HMR / poll-only | Last resort; ruins DX. |
| Wait for a Traefik fix | No open issue matches your exact symptom on 3.6; the WS regression in 3.2.4 ([#11405](https://github.com/traefik/traefik/issues/11405)) was patched. The "auth bytes on pooled conn" pattern is a config bug, not a Traefik bug. |

## Most authoritative sources

- Traefik ServersTransport reference (disableHTTP2, maxIdleConnsPerHost,
  forwardingTimeouts):
  <https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/serverstransport/>
- Traefik PR #11408 — *Disable http2 connect setting for websocket by
  default* (explains the HTTP/2 ↔ HTTP/1 reverse-proxy WS incompatibility):
  <https://github.com/traefik/traefik/pull/11408>
- Next.js docs — `allowedDevOrigins` (required for any non-localhost dev
  origin, including reverse-proxy hostnames):
  <https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins>
- Next.js v12 upgrade guide — canonical reverse-proxy WS snippet for
  `/_next/webpack-hmr` (still current for 16):
  <https://nextjs.org/docs/pages/guides/upgrading/version-12>
- CVE-2026-27977 — fix in Next.js 16.1.7 for dev-HMR Origin bypass:
  <https://advisories.gitlab.com/pkg/npm/next/CVE-2026-27977/>
