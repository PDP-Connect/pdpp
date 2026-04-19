# Provider Connect Next Cut Memo

Date: 2026-04-16

## 1. What is executable today

The `e2e` stack already executes a real **self-export provider-connect** path.

- RFC 9728 protected-resource metadata is exposed at `GET /.well-known/oauth-protected-resource` in [`e2e/server/index.js`](/home/user/code/pdpp/e2e/server/index.js:511) using the helpers in [`e2e/server/metadata.js`](/home/user/code/pdpp/e2e/server/metadata.js:12).
- RFC 8414 authorization-server metadata is exposed at `GET /.well-known/oauth-authorization-server` in [`e2e/server/index.js`](/home/user/code/pdpp/e2e/server/index.js:163) using [`e2e/server/metadata.js`](/home/user/code/pdpp/e2e/server/metadata.js:33).
- The AS exposes a real owner device flow:
  - `POST /oauth/device_authorization` [`e2e/server/index.js`](/home/user/code/pdpp/e2e/server/index.js:180)
  - `POST /oauth/token` for `urn:ietf:params:oauth:grant-type:device_code` [`e2e/server/index.js`](/home/user/code/pdpp/e2e/server/index.js:197)
  - `GET /device` and `POST /device/approve` as the reference approval surface [`e2e/server/index.js`](/home/user/code/pdpp/e2e/server/index.js:217)
- The CLI already consumes the discovery chain when given `--rs-url`:
  - `discoverProvider()` fetches RFC 9728 metadata, follows `authorization_servers`, then fetches RFC 8414 metadata in [`e2e/cli/lib/discovery.js`](/home/user/code/pdpp/e2e/cli/lib/discovery.js:5)
  - `pdpp auth login` uses that path in [`e2e/cli/commands/auth.js`](/home/user/code/pdpp/e2e/cli/commands/auth.js:32) and [`e2e/cli/commands/auth.js`](/home/user/code/pdpp/e2e/cli/commands/auth.js:97)
  - `pdpp provider show` summarizes the discovered metadata in [`e2e/cli/commands/provider.js`](/home/user/code/pdpp/e2e/cli/commands/provider.js:6)
- Owner self-export is real against the standard RS query surface via `pdpp owner streams|query|get|export` in [`e2e/cli/commands/owner.js`](/home/user/code/pdpp/e2e/cli/commands/owner.js:7).
- This is black-box tested:
  - metadata honesty in [`e2e/test/provider-metadata.test.js`](/home/user/code/pdpp/e2e/test/provider-metadata.test.js:55)
  - discovery-based introspection in [`e2e/test/cli.test.js`](/home/user/code/pdpp/e2e/test/cli.test.js:174)
  - discovery-based device login from `--rs-url` in [`e2e/test/cli.test.js`](/home/user/code/pdpp/e2e/test/cli.test.js:188)
  - provider metadata summary in [`e2e/test/cli.test.js`](/home/user/code/pdpp/e2e/test/cli.test.js:240)
  - owner self-export commands in [`e2e/test/cli.test.js`](/home/user/code/pdpp/e2e/test/cli.test.js:316) and native owner access in [`e2e/test/cli.test.js`](/home/user/code/pdpp/e2e/test/cli.test.js:358)

Bottom line: **Self-Export Provider** plus **Provider Connect Client** are materially real already.

## 2. What is still missing

The code is ahead on self-export, but the broader companion-profile story is still incomplete.

- The draft profile still reads as if **Third-Party Provider** is part of the near-term contract, but the executable stack still does not provide a standards-based third-party path. The only grant front door is the compat-only `POST /grants/initiate` seam in [`e2e/server/index.js`](/home/user/code/pdpp/e2e/server/index.js:1), not a provider-connect-grade OAuth client-connect flow.
- There is still no authorization endpoint, PKCE path, or registration support. That means `third_party_client_connect`, `native_pkce_connect`, and any registration mode beyond the currently absent registration metadata would still be overclaiming today.
- The current metadata and CLI story is strongly self-export-shaped. That is good for phase 1, but it means the draft profile needs a sharper line between `owner/self-export` capability signaling and any future `third-party client connect` signaling.

## 3. Highest-leverage next spec+code cut

The next cut should stay focused on a **phase-1 self-export profile** while making the deferred line explicit.

### Spec side

Keep the companion profile explicit about phases:

- **In scope now:** `Self-Export Provider` and `Provider Connect Client`
- **Deferred:** `Third-Party Provider`

That means updating [`docs/inbox/pdpp-provider-connect-profile-draft.md`](/home/user/code/pdpp/docs/inbox/pdpp-provider-connect-profile-draft.md:1) so the draft stops implying that generic third-party provider connectivity is already part of the executable bar.

### Code side

The next code work should avoid new OAuth machinery and instead keep tightening the current discovery-based self-export contract:

1. Keep `pdpp provider show` and `auth login` aligned with the actually advertised capability surface.
2. Continue refusing to advertise registration modes or third-party-connect capability until the underlying flow exists.
3. Use the current self-export chain as the stable base for later provider-connect expansion instead of adding partial PKCE/registration stubs.

This keeps the profile thin, honest, and standards-compositional while deferring the truly new PDPP glue until it is ready to be executable.
