## ADDED Requirements

### Requirement: Local collector deployment posture is mechanically visible

The reference implementation SHALL expose, on the local collector health
surface, whether the running collector resolves to a published package install
or to a repository `dist/` development override, so an operator or agent can
tell published operator-host evidence from local development evidence without a
manual path-resolution ritual. The posture signal SHALL include the package
version, a mutually-exclusive classification — published package, repository
`dist/` override, or unknown — and a flag for the placeholder `0.0.0` version
that disqualifies a build from being treated as a real published version.

#### Scenario: A published install is inspected

- **WHEN** the running `pdpp-local-collector` resolves to a package installed
  under `node_modules/@pdpp/local-collector`
- **THEN** the health surface SHALL classify the deployment posture as a
  published package
- **AND** it SHALL report the installed package version alongside the
  classification

#### Scenario: A repository dist override is inspected

- **WHEN** the running `pdpp-local-collector` resolves to a monorepo checkout's
  `packages/local-collector` tree rather than a `node_modules` install — for
  example via `npm link`, a `file:` install, or running the source entrypoint
  directly
- **THEN** the health surface SHALL classify the deployment posture as a
  repository `dist/` override rather than as a published package
- **AND** `doctor` SHALL treat that posture as a warning that disqualifies the
  output as published operator-host evidence, not as a hard failure
- **AND** `doctor` SHALL NOT escalate that posture to its critical severity

#### Scenario: Posture cannot be determined conclusively

- **WHEN** the health surface cannot conclusively determine whether the running
  collector is a published install or a repository override
- **THEN** it SHALL report the posture as unknown rather than guessing a
  published-package classification

#### Scenario: The placeholder version is reported

- **WHEN** the running collector reports the placeholder `0.0.0` version
- **THEN** the health surface SHALL flag that the version is a placeholder that
  must not be treated as a real published version
- **AND** `doctor` SHALL surface that as a warning

#### Scenario: Posture is displayed without leaking local paths

- **WHEN** the deployment posture is displayed, including outside the local
  device
- **THEN** the posture signal SHALL convey the module-location classification
  without emitting an unredacted absolute local path such as a home directory
