# Connection Onboarding Prior Art

Status: captured
Owner: reference implementation owner
Created: 2026-06-10
Related: complete-self-service-connection-onboarding

## Question

What prior-art pattern should guide PDPP reference connection setup so self-hosted
operators can add supported sources without connector-specific deployment
environment variables?

## Sources

- Airbyte, "Add and manage sources",
  https://docs.airbyte.com/platform/using-airbyte/getting-started/add-a-source
- Plaid, "Link overview", https://plaid.com/docs/link/
- Plaid, "Items API", https://plaid.com/docs/api/items/
- Stripe, "Using OAuth with Standard accounts",
  https://docs.stripe.com/connect/oauth-standard-accounts
- Railway, "Using Variables", https://docs.railway.com/variables

## Findings

- Airbyte treats each source connector as an object configured through UI/API
  setup, not as a deployment-level environment variable. Its setup flow collects
  authentication and location settings, tests the source, and only then makes the
  source usable. It also distinguishes agent-assisted setup from secret capture:
  secret mode stores masked credentials without exposing them to the assistant.
- Plaid Link uses an explicit owner/user interaction surface for account linking.
  The application creates a short-lived link token, the user completes Link, and
  the backend exchanges the public token for an access token. The durable
  provider token is backend-held; the user-facing linking surface is not replaced
  by deployment env vars.
- Stripe Connect OAuth separates platform configuration from per-account
  onboarding. The platform has OAuth/client setup, but each connected account
  completes an authorization/onboarding flow. That maps to PDPP's distinction
  between deployment readiness and one owner connection.
- Railway variables are runtime service configuration. They are useful for
  instance-level settings such as database URLs, public origins, and encryption
  keys. They are the wrong primary UX for adding multiple user source
  connections after deployment.

## Carried Conclusion

The SLVP construction is one owner-mediated setup engine with typed modality
branches, proof gates, and secret-safe capture. Deployment variables may provide
instance/platform readiness, but per-connection source credentials and account
authorizations belong in connection setup flows and encrypted instance-scoped
state.

This is not a call to hide complexity behind a wizard. The owner should see the
minimum next step needed for the selected source, with honest unsupported/proof
states and no duplicated catalog truth across Console, REST, CLI, or agent
surfaces.
