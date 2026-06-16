import type { ConnectorCatalogEntry } from "./connection-catalog.ts";

export interface SourceSetupActionOverride {
  href: string;
  label: string;
}

const ARCHIVE_IMPORT_CONNECTORS = new Set([
  "apple-health",
  "google-takeout",
  "ical",
  "imessage",
  "pocket",
  "twitter-archive",
]);

const STATIC_SECRET_SETUP_CONNECTORS = new Set(["slack"]);

const PROVIDER_SETUP_RUNBOOKS: Readonly<Record<string, string>> = {
  spotify: "https://developer.spotify.com/documentation/web-api",
  strava: "https://developers.strava.com/docs/authentication/",
};

export function sourceSetupActionOverride(entry: ConnectorCatalogEntry): SourceSetupActionOverride | null {
  if (ARCHIVE_IMPORT_CONNECTORS.has(entry.connectorKey)) {
    return {
      href: `/dashboard/connect/manual-upload/${encodeURIComponent(entry.connectorKey)}`,
      label: "Import an export",
    };
  }

  if (STATIC_SECRET_SETUP_CONNECTORS.has(entry.connectorKey)) {
    return {
      href: `/dashboard/connect/static-secret/${encodeURIComponent(entry.connectorKey)}`,
      label: "Set up source",
    };
  }

  const runbookPath = entry.runbookPath ?? PROVIDER_SETUP_RUNBOOKS[entry.connectorKey];
  if (runbookPath && (entry.disposition === "api_network_unsupported" || entry.disposition === "unknown_unsupported")) {
    return { href: runbookPath, label: "Set up source" };
  }

  return null;
}
