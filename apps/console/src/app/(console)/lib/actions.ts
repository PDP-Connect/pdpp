/**
 * Dashboard command registry — re-exported from the shared source of truth in
 * `@pdpp/operator-ui` so the console and the public sandbox share ONE registry
 * (and one palette). This file preserves the console's historical import path
 * (`../lib/actions.ts`) for pages and tests.
 */

// biome-ignore lint/performance/noBarrelFile: thin re-export of the shared command registry in @pdpp/operator-ui; preserves the console's historical import path (`../lib/actions.ts`) for the many pages and tests that import these by name.
export {
  type DashboardCommand,
  type DashboardMode,
  listDashboardCommands,
  matchDashboardCommands,
} from "@pdpp/operator-ui/components/command-registry";
