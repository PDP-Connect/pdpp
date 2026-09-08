## ADDED Requirements

### Requirement: Development and build output isolation

The public site SHALL use distinct Next and generated Fumadocs source output directories for the supported development and verification commands.

#### Scenario: Verification runs beside development

**WHEN** a contributor runs the supported site verification command while the supported development server is active

**THEN** the two processes write distinct Next output directories and the development server remains able to serve an already compiled route

### Requirement: Environment-specific worker policy

The public site SHALL apply its conservative default build-worker limit only to production builds unless a contributor explicitly supplies an override.

#### Scenario: Development starts without a worker override

**WHEN** a contributor starts the supported development command without `PDPP_WEB_BUILD_WORKERS`

**THEN** the Next development configuration does not set the production one-worker default

### Requirement: Qualified development bundler

The supported development command SHALL select a bundler that passes the current repository's cold route and edit/reload probes.

#### Scenario: Development bundler is changed

**WHEN** the development command changes from Webpack to another bundler

**THEN** `/`, `/specification`, and an edit/reload cycle complete without the previously recorded crash or async-hook leak and the benchmark evidence is recorded in the change design
