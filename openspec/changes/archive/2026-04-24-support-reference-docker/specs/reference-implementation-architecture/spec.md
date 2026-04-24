## ADDED Requirements

### Requirement: Docker assembly SHALL preserve reference architecture boundaries
The reference implementation SHALL provide a Docker or Docker Compose path that assembles the live reference stack without redefining PDPP protocol behavior, hiding control-plane behavior, or making the website the implementation boundary.

#### Scenario: Docker starts the live reference stack
- **WHEN** an operator starts the supported Docker assembly
- **THEN** the assembly SHALL run the reference AS/RS process and the browser-facing web app as the current reference architecture defines them
- **AND** the AS SHALL listen on port `7662`
- **AND** the RS SHALL listen on port `7663`
- **AND** the web app SHALL listen on port `3000`

#### Scenario: Docker is used as assembly
- **WHEN** a reviewer evaluates Docker artifacts for the reference implementation
- **THEN** those artifacts SHALL be documented as deployment assembly for the reference stack
- **AND** they SHALL NOT be described as PDPP protocol requirements or as an alternate control-plane contract

### Requirement: Docker builds SHALL use the monorepo toolchain
Docker builds for the supported reference stack SHALL use the repo-root pnpm workspace through Corepack and SHALL use a Debian/Ubuntu-based Node image compatible with the reference's native dependencies.

#### Scenario: Dependencies are installed in Docker
- **WHEN** a Docker image installs JavaScript dependencies
- **THEN** it SHALL install from the repository root using the checked-in pnpm workspace and lockfile
- **AND** it SHALL NOT run package-local `npm install` commands that create a dependency graph different from local development

#### Scenario: Native dependencies are built in Docker
- **WHEN** a Docker image builds or loads native dependencies such as SQLite or browser-automation dependencies
- **THEN** the base image SHALL be Debian/Ubuntu-based Node rather than Alpine
- **AND** the Node version SHALL be compatible with the repo's runtime floor for `node:sqlite`

### Requirement: Docker topology SHALL distinguish public and internal URLs
The Docker assembly SHALL keep browser-facing reference origin configuration separate from container-internal AS/RS service URLs.

#### Scenario: Composed mode is configured in Docker
- **WHEN** the Docker stack runs in composed mode
- **THEN** `PDPP_REFERENCE_ORIGIN` SHALL identify the external browser-facing origin
- **AND** `PDPP_AS_URL` SHALL identify the container-internal AS URL
- **AND** `PDPP_RS_URL` SHALL identify the container-internal RS URL

#### Scenario: Services call each other inside Docker
- **WHEN** one container calls the AS or RS container
- **THEN** it SHALL use Docker service DNS or another explicit internal URL
- **AND** it SHALL NOT rely on `localhost` to mean another container

#### Scenario: Browser-facing metadata is emitted
- **WHEN** the AS or RS emits public metadata, device verification URLs, or pending-consent authorization URLs in composed Docker mode
- **THEN** those URLs SHALL use `PDPP_REFERENCE_ORIGIN`
- **AND** they SHALL NOT leak internal Docker service names as browser-facing URLs

### Requirement: Docker runtime state SHALL be persistent and explicit
The Docker assembly SHALL document and provide persistence for the state required by real reference operation.

#### Scenario: Reference data is written
- **WHEN** the Docker stack writes reference records, grants, runs, or semantic vectors
- **THEN** the configured SQLite database path SHALL be backed by a persisted volume or documented host bind mount

#### Scenario: Semantic embeddings are used
- **WHEN** the Docker stack uses the local semantic embedding backend
- **THEN** the embedding model cache path SHALL be persisted or documented as intentionally ephemeral
- **AND** first-boot model download behavior SHALL be documented

#### Scenario: Browser connectors are used
- **WHEN** browser-based polyfill connectors run inside or alongside the Docker stack
- **THEN** browser profiles, daemon files, and connector session state SHALL have a persisted volume or documented host bind mount
- **AND** the documentation SHALL state that browser connectors depend on persistent profiles and upstream anti-bot behavior

### Requirement: Docker secrets SHALL be runtime-provided
The Docker assembly SHALL keep owner passwords, connector credentials, tokens, cookies, and other secrets out of built image layers.

#### Scenario: A secret is needed by the Docker stack
- **WHEN** the Docker stack needs `PDPP_OWNER_PASSWORD`, connector credentials, tokens, cookies, or dynamic-client-registration secrets
- **THEN** those values SHALL be supplied at runtime through environment variables, env files, or Docker secrets
- **AND** they SHALL NOT be baked into Dockerfiles, image layers, committed Compose defaults, or generated static assets

#### Scenario: Deployment diagnostics render Docker env
- **WHEN** the dashboard deployment diagnostics render secret-bearing Docker environment variables
- **THEN** secret values SHALL be redacted before reaching the dashboard

### Requirement: Docker support SHALL include a smoke validation path
The supported Docker path SHALL include a reproducible smoke validation that does not require real third-party connector credentials.

#### Scenario: Docker smoke validation runs
- **WHEN** an operator or CI job runs the Docker smoke validation
- **THEN** it SHALL verify that the browser-facing web origin responds
- **AND** it SHALL verify that AS and RS metadata are reachable through the composed origin
- **AND** it SHALL verify that browser-facing metadata does not expose internal Docker service URLs

#### Scenario: Owner auth is configured during Docker smoke validation
- **WHEN** `PDPP_OWNER_PASSWORD` is configured for the Docker smoke validation
- **THEN** dashboard access SHALL either redirect unauthenticated requests to `/owner/login` or pass after a valid owner session is established
