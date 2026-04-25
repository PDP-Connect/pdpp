## ADDED Requirements

### Requirement: Reference web surfaces SHALL support light and dark themes

The PDPP reference web app SHALL support an explicit dark theme alongside its existing light theme, the dashboard SHALL be usable for sustained operator sessions in either theme, and the theme choice SHALL apply to dashboard, docs, and reference public surfaces inside the same browser session.

#### Scenario: An operator opens the dashboard with the OS in dark mode and no prior preference

- **WHEN** the operator first loads `/dashboard` and `localStorage` contains no
  PDPP theme preference and the operating system reports
  `prefers-color-scheme: dark`
- **THEN** the dashboard SHALL render in dark mode on first paint
- **AND** there SHALL be no visible light-to-dark flash during hydration

#### Scenario: An operator picks an explicit theme

- **WHEN** the operator activates the theme toggle and selects light or dark
- **THEN** the choice SHALL persist across reloads in the same browser
- **AND** the choice SHALL apply to dashboard, docs, and reference public
  surfaces in the same session

#### Scenario: An operator returns to system tracking

- **WHEN** the operator selects "system" from the theme toggle
- **THEN** the explicit preference SHALL be cleared
- **AND** the rendered theme SHALL follow the operating system's
  `prefers-color-scheme` value, including subsequent OS changes during the
  session

### Requirement: Status colors SHALL remain identifiable in both themes

Dashboard status indicators SHALL remain distinguishable in both light and dark themes. Status indicators (online/offline, success/destructive/warning, verified/unverified) SHALL NOT be conveyed by hue alone where a non-color affordance is reasonably available.

#### Scenario: An operator scans endpoint health in dark mode

- **WHEN** the dashboard endpoint footer renders in dark mode
- **THEN** online and offline endpoints SHALL be distinguishable by indicator
  shape/position and label, not only by color
- **AND** the chosen success and destructive token SHALL meet WCAG AA
  contrast against the dark background for the indicator and label
