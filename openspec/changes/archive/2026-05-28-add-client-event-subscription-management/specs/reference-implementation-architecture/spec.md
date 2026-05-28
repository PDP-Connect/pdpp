## ADDED Requirements

### Requirement: Operator oversight surface for client event subscriptions

The reference implementation SHALL expose a reference-only, owner-session-gated oversight surface for client event subscriptions at the operator paths `GET /_ref/event-subscriptions`, `GET /_ref/event-subscriptions/:subscription_id`, and `POST /_ref/event-subscriptions/:subscription_id/disable`. These routes SHALL share the same owner-session middleware as every other `/_ref/*` route. They SHALL NOT accept client bearer tokens. They SHALL NOT modify the protocol-level `/v1/event-subscriptions` surface, and the protected-resource metadata advertisement at `/.well-known/oauth-protected-resource` SHALL NOT advertise them — they are reference-only and discoverable only via the operator console and CLI.

The operator projection returned by `GET /_ref/event-subscriptions` and `GET /_ref/event-subscriptions/:subscription_id` SHALL NOT include the subscription's `secret`, `secret_hash`, or `secret_text`. The detail projection SHALL include the bound grant's scope snapshot, the full callback URL, and at most twenty-five most-recent attempt rows for the subscription.

The operator oversight surface SHALL be read-mostly. The reference SHALL NOT expose operator-initiated subscription creation, re-enable, secret rotation, or attempt replay via these routes. Operator-initiated disable is the only mutating affordance.

#### Scenario: An operator lists subscriptions on the instance
- **WHEN** an operator with a valid owner session reads `GET /_ref/event-subscriptions`
- **THEN** the reference SHALL return a `{object: 'list', data}` envelope containing every non-deleted subscription persisted on the instance
- **AND** each row SHALL include `subscription_id`, `client_id`, `grant_id`, `status`, `disabled_reason`, the callback URL's host component, `created_at`, `updated_at`, `disabled_at`, a pending-queue count, the last attempt's outcome (timestamp, ok flag, HTTP status code), and a final-failure attempt count
- **AND** the response SHALL NOT include `secret`, `secret_hash`, or `secret_text` for any row

#### Scenario: An operator filters the list by client, grant, or status
- **WHEN** the operator passes `?client_id=`, `?grant_id=`, or `?status=` (or any combination)
- **THEN** the reference SHALL return only the subscriptions matching every supplied filter
- **AND** unknown filter values SHALL still return a well-formed empty list rather than a 4xx error

#### Scenario: An operator reads the detail projection
- **WHEN** the operator requests `GET /_ref/event-subscriptions/:subscription_id` for a subscription that exists and is not deleted
- **THEN** the response SHALL include the full callback URL, the bound grant's scope snapshot, the same status fields as the list projection, and a bounded list of at most twenty-five most-recent attempt rows ordered by `attempted_at` descending
- **AND** the response SHALL NOT include the subscription's secret material

#### Scenario: An operator requests a deleted or unknown subscription
- **WHEN** the operator requests `GET /_ref/event-subscriptions/:subscription_id` for a subscription whose status is `deleted` or whose id does not exist
- **THEN** the reference SHALL return HTTP 404 with a standard error envelope

#### Scenario: A request without an owner session is rejected
- **WHEN** any of the three `/_ref/event-subscriptions*` routes is called without a valid owner session
- **THEN** the reference SHALL respond with the standard owner-session-required envelope (HTTP 401) that the rest of the `/_ref/*` surface uses
- **AND** the response SHALL NOT disclose whether the requested subscription exists

#### Scenario: A request with a client bearer is rejected
- **WHEN** any of the three `/_ref/event-subscriptions*` routes is called with an `Authorization: Bearer` header carrying a client token (with or without an owner session cookie)
- **THEN** the reference SHALL still require the owner-session middleware to pass; absent a valid owner session it SHALL return HTTP 401 regardless of bearer presence

### Requirement: Operator-initiated subscription disable is a recoverable safety valve

The reference SHALL expose `POST /_ref/event-subscriptions/:subscription_id/disable` as the operator's safety-valve to stop deliveries to a callback without touching the bound grant or the client's own subscription state machine. The route SHALL accept an optional JSON body `{ reason: string }` whose value (when provided) replaces the default `disabled_reason` value `"operator_disabled"` on the persisted row. The route SHALL be idempotent: invocations on subscriptions already in `disabled`, `disabled_failure`, `disabled_revoked`, or `deleted` SHALL succeed without modifying the row.

A subscription disabled by the operator SHALL remain recoverable through the client's own `PATCH /v1/event-subscriptions/:id { enabled: true }` request. The reference SHALL NOT add an operator-initiated re-enable path; an operator who needs to permanently stop a callback SHALL revoke the bound grant.

#### Scenario: An operator disables an active subscription
- **WHEN** the operator posts to `POST /_ref/event-subscriptions/:subscription_id/disable` for a subscription in `active` or `pending_verification` status
- **THEN** the reference SHALL transition the subscription to `disabled`
- **AND** the persisted `disabled_reason` SHALL be `"operator_disabled"` when no reason was supplied, or the operator-supplied reason string otherwise
- **AND** the reference SHALL drop any pending queued events for that subscription
- **AND** the response SHALL return the operator detail projection for the now-disabled subscription

#### Scenario: A client re-enables an operator-disabled subscription
- **WHEN** the client whose grant binds the subscription sends `PATCH /v1/event-subscriptions/:id { enabled: true }` to a subscription in `disabled` status with `disabled_reason: "operator_disabled"` (or an operator-supplied reason)
- **THEN** the reference SHALL transition the subscription back to `active`
- **AND** subsequent in-scope record changes SHALL again enqueue events for that subscription

#### Scenario: Operator disable on an already-disabled subscription
- **WHEN** the operator posts to `POST /_ref/event-subscriptions/:subscription_id/disable` for a subscription whose status is already `disabled`, `disabled_failure`, `disabled_revoked`, or `deleted`
- **THEN** the reference SHALL return HTTP 200 (idempotent success) with the current detail projection
- **AND** SHALL NOT overwrite the existing `disabled_reason` or `disabled_at` columns

#### Scenario: Operator disable preserves the bound grant
- **WHEN** the operator disables a subscription bound to an active grant
- **THEN** the bound grant SHALL remain `active`
- **AND** other subscriptions bound to the same grant SHALL be unaffected

### Requirement: Operator oversight is mirrored by the reference CLI

The `@pdpp/cli` package SHALL expose `pdpp ref event-subscriptions list`, `pdpp ref event-subscriptions show <subscription-id>`, and `pdpp ref event-subscriptions disable <subscription-id>` subcommands that call the corresponding `_ref` routes using the existing owner-session cookie cache. The CLI SHALL refuse to send the disable POST without explicit confirmation (a `yes`-typed prompt or the `--yes` flag). The CLI SHALL never display or echo subscription secret material, since the `_ref` projection never includes it.

#### Scenario: An operator runs the list command
- **WHEN** the operator invokes `pdpp ref event-subscriptions list --as-url <url>` with a cached owner session
- **THEN** the CLI SHALL fetch `GET /_ref/event-subscriptions` and render the operator projection in the requested format (`table` by default, `json` on `--format json`)
- **AND** the CLI SHALL forward `--client-id`, `--grant-id`, and `--status` flags as query parameters

#### Scenario: An operator runs the disable command without --yes
- **WHEN** the operator invokes `pdpp ref event-subscriptions disable <subscription-id> --as-url <url>` without `--yes`
- **THEN** the CLI SHALL print the subscription summary and prompt for `yes` before posting to `POST /_ref/event-subscriptions/:id/disable`
- **AND** any input other than `yes` (case-insensitive) SHALL abort with exit code 1 and no network call

#### Scenario: An operator runs the disable command with --yes
- **WHEN** the operator invokes `pdpp ref event-subscriptions disable <subscription-id> --as-url <url> --yes --reason loop_suspected`
- **THEN** the CLI SHALL post `{"reason": "loop_suspected"}` to the disable route without prompting
- **AND** the CLI SHALL render the resulting detail projection

### Requirement: Operator oversight is mirrored by the reference dashboard

The reference operator console SHALL expose `/dashboard/event-subscriptions` as a list-with-peek view backed by the `_ref/event-subscriptions*` routes. The dashboard SHALL display only the operator projection (no secret material). The peek pane SHALL include a confirmed Disable affordance that posts to `POST /_ref/event-subscriptions/:id/disable` via a server action. The dashboard SHALL NOT expose any other mutating affordance for client subscriptions.

#### Scenario: An operator visits the dashboard page
- **WHEN** the operator navigates to `/dashboard/event-subscriptions` with a valid owner session
- **THEN** the dashboard SHALL render the list of subscriptions with status badges, callback hosts, last attempt outcomes, and counts
- **AND** SHALL provide filter controls for client, grant, and status

#### Scenario: An operator opens the peek pane and disables a subscription
- **WHEN** the operator opens the peek pane for a subscription in `active` status, confirms the disable dialog, and submits the form
- **THEN** the dashboard SHALL invoke the disable server action, which calls `POST /_ref/event-subscriptions/:id/disable`
- **AND** the dashboard SHALL refresh the page to render the now-disabled status
