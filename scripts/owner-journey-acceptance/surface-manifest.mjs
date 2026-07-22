// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Surface manifest for the owner-journey acceptance harness.
//
// This is the single source of truth for the harness. It declares:
//   - which console source files are "normal owner UI" (scanned strictly);
//   - which are "advanced/diagnostic" surfaces (still scanned for monorepo
//     command leaks, but exempt from owner-vocabulary-only rules);
//   - the forbidden-string rules, each mapped to the acceptance failure class
//     it defends against (see
//     `openspec/changes/complete-self-service-connection-onboarding/`
//     `design-notes/owner-journey-slvp-realignment-plan-2026-06-10.md`
//     "Negative acceptance checks");
//   - the published-command surface every rendered owner command must match.
//
// The harness fails if normal owner UI contains a developer-only path, an
// unpublished CLI command, a raw setup-planner label, a help link that does not
// open in a new tab, or a post-submit flow that relies only on a transient
// notice. These are the exact classes the failed setup walkthrough exposed and
// that Phase 0 (commit 29ee6974) did not yet have a guard for.
//
// Tiers:
//   normal   — primary owner add-source / connect surfaces. All rules apply.
//   advanced — reference-experimental / diagnostics surfaces that may show
//              internal ids and runbook pointers behind their own framing.
//              Monorepo/unpublished-command rules still apply (an advanced page
//              must not hand the owner a `pnpm --dir packages/...` setup command
//              either); owner-vocabulary-only rules are relaxed.

/**
 * Console source files rendered as normal owner UI — the pages and shared
 * chrome an owner actually sees. These are scanned strictly for forbidden
 * strings and rendered commands. Paths are relative to the repo root.
 *
 * `components/shell.tsx` is included because its chrome (including the
 * `ServerUnreachable` / `OwnerTokenRequired` fallbacks) renders on every
 * dashboard page, so a leak there reaches the normal owner journey from any
 * route — including `/dashboard/connect`, where the failed walkthrough began.
 */
export const NORMAL_OWNER_UI_FILES = [
  "apps/console/src/app/(console)/sources/page.tsx",
  "apps/console/src/app/(console)/sources/sources-view.tsx",
  "apps/console/src/app/(console)/sources/add/page.tsx",
  "apps/console/src/app/(console)/components/source-setup-catalog.tsx",
  "apps/console/src/app/(console)/lib/source-setup-presentation.ts",
  "apps/console/src/app/(console)/connect/page.tsx",
  "apps/console/src/app/(console)/connect/browser-session/[connectorId]/launch/launch-panel.tsx",
  "apps/console/src/app/(console)/connect/manual-upload/[connectorId]/manual-upload-form.tsx",
  "apps/console/src/app/(console)/connect/static-secret/[connectorId]/page.tsx",
  "apps/console/src/app/(console)/connect/static-secret/[connectorId]/actions.ts",
  "apps/console/src/app/(console)/connect/static-secret/[connectorId]/status/[connectionId]/page.tsx",
  "apps/console/src/app/(console)/components/shell.tsx",
];

/**
 * Route trees whose page/loading files are normal owner UI and should be
 * scanned automatically. This prevents new setup/source pages from silently
 * bypassing the owner-journey acceptance harness.
 */
export const NORMAL_OWNER_ROUTE_SCAN_ROOTS = [
  "apps/console/src/app/(console)/connect",
  "apps/console/src/app/(console)/deployment",
  "apps/console/src/app/(console)/event-subscriptions",
  "apps/console/src/app/(console)/explore",
  "apps/console/src/app/(console)/grants",
  "apps/console/src/app/(console)/sources",
  "apps/console/src/app/(console)/syncs",
  "apps/console/src/app/(console)/schedules",
  "apps/console/src/app/(console)/search",
  "apps/console/src/app/(console)/audit",
];

/**
 * Advanced / diagnostic console surfaces. Scanned for monorepo and unpublished
 * command leaks, but exempt from owner-vocabulary-only rules (these surfaces
 * may legitimately show `connector_instance_id`, `source_instance_id`, and a
 * `docs/operator/...` runbook pointer behind reference-experimental framing).
 */
export const ADVANCED_OWNER_UI_FILES = [
  "apps/console/src/app/(console)/device-exporters/page.tsx",
];

/**
 * Command-source libraries: not rendered themselves, but they build the command
 * strings that pages render. The harness extracts rendered commands from these
 * for freshness, and (via REACHABILITY_RULES) forbids any *rendered page* from
 * importing a helper known to emit a developer-only monorepo command.
 *
 * A forbidden command string sitting in a library helper that no page calls is
 * dead code, not an owner-facing leak — so these files are NOT forbidden-string
 * scanned directly. The reachability guard is what catches the dangerous case:
 * a page wiring such a helper into rendered output.
 */
export const COMMAND_SOURCE_FILES = [
  "apps/console/src/lib/pdpp-cli-command.ts",
  "apps/console/src/app/(console)/lib/connection-catalog.ts",
];

/**
 * Shared shell contract: the primary dashboard route map must stay in the
 * Recordroom shell and normal owner routes must render through it. This guards
 * the navigation regression from the owner walkthrough without freezing visual
 * implementation details like spacing or color.
 */
export const SHARED_SHELL_FILE = "packages/pdpp-brand-react/src/shell-frame.tsx";

export const DASHBOARD_ROUTE_ROOT = "apps/console/src/app/(console)";

export const SHELL_NAV_REQUIRED_ITEMS = [
  { label: "Overview", href: "/" },
  { label: "Explore", href: "/explore" },
  { label: "Sources", href: "/sources" },
  { label: "Syncs", href: "/syncs" },
  { label: "Schedules", href: "/schedules" },
  { label: "Connect AI apps", href: "/connect" },
  { label: "Grants", href: "/grants" },
  { label: "Audit", href: "/audit" },
  { label: "Deployment", href: "/deployment" },
  { label: "Device exporters", href: "/device-exporters" },
  { label: "Event subscriptions", href: "/event-subscriptions" },
];

export const FULL_SCREEN_DASHBOARD_ROUTE_EXCEPTIONS = [
  // Browser-control stream surfaces are intentionally full-screen task surfaces,
  // not dashboard reading-room pages.
  "apps/console/src/app/(console)/syncs/[runId]/stream/page.tsx",
  "apps/console/src/app/(console)/stream-playground/page.tsx",
];

/**
 * Reachability rules: a rendered owner page must not import/call a library
 * helper that emits a developer-only monorepo command. This catches an indirect
 * leak (a page rendering `pdppBrowserCollectorRunCommand(...)`) that a direct
 * string scan of the page would miss because the string lives in the helper.
 */
export const FORBIDDEN_RENDERED_HELPERS = [
  {
    id: "browser-collector-monorepo-helper",
    class: "developer-only-path",
    // Helper symbols that emit `pnpm --dir packages/polyfill-connectors ...`.
    symbols: [
      "pdppBrowserCollectorEnrollCommand",
      "pdppBrowserCollectorRunCommand",
      "pdppCliMonorepoCommand",
    ],
    rationale:
      "These helpers emit monorepo-only `pnpm --dir packages/...` commands. No rendered owner page may wire them into displayed setup copy.",
  },
];

/**
 * Forbidden-string rules. Each rule:
 *   id        — stable identifier (used in reports and tests).
 *   class     — the acceptance failure class it defends.
 *   tiers     — which surface tiers it applies to.
 *   pattern   — RegExp tested against rendered string/template content
 *               (comments are stripped before matching; see scan.mjs).
 *   rationale — why this is forbidden in owner UI.
 *
 * Patterns are intentionally conservative: they target the literal owner-facing
 * leaks the walkthrough surfaced, not every incidental token. The harness scans
 * rendered content only, so a code comment that mentions "the old monorepo
 * proof command" does not trip a rule.
 */
export const FORBIDDEN_STRING_RULES = [
  {
    id: "monorepo-package-path",
    class: "developer-only-path",
    tiers: ["normal", "advanced"],
    pattern: /packages\/[a-z0-9-]+\//i,
    rationale:
      "Normal owner UI must not reference a monorepo package path (packages/...). Self-host owners on Railway/Docker have no repo checkout.",
  },
  {
    id: "pnpm-dir",
    class: "developer-only-path",
    tiers: ["normal", "advanced"],
    pattern: /pnpm\s+--dir\b/,
    rationale:
      "`pnpm --dir` is a monorepo-checkout command. It cannot run from an owner's shipped install.",
  },
  {
    id: "monorepo-checkout",
    class: "developer-only-path",
    tiers: ["normal", "advanced"],
    pattern: /PDPP monorepo checkout|monorepo checkout/i,
    rationale: "Owner setup must never instruct the owner to obtain a PDPP monorepo checkout.",
  },
  {
    id: "source-tree-node-server",
    class: "developer-only-path",
    tiers: ["normal", "advanced"],
    pattern: /node\s+reference-implementation\/server\//,
    rationale:
      "Running the server from `reference-implementation/server/...` assumes a source checkout, not a shipped deployment.",
  },
  {
    id: "replace-placeholders",
    class: "placeholder-substitution",
    tiers: ["normal"],
    // "replace placeholders" / "replace the placeholder" style copy paired with
    // an internal id token. The UI must pass values through, not ask the owner
    // to hand-substitute internal ids.
    pattern: /replace (?:the )?placeholder/i,
    rationale:
      "Owner UI must supply ids directly. 'Replace placeholders' copy with internal ids forces manual id surgery (the connector_instance_id vs source_instance_id failure).",
  },
  {
    id: "env-var-per-account",
    class: "env-var-jargon",
    tiers: ["normal"],
    pattern: /env var per account|environment variable per account|env-var per account/i,
    rationale:
      "'Env var per account' is deployment jargon. Adding an account must not require editing deployment env vars; say so in owner terms or hide in operator detail.",
  },
  {
    id: "raw-setup-planner-label",
    class: "raw-planner-label",
    tiers: ["normal"],
    // Legacy raw setup-planner labels that pre-date the owner-facing vocabulary.
    // These are the exact strings the prior implementation leaked; the realigned
    // page maps planner state to friendly labels instead (Add now / Add account
    // / Packaged path pending / Deployment needed / Not self-service yet).
    pattern:
      /"Track only"|"Manual setup"|"Ready with provider secret"|"Needs browser proof"|"No setup path yet"|"Ready with provider"/,
    rationale:
      "Raw setup-planner enum labels (Track only, Manual setup, Ready with provider secret, ...) must not render as owner-facing status. They are engine states, not owner language.",
  },
  {
    id: "raw-support-state-token",
    class: "raw-planner-label",
    tiers: ["normal"],
    // A raw ConnectorSetupSupportState / disposition enum value rendered inside
    // a JSX text node (between > and <) or as a quoted owner-facing label.
    // Matching is deliberately scoped to rendered-text contexts in scan.mjs so
    // a `case "proof_gated":` branch or a `disposition === "..."` comparison
    // does not trip it; only the value appearing as displayed text does.
    pattern:
      />\s*(?:proof_gated|needs_deployment_config|local_collector_unproven|provider_auth_proof_gated|browser_bound_runbook|api_network_unsupported|unknown_unsupported)\s*</,
    rationale:
      "Raw support-state / disposition enum values must not appear as rendered owner text. The page maps them to owner-facing labels.",
  },
];

/**
 * Help-link rule: any external provider-credential help link in a normal
 * static-secret setup surface must open in a new tab (target="_blank") and set
 * rel="noreferrer" (or "noopener"). A same-tab help link destroys the owner's
 * in-progress credential form — the exact task-continuity break from the
 * walkthrough.
 */
export const HELP_LINK_RULE = {
  id: "static-secret-help-link-new-tab",
  class: "help-link-same-tab",
  // Files whose external help links must open in a new tab. Scoped to the
  // static-secret credential form, the surface where losing form state hurts.
  files: ["apps/console/src/app/(console)/connect/static-secret/[connectorId]/page.tsx"],
  rationale:
    "Static-secret credential help links must open in a new tab and preserve the form. A same-tab link loses the owner's in-progress credential entry.",
};

/**
 * Transient-notice rule: a static-secret submit flow must give the owner a
 * durable place to land (a connection/run reference, a link to sync progress),
 * not only a one-shot redirect notice that evaporates on the next navigation.
 *
 * The harness asserts the post-submit surface references a durable artifact
 * (connection id and a run/sync link) rather than relying purely on a
 * `?notice=` query flag. This is detectable from source without a browser.
 */
export const POST_SUBMIT_RULE = {
  id: "static-secret-post-submit-durable",
  class: "transient-notice-only",
  file: "apps/console/src/app/(console)/connect/static-secret/[connectorId]/actions.ts",
  // The post-submit surface must reference BOTH a durable connection identity
  // and a way to follow the run, so it is not a pure transient notice.
  requiredSignals: [
    { id: "connection-id-shown", pattern: /draft\.connection_id|draftConnectionId|connectionId\b/ },
    { id: "durable-status-redirect", pattern: /statusHref\(|\/status\/|run_id\b/ },
  ],
  rationale:
    "After submit, the owner must land on a durable connection/run reference (visible setup lifecycle), not only a transient redirect notice.",
};

/**
 * Published-command surface. Every `npx`/`pdpp`/`pdpp-local-collector` command
 * rendered in owner UI must resolve to one of these published packages and one
 * of its declared subcommands. The subcommand sets are derived from the local
 * package sources (see scan.mjs `derivePublishedCommandSurface`) so the harness
 * fails the moment the UI advertises a command the package does not ship.
 *
 * `verificationMode` records how an owner could verify the command from a clean
 * shell; the harness requires every rendered command to carry one.
 */
export const PUBLISHED_PACKAGES = {
  "@pdpp/cli": {
    specifier: "@pdpp/cli",
    binName: "pdpp",
    // Source of truth for the published subcommand set.
    commandDispatchFile: "packages/cli/src/index.js",
    verificationMode: "npx -y @pdpp/cli --help",
  },
  "@pdpp/local-collector": {
    specifier: "@pdpp/local-collector",
    binName: "pdpp-local-collector",
    commandDispatchFile: "packages/local-collector/bin/pdpp-local-collector.ts",
    verificationMode: "npx -y @pdpp/local-collector --help",
  },
};

/**
 * Host-clients whose `mcp add` commands are owner-rendered but are NOT PDPP
 * packages (the owner runs their own installed agent CLI). These are allowed in
 * owner UI as connect instructions and are exempt from PDPP package-freshness
 * checks, but the harness still records them so the report is complete.
 */
export const EXTERNAL_HOST_COMMANDS = [
  { binName: "claude", verificationMode: "owner-installed Claude Code CLI" },
  { binName: "codex", verificationMode: "owner-installed Codex CLI" },
];
