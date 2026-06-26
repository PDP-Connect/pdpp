# Owner Console Fresh-Owner Journey Prior Art

Date: 2026-06-18
Status: Research note
Scope: Lens 10, a motivated owner who did not build PDPP and is trying to deploy, add data, see records, and connect an AI app without repo knowledge or chat context.

## Why This Note Exists

The earlier prior-art lane completed most owner-console lenses, but the fresh-owner journey and synthesis lane stalled on provider rate limits. This note fills that gap so the product-experience OpenSpec does not depend on an unfinished worker report.

The owner journey here is not "first-time consumer user signs up for a hosted app." It is:

1. I have a self-hosted or personal-server PDPP instance.
2. I want to know if it is ready.
3. I want to add one data source.
4. I want to see records.
5. I want to connect an AI app or client.
6. I want to trust what I granted and what happened.

That sequence must work for a Docker/Railway operator without assuming a monorepo checkout, source-code knowledge, or memory of earlier chat instructions.

## Prior-Art Sources

All sources retrieved 2026-06-18.

### Tailscale quickstart and add-device flows

Sources:

- https://tailscale.com/docs/how-to/quickstart
- https://tailscale.com/docs/features/access-control/device-management/how-to/set-up

Observed pattern:

- Tailscale starts with the concrete object the owner wants to add: a device.
- The browser guide and device app form one loop: choose OS, install client, authenticate, then the device appears back in the browser.
- The user is not expected to infer whether the install succeeded from logs.

PDPP implication:

- Local collectors and browser-assisted collectors need the same loop. The console should say "install or run this collector on Peregrine," then show that Peregrine checked in, uploaded records, or is still offline.
- A command alone is not the product. The product is command plus observed check-in and terminal reconciliation.

### Railway variables and template deployment

Sources:

- https://docs.railway.com/variables
- https://docs.railway.com/variables/reference

Observed pattern:

- Railway treats variables as deployment configuration, not per-account user setup.
- Variables are visible in a deployment context and made available to build, runtime, `railway run`, and shell contexts.

PDPP implication:

- Per-account connector setup should not require env-var edits after deployment.
- Deployment readiness can ask for operator-held instance configuration, such as a credential encryption key, but it must distinguish this from adding Gmail, GitHub, WhatsApp, Amazon, and other owner sources.
- "Deployment needed" is not owner copy. The console must state the exact missing server capability or link to the exact deployment setting.

### Vercel project and deployment dashboard

Sources:

- https://vercel.com/docs/projects
- https://vercel.com/docs/deployments
- https://vercel.com/docs/deployments/managing-deployments

Observed pattern:

- Vercel separates project, deployment, logs, domains, environment variables, and status while keeping them in one project context.
- A deployment has status, URL, commit/source, and actions; operational evidence is not the same as the app's product content.

PDPP implication:

- PDPP needs a visible readiness layer, but not as the main data-management product.
- The owner should not need to read traces or deployment diagnostics to add data. Deployment readiness explains blocked setup paths only when it directly affects that setup.

### Stripe Connect onboarding and requirements

Sources:

- https://docs.stripe.com/connect/hosted-onboarding
- https://docs.stripe.com/connect/custom/hosted-onboarding
- https://docs.stripe.com/connect/required-verification-information

Observed pattern:

- Stripe uses hosted onboarding or embedded components to collect required information in a dynamically scoped flow.
- Requirements are concrete, tied to capabilities, and can be current or future requirements.
- The platform does not ask users to infer missing requirements from API errors after submission.

PDPP implication:

- Connector setup forms should be generated from connector capability and credential manifests.
- Required scopes, app-password links, token permissions, callback URLs, and first-sync expectations belong before the owner submits.
- A setup flow should say whether credentials were accepted, whether first collection started, whether records yielded, and what remains.

### Plaid Link and returning-user account selection

Sources:

- https://plaid.com/docs/link/
- https://plaid.com/docs/link/returning-user/
- https://plaid.com/plaid-exchange/docs/user-experience/

Observed pattern:

- Plaid Link owns credential validation, MFA, institution errors, account selection, and success return.
- Returning-user flows reuse what they can, then ask the user to select accounts when selection is the essential decision.

PDPP implication:

- "Add another account" must remain available for connectors already in use.
- The flow must echo the provider identity and owner label before completion. It should not silently merge two accounts or create many indistinguishable Amazon/Gmail sources.
- If a connector can populate the same streams through multiple collection paths, the UI should show the source identity and path explicitly enough to avoid accidental mixing.

### GitHub fine-grained personal access tokens

Sources:

- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2026-03-10

Observed pattern:

- GitHub exposes exact permissions and resource scope for tokens.
- Fine-grained token setup is still cognitively heavy; the product reduces ambiguity by naming permission sets, repositories, organizations, and expiration.

PDPP implication:

- A provider-secret connector such as GitHub must name exact scopes and permissions. "Paste a token" is not enough.
- The console should provide a checklist, a direct provider link, and a validation moment that confirms identity and permission sufficiency before treating setup as complete.

### Google account linked apps and third-party access

Sources:

- https://support.google.com/accounts/answer/13533235
- https://www.google.com/account/about/sign-in-with-google/
- https://support.google.com/accounts/answer/13864929

Observed pattern:

- Google separates sign-in, linked apps, and third-party access review.
- The user is asked to choose an account and later can review or remove app access.

PDPP implication:

- Connect AI Apps and owner grants need an access-review frame, not a trace-browser frame.
- After a grant, the owner should see the client, what it can read, what it did read, and how to revoke it.
- When OAuth or dynamic client registration is involved, the consent display must distinguish verified origin from client-authored name/logo.

### Supabase API keys and project setup

Sources:

- https://supabase.com/docs/guides/getting-started/api-keys
- https://supabase.com/docs/reference/api/introduction

Observed pattern:

- Supabase separates project keys, publishable keys, secret keys, management API tokens, and privilege boundaries.
- It explains which keys are appropriate for client versus server contexts.

PDPP implication:

- Owner tokens, client credentials, connector credentials, and deployment secrets must not collapse into one generic "token" concept.
- Debug bearer-token paths must be visibly advanced and not the recommended path for connecting normal AI apps.

## Observed Patterns Across Prior Art

1. The first journey is staged, not a documentation dump.
2. Each stage has a subject: project, deployment, device, account, source, client, grant.
3. The next action is specific to that subject.
4. Setup status is observed by the product, not inferred from logs.
5. Account selection and identity echo prevent accidental mixing.
6. Advanced/operator prerequisites are disclosed before the owner spends effort.
7. Access review is a product surface, not a raw audit log.
8. Low-level identifiers are available, but not required for ordinary comprehension.

## PDPP Fresh-Owner Journey Contract

The SLVP-ideal fresh-owner flow is:

1. Open the console.
2. See instance readiness in owner language: ready to add data, needs one deployment setting, or server unavailable.
3. Click Add Data.
4. See addable sources first; unavailable sources are secondary and honest.
5. Choose a connector.
6. See prerequisites, exact scopes, links, and what PDPP will collect before submitting.
7. Provide credentials, upload an artifact, enroll a collector, or start browser setup.
8. See identity echo and owner label before completion.
9. See live first-sync or import progress.
10. Land on the created source.
11. See records with counts that explain total held, current page, current filters, and latest-run yield.
12. Connect an AI app through a normal client/grant flow without owner bearer-token copy/paste.
13. Review what the client can read and what it read.

## Concrete Affordance Recommendations

### Readiness

- Use "Ready to add sources", "One instance setting needed", or "Server unavailable" instead of "deployment needed".
- If an instance setting is missing, show the exact setting and where to configure it.
- Keep deployment diagnostics secondary to Add Data unless they block the selected flow.

### Add Data

- Primary list: only sources that can be added now.
- Secondary list: unavailable sources collapsed under "Not available from this console yet" or "Requires instance setup".
- Proven connectors remain addable even if already present.
- Connector rows must remain comparable by default; detailed instructions open in a disclosure or setup step.

### Setup

- Every provider-secret flow shows:
  - exact permission or scope list
  - direct provider link
  - account identity expected or discovered
  - owner label field
  - validation before final success
  - first-sync status after submit

### Local collectors

- The web console shows the host/device identity, the command, and observed check-in state.
- Recovery commands must be paired with console evidence that the command worked or did not work.

### Access review

- Connect AI Apps should end in a client detail or grant detail page, not a trace list.
- The page must answer "who can read what" and "what was read" using source and stream language.

## Anti-Patterns To Avoid

- A button that opens generic provider docs and calls that setup.
- A setup flow that fails only after the owner has retrieved and pasted a credential.
- Per-account env vars for normal source setup.
- Repo-checkout commands in an owner path.
- Debug bearer-token flows as the normal AI-app connection path.
- "Connected" or "success" copy before first collection status is visible.
- Hidden identity merging when adding another account or import.
- Bounded samples as a terminal answer.

## Acceptance Checks

- A fresh Docker/Railway owner can identify whether the instance is ready to add sources without reading logs.
- A fresh owner can add a second source for a connector already in use.
- A fresh owner can complete one provider-secret flow and see credentials accepted, first sync running, and first sync settled.
- A fresh owner can complete one local-collector enrollment and see device check-in.
- A fresh owner can inspect records from the created source without hitting an unlabeled cap.
- A fresh owner can connect an AI client without copying an owner bearer token.
- Every setup failure appears before or at the relevant step, not after unrelated effort.
- No normal owner path uses "deployment needed", "source instance", `connection_id`, raw bearer-token jargon, or repo-checkout instructions as the primary explanation.

## Confidence

Confidence: 90%.

The prior-art pattern is strong because Tailscale, Stripe, Plaid, GitHub, Google, Vercel, Railway, and Supabase converge on staged setup, concrete requirements, identity echo, and reviewable access. Confidence is not higher because PDPP combines self-hosting, personal-data collection, local collectors, artifact imports, browser sessions, and AI-client grants in one console. The final confidence increase requires a live fresh-owner journey atlas.
