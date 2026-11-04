// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The logic behind /apps ("Is your app on PDPP?").
//
// Read-only view over three lists PDPP already publishes: the signed connector
// catalogue (committed as a snapshot), the Supporters register and the
// conformance register. Nothing here collects data or sends it anywhere.
//
// WORDING RULE: a connector is something the PDPP community built. It says
// nothing about the company. A company's own status comes only from the
// Supporters and conformance registers, and the first line of a row never says
// the company is on PDPP, supports it, or takes part.

import type { PublicSupporter } from "./public-supporters.ts";

export type ConnectorTier = "supported" | "preview" | "development";

/** The committed catalogue snapshot (src/data/connector-catalog.json). */
export interface ConnectorSnapshot {
  connectors: readonly { display_name: string; key: string; labels: readonly string[]; tier: ConnectorTier }[];
  generated_at: string;
  layer_digest: string;
  manifest_digest: string;
  source: string;
  source_commit: string;
}

/** One row of the conformance register (public/register/index.json). */
export interface RegisterEntry {
  organisation: string;
  role: string;
  since: string;
  specVersion: string;
  state: string;
  status: string;
}

export const TIER_LABELS: Record<ConnectorTier, string> = {
  development: "In development",
  preview: "Preview",
  supported: "Supported",
};

const MAX_LABELS = 4;
const ENDED_STATE = /lapsed|withdrawn|revoked|expired/i;
const TRAILING_PARENTHETICAL = /\s*\(([^)]*)\)\s*$/;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** "2026-09-05" or "2026-11-04T02:08:53Z" to "5 Sep 2026" (UTC, no locale). */
export function formatDate(value: string): string {
  const match = ISO_DATE.exec(value);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!(match && month)) {
    return value;
  }
  return `${Number(match[3])} ${month} ${match[1]}`;
}

function normalise(name: string): string {
  return name.toLocaleLowerCase("en").replace(NON_ALPHANUMERIC, " ").trim();
}

/** "Oura (Browser Sign-In)" to "Oura". The row title keeps the full name. */
export function appName(displayName: string): string {
  return displayName.replace(TRAILING_PARENTHETICAL, "").trim() || displayName;
}

// Names a company could be listed under for this connector: the app name, and
// the bracketed part ("Claude (Anthropic)" is Anthropic's). Matching is by
// whole name, never substring, so "Meta" is not "Metaculus".
function companyNames(displayName: string): string[] {
  const names = [normalise(appName(displayName))];
  const bracketed = TRAILING_PARENTHETICAL.exec(displayName)?.[1];
  if (bracketed) {
    names.push(normalise(bracketed));
  }
  return names;
}

/** What the registers say about one company. */
export interface CompanyStatus {
  /** Registered or Verified statuses on the conformance register that have not ended. */
  registrations: readonly { since: string; status: string }[];
  /** Date the company signed the Principles, when it did. */
  signedOn: string | null;
}

export interface DirectoryEntry {
  /** What a person can do with this app's data. Empty for a company with no connector. */
  headline: string;
  id: string;
  kind: "connector" | "company";
  labels: string;
  /** Lower-cased names a search can match: the app and the company. */
  matchNames: readonly string[];
  name: string;
  /** Muted line: the company's own status. */
  status: string;
  tier: ConnectorTier | null;
  tierLabel: string | null;
}

export interface Directory {
  catalogueUpdated: string;
  entries: readonly DirectoryEntry[];
}

function isOrganisation(supporter: PublicSupporter): boolean {
  return supporter.type.trim().toLowerCase() !== "individual";
}

function holdsVerified(status: CompanyStatus): boolean {
  return status.registrations.some((registration) => registration.status.startsWith("Verified"));
}

/** The muted status line. Pure wording, tested for every combination. */
export function statusLine(name: string, status: CompanyStatus): string {
  const registered = status.registrations.map((registration) => `a ${registration.status}`);
  const partner = holdsVerified(status) ? " It is a PDPP Partner." : "";
  if (status.signedOn && registered.length > 0) {
    return `${name} signed the PDPP Principles on ${formatDate(status.signedOn)} and is ${joinList(registered)}.${partner}`;
  }
  if (status.signedOn) {
    return `${name} signed the PDPP Principles on ${formatDate(status.signedOn)}. It has not registered with PDPP.`;
  }
  if (registered.length > 0) {
    return `${name} has not signed the Principles. It is ${joinList(registered)}.${partner}`;
  }
  return `${name} has not signed the Principles or registered with PDPP.`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 2) {
    return items.join(" and ");
  }
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "A, B, C, D + 3 more" */
export function labelsLine(labels: readonly string[]): string {
  if (labels.length <= MAX_LABELS) {
    return labels.join(", ");
  }
  return `${labels.slice(0, MAX_LABELS).join(", ")} + ${labels.length - MAX_LABELS} more`;
}

function connectorHeadline(name: string, tier: ConnectorTier): string {
  // A connector in development may not run yet, so it is not promised as
  // something a person can do today.
  if (tier === "development") {
    return `A connector for ${name} built by the PDPP community is in development.`;
  }
  return `You can bring your ${name} data into PDPP today, with a connector built by the PDPP community.`;
}

interface Company {
  name: string;
  registrations: { since: string; status: string }[];
  signedOn: string | null;
}

function collectCompanies(
  supporters: readonly PublicSupporter[],
  register: readonly RegisterEntry[]
): Map<string, Company> {
  const companies = new Map<string, Company>();
  const ensure = (name: string): Company => {
    const key = normalise(name);
    const existing = companies.get(key);
    if (existing) {
      return existing;
    }
    const created: Company = { name, registrations: [], signedOn: null };
    companies.set(key, created);
    return created;
  };
  for (const supporter of supporters) {
    // Individuals are people, not apps. They never reach this page.
    if (isOrganisation(supporter)) {
      const company = ensure(supporter.publicName);
      if (!company.signedOn || supporter.signedOn < company.signedOn) {
        company.signedOn = supporter.signedOn;
      }
    }
  }
  for (const entry of register) {
    if (!ENDED_STATE.test(entry.state)) {
      ensure(entry.organisation).registrations.push({ since: entry.since, status: entry.status });
    }
  }
  return companies;
}

/** Joins the three lists into the rows the page shows. */
export function buildDirectory({
  register,
  snapshot,
  supporters,
}: {
  register: readonly RegisterEntry[];
  snapshot: ConnectorSnapshot;
  supporters: readonly PublicSupporter[];
}): Directory {
  const companies = collectCompanies(supporters, register);
  const linked = new Set<string>();
  const entries: DirectoryEntry[] = [];

  for (const connector of snapshot.connectors) {
    const name = appName(connector.display_name);
    const match = companyNames(connector.display_name).find((candidate) => companies.has(candidate));
    const company = match ? companies.get(match) : undefined;
    if (match) {
      linked.add(match);
    }
    entries.push({
      headline: connectorHeadline(name, connector.tier),
      id: `connector:${connector.key}`,
      kind: "connector",
      labels: labelsLine(connector.labels),
      matchNames: [connector.display_name, company?.name].filter((n): n is string => Boolean(n)).map(lower),
      name: connector.display_name,
      status: statusLine(name, company ?? { registrations: [], signedOn: null }),
      tier: connector.tier,
      tierLabel: TIER_LABELS[connector.tier],
    });
  }

  const companyEntries: DirectoryEntry[] = [];
  for (const [key, company] of companies) {
    if (!linked.has(key)) {
      companyEntries.push({
        headline: `There is no PDPP connector for ${company.name} yet.`,
        id: `company:${key}`,
        kind: "company",
        labels: "",
        matchNames: [lower(company.name)],
        name: company.name,
        status: statusLine(company.name, company),
        tier: null,
        tierLabel: null,
      });
    }
  }
  companyEntries.sort((a, b) => a.name.localeCompare(b.name, "en"));

  return { catalogueUpdated: formatDate(snapshot.generated_at), entries: [...entries, ...companyEntries] };
}

function lower(value: string): string {
  return value.toLocaleLowerCase("en");
}

/**
 * Case-insensitive substring match on the app name and the company name.
 * With no query, every connector is shown; a company with no connector shows
 * only when the search matches it.
 */
export function searchDirectory(entries: readonly DirectoryEntry[], query: string): DirectoryEntry[] {
  const needle = lower(query.trim());
  if (!needle) {
    return entries.filter((entry) => entry.kind === "connector");
  }
  return entries.filter((entry) => entry.matchNames.some((name) => name.includes(needle)));
}
