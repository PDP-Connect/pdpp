import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const HERO_FILE = `${HERE}components/overview-hero.tsx`;
const REF_CLIENT_FILE = `${HERE}lib/ref-client.ts`;

const DASHBOARD_PAGE_IS_SYNC = /export default function DashboardPage\(\)/;
const PAGE_HEADER_OUTSIDE_SUSPENSE = /<PageHeader[\s\S]*title="Overview"[\s\S]*\/>/;
const SUMMARY_SUSPENSE = /<Suspense fallback=\{<OverviewHeroPlaceholder \/>\}>[\s\S]*<DatasetSummarySection \/>/;
const ATTENTION_SUSPENSE = /<Suspense fallback=\{<AttentionOverviewPlaceholder \/>\}>[\s\S]*<AttentionSection \/>/;
const RECENT_ACTIVITY_SUSPENSE =
  /<Suspense fallback=\{<RecentActivityPlaceholder \/>\}>[\s\S]*<RecentActivitySection \/>/;
const WEB_PUSH_SUSPENSE = /<Suspense fallback=\{null\}>[\s\S]*<WebPushSettingsSection \/>/;
const OLD_BLOCKING_OVERVIEW_LOAD = /await Promise\.all\(\[\s*loadOverview\(\)/;
const SUMMARY_PLACEHOLDER_COPY = /Summarizing retained records/;
const SUMMARY_ERROR_COPY = /Could not load retained-record summary/;
const REBUILDING_ZERO_GUARD = /summary\.record_count === 0 && projection && !projection\.computed_at && status !== "fresh"/;
const REBUILDING_ZERO_PLACEHOLDER = /return <OverviewHeroPlaceholder \/>;/;
const ZERO_RECORD_FALLBACK_COPY = /0 records|No records yet/;
const DATASET_SUMMARY_INTERFACE = /export interface DatasetSummary \{/;
const RECORD_COUNT_FIELD = /record_count: number;/;
const PROJECTION_FIELD = /projection\?: DatasetSummaryProjectionMetadata;/;
const PROJECTION_STATES = /state\?: "fresh" \| "refreshing" \| "stale" \| "rebuilding" \| "failed";/;
const REBUILD_STATUS = /rebuild_status\?: "idle" \| "running" \| "failed";/;

test("dashboard streams shell/header before summary and secondary reads resolve", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, DASHBOARD_PAGE_IS_SYNC);
  assert.match(src, PAGE_HEADER_OUTSIDE_SUSPENSE);
  assert.match(src, SUMMARY_SUSPENSE);
  assert.match(src, ATTENTION_SUSPENSE);
  assert.match(src, RECENT_ACTIVITY_SUSPENSE);
  assert.match(src, WEB_PUSH_SUSPENSE);
  assert.equal(OLD_BLOCKING_OVERVIEW_LOAD.test(src), false);
});

test("summary loading and error states do not masquerade as zero records", async () => {
  const src = await readFile(HERO_FILE, "utf8");
  const placeholder = src.slice(
    src.indexOf("export function OverviewHeroPlaceholder"),
    src.indexOf("export function OverviewHeroError")
  );
  const errorState = src.slice(src.indexOf("export function OverviewHeroError"), src.indexOf("function EmptyHero"));

  assert.match(placeholder, SUMMARY_PLACEHOLDER_COPY);
  assert.doesNotMatch(placeholder, ZERO_RECORD_FALLBACK_COPY);
  assert.match(errorState, SUMMARY_ERROR_COPY);
  assert.doesNotMatch(errorState, ZERO_RECORD_FALLBACK_COPY);
});

test("rebuilding projection zeros do not render as a true empty dataset", async () => {
  const src = await readFile(HERO_FILE, "utf8");

  assert.match(src, REBUILDING_ZERO_GUARD);
  assert.match(src, REBUILDING_ZERO_PLACEHOLDER);
});

test("dataset summary type accepts projection metadata while preserving existing fields", async () => {
  const src = await readFile(REF_CLIENT_FILE, "utf8");

  assert.match(src, DATASET_SUMMARY_INTERFACE);
  assert.match(src, RECORD_COUNT_FIELD);
  assert.match(src, PROJECTION_FIELD);
  assert.match(src, PROJECTION_STATES);
  assert.match(src, REBUILD_STATUS);
});
