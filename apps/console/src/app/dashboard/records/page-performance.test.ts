import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const IMPORTS_SUSPENSE = /import \{ Suspense \} from "react"/;
const USES_CHURN_SUSPENSE_SLOT = /versionChurnSlot=\{\s*<Suspense fallback=\{<VersionChurnFallback \/>}/;
const DEFINES_CHURN_SECTION = /async function VersionChurnSection\(\)/;
const LISTS_CONNECTOR_SUMMARIES = /listConnectorSummaries\(\)/;
const LISTS_VERSION_STATS = /listRecordVersionStats\(/;
const LISTS_DEVICE_EXPORTERS = /listDeviceExporterSourceInstances\(/;
// A waterfall is `await listConnectorSummaries()` followed later by
// `await listDeviceExporterSourceInstances()`; the parallel shape awaits the
// device-exporter request only via a pre-started promise variable.
const AWAITS_DEVICE_EXPORTERS_DIRECTLY = /await\s+listDeviceExporterSourceInstances\(/;

test("records page streams version-churn diagnostics instead of blocking the connection list", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IMPORTS_SUSPENSE);
  assert.match(src, USES_CHURN_SUSPENSE_SLOT);
  assert.match(src, DEFINES_CHURN_SECTION);

  const pageBody = src.slice(
    src.indexOf("export default async function RecordsIndexPage"),
    src.indexOf("async function VersionChurnSection")
  );
  assert.match(pageBody, LISTS_CONNECTOR_SUMMARIES);
  assert.doesNotMatch(pageBody, LISTS_VERSION_STATS);
});

test("records page races device-exporter diagnostics with the connector list instead of awaiting them in series", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const pageBody = src.slice(
    src.indexOf("export default async function RecordsIndexPage"),
    src.indexOf("async function VersionChurnSection")
  );
  // The advisory device-exporter request must still be issued from the page.
  assert.match(pageBody, LISTS_DEVICE_EXPORTERS);
  // It must be started before the load-bearing connector-summaries await so the
  // two reads overlap; a sequential `await listConnectorSummaries(); ...;
  // await listDeviceExporterSourceInstances()` waterfall is a regression.
  const deviceExporterStart = pageBody.indexOf("listDeviceExporterSourceInstances(");
  const summariesAwait = pageBody.indexOf("await liveDashboardDataSource.listConnectorSummaries()");
  assert.ok(deviceExporterStart >= 0 && summariesAwait >= 0);
  assert.ok(
    deviceExporterStart < summariesAwait,
    "device-exporter diagnostics must be started before the connector-summaries await so they race"
  );
  // The device-exporter promise must never be awaited inline (which would
  // re-serialize it); it is consumed via the pre-started promise variable.
  assert.doesNotMatch(pageBody, AWAITS_DEVICE_EXPORTERS_DIRECTLY);
});
