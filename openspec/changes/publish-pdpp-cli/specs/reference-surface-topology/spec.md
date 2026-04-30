## ADDED Requirements

### Requirement: Human-facing surfaces SHALL expose a copyable agent connection command
The reference website SHALL give users and agents a minimal executable command
for connecting to the live reference provider, and dashboard, deployment docs,
hosted skill, and LLM-facing text surfaces SHALL use the same command.

#### Scenario: A user wants to give an AI agent access
- **WHEN** the user visits the live dashboard or reference deployment surface
- **THEN** the surface SHALL show a "Connect an AI agent" affordance with a copyable npm command
- **AND** the copy SHALL explain that the owner will approve scoped access in the browser
- **AND** it SHALL NOT instruct the user to share an owner bearer token

#### Scenario: An agent reads hosted instructions
- **WHEN** an agent reads the hosted PDPP skill, `llms.txt`, or `llms-full.txt`
- **THEN** the first routine access path SHALL be the public CLI install/connect command
- **AND** raw HTTP fallback SHALL be framed as an advanced/debug path after CLI failure, not the happy path

#### Scenario: The same deployment has live and sandbox surfaces
- **WHEN** a surface advertises an agent connection command
- **THEN** the command SHALL identify whether it targets live owner data or sandbox/mock data
- **AND** sandbox copy SHALL preserve the existing requirement that simulated data is clearly labeled
