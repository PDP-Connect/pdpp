# MCP/OAuth headless auth prior art

Access date: 2026-06-12

## Question

What is the SLVP ideal for OAuth setup when an MCP client cannot complete a normal loopback or localhost callback because it runs in a sandbox, SSH session, container, or other headless environment?

SLVP here means the Stripe, Linear, Vercel, Plaid developer-quality bar: flows should be explicit, recoverable, copyable, bounded by timeouts, and precise about what token is being issued.

## Normative baseline for MCP OAuth

The current MCP authorization specification defines authorization for HTTP transports. Authorization is optional, but an implementation that supports it should follow the spec; STDIO transports should get credentials from the environment instead of using the HTTP authorization flow. The spec says the authorization mechanism is based on OAuth 2.1 plus selected supporting specs: OAuth Authorization Server Metadata, Dynamic Client Registration, Protected Resource Metadata, and OAuth Client ID Metadata Documents. Source: Model Context Protocol authorization spec, `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`.

The MCP baseline is:

- MCP servers act as OAuth resource servers. MCP clients act as OAuth clients. The authorization server may be co-hosted or separate.
- Authorization servers must implement OAuth 2.1 security measures for public and confidential clients.
- MCP servers must implement OAuth 2.0 Protected Resource Metadata and MCP clients must use it for authorization-server discovery.
- MCP clients must support both OAuth Authorization Server Metadata and OpenID Connect Discovery to obtain authorization endpoints and capabilities.
- Authorization servers and MCP clients should support OAuth Client ID Metadata Documents. This is the preferred no-prior-relationship registration mechanism in the latest spec.
- Dynamic Client Registration is only a MAY, retained for backwards compatibility or specific deployments.
- MCP clients must use Resource Indicators and include the `resource` parameter in authorization and token requests.
- MCP clients must use bearer tokens in the Authorization header and must not put access tokens in query strings.
- MCP servers must validate token audience and must not accept token passthrough.
- MCP clients must implement PKCE and use `S256` when technically capable.
- Redirect URIs must be exact registered values, and all redirect URIs must be HTTPS or localhost.

OAuth Client ID Metadata Documents are not a redirect mechanism. They solve client registration by making an HTTPS URL the `client_id`, where the document contains client metadata such as name and redirect URIs. The IETF draft says this is meant for clients that have no prior relationship with an authorization server and where manual registration is impossible or DCR is operationally awkward. Sources: MCP authorization spec, `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`; OAuth Client ID Metadata Document draft, `https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00`.

## Native, CLI, and headless OAuth prior art

RFC 8252 is the Best Current Practice for native apps. It says native apps should perform OAuth authorization through the external user agent, usually the system browser. Public native clients should use Authorization Code with PKCE. Implicit flow is not recommended for native apps because it cannot be protected by PKCE and does not support refresh in the same practical way. Source: RFC 8252, `https://datatracker.ietf.org/doc/html/rfc8252`.

RFC 8252 recognizes three redirect patterns for native clients:

- Private-use URI scheme redirects: useful for apps registered with the OS, but multiple apps can claim the same scheme. PKCE is required to protect intercepted authorization codes.
- Claimed HTTPS redirects: preferred where the platform can bind the HTTPS domain to the app, because the authorization server can use ordinary HTTPS redirect URI validation while the OS routes the URI to the app.
- Loopback redirects: suitable for desktop and CLI-style native apps. Loopback HTTP without TLS is acceptable because the request stays on the device. Clients should bind the port only while the flow is active, listen only on loopback, and prefer loopback IP literals over `localhost` to avoid name-resolution and interface ambiguity. Authorization servers should allow any port for loopback redirect URIs.

RFC 8628 defines the OAuth 2.0 Device Authorization Grant for devices that lack a browser or are input constrained. The client asks the authorization server for a `device_code`, `user_code`, `verification_uri`, optional `verification_uri_complete`, `expires_in`, and optional polling `interval`. The user approves on a separate browser-capable device. The client polls the token endpoint with `grant_type=urn:ietf:params:oauth:grant-type:device_code` and the `device_code`. It must respect `authorization_pending`, `slow_down`, `access_denied`, and `expired_token`; if `interval` is absent it waits at least five seconds. Sources: RFC 8628, `https://datatracker.ietf.org/doc/html/rfc8628`; Microsoft identity platform device-code docs, `https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code`.

Out-of-band manual copy/paste of authorization codes is legacy and weaker than device authorization. Good CLIs still provide a copyable URL path when a browser launch fails, but the durable modern pattern is not "open browser and hope"; it is an explicit browser-capable-device flow with a code, an expiry, and polling semantics.

## Does MCP standardize device-code authorization?

Not in the core MCP authorization spec. Core MCP standardizes the ordinary interactive OAuth authorization-code flow profile and adjacent client registration/discovery requirements. It does not require or define RFC 8628 device authorization for MCP clients.

MCP now has an authorization extensions area. The listed extensions are OAuth Client Credentials and Enterprise-Managed Authorization; the overview says extensions cover cases where core interactive user authorization is not the right fit. It does not list device authorization as a standardized MCP extension. Source: MCP Authorization Extensions overview, `https://modelcontextprotocol.io/extensions/auth/overview`.

There is community pressure for device authorization in MCP. A modelcontextprotocol discussion proposes non-interactive/headless OAuth support via Device Authorization Grant and CIBA, and a Claude Code issue asks for OAuth device authorization support for MCP servers in SSH, containers, and remote development servers. These are useful adoption signals, but they are not normative MCP requirements. Sources: `https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/298`; `https://github.com/anthropics/claude-code/issues/20215`.

## Strong developer-tool prior art

GitHub CLI:

- `gh auth login` defaults to a browser-based auth flow, stores credentials securely when possible, and falls back to a file only when needed.
- It offers `--web`, `--clipboard`, `--with-token`, and environment-token paths.
- Its docs explicitly say environment variables are most suitable for headless automation.
- The one-time device-code path is copy-friendly rather than hidden inside a local callback wait. Source: GitHub CLI manual, `https://cli.github.com/manual/gh_auth_login`.

Google Cloud CLI:

- `gcloud auth login --no-browser` supports authorizing a machine without a browser through a trusted second machine with both browser and gcloud installed.
- `--launch-browser` prints a URL if it cannot launch the browser.
- `--no-launch-browser` prints the authorization URL for use on another trusted machine and asks the user to paste the resulting authorization code back. Source: Google Cloud SDK docs, `https://docs.cloud.google.com/sdk/gcloud/reference/auth/login`.

Stripe CLI:

- `stripe login` prints a pairing code and asks the user to confirm in Dashboard.
- It also offers `stripe login --interactive` for environments that cannot open a browser and need manual API key entry.
- It documents configuration file location and environment/API-key alternatives. Source: Stripe CLI reference, `https://docs.stripe.com/cli`.

Vercel CLI:

- Vercel moved `vercel login` to OAuth 2.0 Device Flow in 2025.
- The changelog says users can sign in from any browser-capable device and should verify location, IP, and request time before approval.
- Vercel deprecated older email/OOB/provider-specific login flags. Source: Vercel changelog, `https://vercel.com/changelog/new-vercel-cli-login-flow`.

Linear:

- Linear's developer OAuth docs use standard Authorization Code parameters including `client_id`, `redirect_uri`, `response_type=code`, and scopes. Source: Linear OAuth docs, `https://linear.app/developers/oauth-2-0-authentication`.
- Linear is useful as a quality bar for clear OAuth docs and least-surprise API design, not as evidence of a device-flow CLI pattern.

Plaid:

- Plaid Link's OAuth documentation is redirect-URI precise. It distinguishes received redirect URI handling and mobile app-to-app OAuth cases.
- Hosted Link recommends native-mobile redirect targets such as Universal Links or Android App Links for app-to-app auth.
- Plaid quickstart supports localhost redirect URIs for sandbox testing when registered in the dashboard. Sources: Plaid Link OAuth guide, `https://plaid.com/docs/link/oauth/`; Plaid Hosted Link docs, `https://plaid.com/docs/link/hosted-link/`; Plaid quickstart README, `https://github.com/plaid/quickstart/blob/master/README.md`.

## What the SLVP ideal is

The SLVP ideal is a combination:

1. Keep the normal MCP authorization-code-with-PKCE path for browser-capable local clients. Prefer loopback IP literal redirects over `localhost` for CLI/native flows where a loopback listener is actually reachable.
2. Provide an explicit no-loopback path for headless/sandbox clients. Do not silently open a browser and wait forever for an unreachable callback.
3. Prefer RFC 8628 Device Authorization Grant for the no-loopback path when issuing a delegated, grant-scoped MCP token. It has the right semantics: user approves on another device, client polls with bounded intervals, and the token is delivered directly to the waiting client without a loopback callback.
4. If device authorization is not available, provide an adapter-only UX that prints the authorization URL, expiry, and fallback instructions, and fails fast with a clear timeout instead of waiting indefinitely.
5. Provide explicit copy affordances: verification URI, user code, verification URI complete when available, expiry time, polling status, and retry command.
6. Never use the existing owner-agent device flow to mint tokens for `/mcp`. Owner bearers are not grant-scoped MCP client credentials, and `/mcp` must reject owner bearers.

## PDPP-specific conclusion

PDPP already has an owner-agent device flow that issues owner bearers for self-export and owner operations. That flow is the wrong substrate for ordinary MCP clients because the MCP surface must reject owner bearers and because a grant-scoped client token must be auditable to a specific PDPP grant/package, resource audience, scopes, and client identity.

If PDPP wants to solve headless MCP OAuth rather than only document a workaround, the standards-aligned ship is a new grant-scoped device authorization flow for MCP clients:

- It must issue only client/grant-scoped MCP tokens, never owner bearers.
- It must bind tokens to `/mcp` via `resource`.
- It must require an already-created or simultaneously created PDPP grant/package that defines the disclosed streams, fields, time window, and change projection.
- It must expose RFC 8628-style device authorization responses with `device_code`, `user_code`, `verification_uri`, optional `verification_uri_complete`, `expires_in`, and `interval`.
- It must poll with RFC 8628 errors and backoff semantics.
- It must expire pending device authorizations quickly and reject reused/expired device codes.
- It must show the operator a confirmation screen that identifies the MCP client, resource, requested grant/package, expiration, and approving browser context.
- It must include clear failure states in CLI/agent docs: browser launch failed, no loopback available, authorization pending, denied, expired, and token rejected by `/mcp`.

The smaller no-new-token-flow option is adapter-only: document and improve client-side handling so headless adapters print/copy URLs and fail fast, while relying on existing standards-compliant MCP OAuth clients for actual token issuance. That avoids adding a new authorization surface but does not meet the Vercel/GitHub/Stripe bar for first-class headless MCP setup.

Clear recommendation: if the objective is only to prevent the "opened browser but waiting forever" failure, ship adapter-only UX. If the objective is SLVP headless MCP setup, ship a new grant-scoped device authorization flow and keep the owner device flow separate.
